"""Loopback-only Modbus guard for editor-owned simulation sessions.

The gate latches shut on a failed exchange. Reconnecting never clears it.
Zero acknowledgements prove delivery only; loss of a peer does not prove that
the peer cleared its last outputs. This is a simulation guard, not safety I/O.
"""
from __future__ import annotations
import socket
import struct
import threading
import time


def receive(peer, count):
    result = bytearray()
    while len(result) < count:
        chunk = peer.recv(count - len(result))
        if not chunk:
            raise ConnectionError('Modbus peer closed')
        result.extend(chunk)
    return bytes(result)


class ModbusGuard:
    def __init__(self, port, *, timeout=0.3):
        self.target_port = port
        self.timeout = timeout
        self.lock = threading.RLock()
        self.halt = threading.Event()
        self.connected = False
        self.last_success = None
        self.requires_rearm = False
        self.armed = False
        self.error = None
        self.last_zero_ack = None
        self.remote_outputs_zero = False
        self.generation = 0
        self.listener = socket.socket()
        self.listener.bind(('127.0.0.1', 0))
        self.port = self.listener.getsockname()[1]
        self.listener.listen(4)
        self.listener.settimeout(0.1)
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def start(self):
        self.thread.start()
        threading.Thread(target=self._probe, daemon=True).start()

    def status(self):
        with self.lock:
            return dict(connected=self.connected, lastSuccessAt=self.last_success,
                        requiresRearm=self.requires_rearm, armed=self.armed,
                        generation=self.generation, error=self.error,
                        lastZeroAckAt=self.last_zero_ack,
                        remoteOutputsKnownZero=self.connected and self.remote_outputs_zero)

    def disarm(self):
        with self.lock:
            self.armed = False
            # STOP disables the native plugin, so explicitly deliver zero while
            # the peer is reachable. An acknowledgement is recorded separately
            # from the native Runtime STOP acknowledgement.
            if self.connected:
                try:
                    self.exchange(b'\x0f\x00\x00\x00\x08\x01\x00')
                except (OSError, RuntimeError):
                    pass

    def arm(self, rearm=False):
        with self.lock:
            if not self.connected:
                raise RuntimeError('Simulation peer is disconnected')
            if self.requires_rearm and not rearm:
                raise RuntimeError('Connection recovered; explicit rearm required')
            self.requires_rearm = False
            self.armed = True

    def _failed(self, exc):
        # Sticky until explicit rearm, including a failure concurrent with STOP.
        with self.lock:
            if self.connected or self.armed:
                self.generation += 1
            self.connected = False
            self.requires_rearm = True
            self.armed = False
            self.error = str(exc)
            self.remote_outputs_zero = False

    def exchange(self, pdu, transaction=0):
        function = pdu[0]
        if function == 2 and len(pdu) == 5:
            first, count = struct.unpack('>HH', pdu[1:])
            if first != 0 or not 1 <= count <= 8:
                raise ValueError('Only the reviewed eight simulation input bits are supported')
        elif function == 15 and len(pdu) == 7:
            first, count, size = struct.unpack('>HHB', pdu[1:6])
            if first != 0 or not 1 <= count <= 8 or size != 1:
                raise ValueError('Only the reviewed eight simulation output bits are supported')
        else:
            raise ValueError('Unsupported simulation Modbus request')
        # Serialize probe and native requests. After a failed request no queued
        # nonzero write can pass before the explicit arm operation.
        with self.lock:
            if function == 15 and not self.armed:
                pdu = pdu[:6] + b'\x00'
            try:
                with socket.create_connection(('127.0.0.1', self.target_port), self.timeout) as peer:
                    peer.settimeout(self.timeout)
                    peer.sendall(struct.pack('>HHHB', transaction, 0, len(pdu) + 1, 1) + pdu)
                    header = receive(peer, 7)
                    tid, protocol, length, unit = struct.unpack('>HHHB', header)
                    if (tid, protocol, unit) != (transaction, 0, 1) or not 2 <= length <= 254:
                        raise RuntimeError('Invalid simulation Modbus response header')
                    reply = receive(peer, length - 1)
                    if ((function == 2 and (len(reply) != 3 or reply[:2] != b'\x02\x01')) or
                            (function == 15 and reply != pdu[:5])):
                        raise RuntimeError('Invalid simulation Modbus response body')
                self.connected = True
                self.last_success = time.time()
                self.error = None
                if function == 15:
                    self.remote_outputs_zero = pdu[-1] == 0
                    if self.remote_outputs_zero:
                        self.last_zero_ack = self.last_success
                return reply
            except (OSError, RuntimeError) as exc:
                self._failed(exc)
                raise

    def probe_once(self):
        with self.lock:
            self.exchange(b'\x02\x00\x00\x00\x08')
            # A stopped native plugin no longer polls or writes. On recovery,
            # clear the peer's retained command while the gate is still shut;
            # this does not re-arm or restart the Runtime.
            if not self.armed and not self.remote_outputs_zero:
                self.exchange(b'\x0f\x00\x00\x00\x08\x01\x00')

    def _probe(self):
        while not self.halt.is_set():
            try:
                self.probe_once()
            except (OSError, RuntimeError):
                pass
            self.halt.wait(0.25)

    def _serve_peer(self, peer):
        try:
            with peer:
                peer.settimeout(1)
                while not self.halt.is_set():
                    header = receive(peer, 7)
                    tid, protocol, length, unit = struct.unpack('>HHHB', header)
                    if protocol != 0 or unit != 1 or not 2 <= length <= 254:
                        raise ValueError('Invalid request header')
                    pdu = receive(peer, length - 1)
                    try:
                        response = self.exchange(pdu, tid)
                    except (OSError, RuntimeError):
                        response = bytes([pdu[0] | 0x80, 0x0B])
                    peer.sendall(struct.pack('>HHHB', tid, 0, len(response) + 1, 1) + response)
        except (OSError, ValueError):
            pass

    def _serve(self):
        while not self.halt.is_set():
            try:
                peer, address = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            if address[0] == '127.0.0.1':
                threading.Thread(target=self._serve_peer, args=(peer,), daemon=True).start()
            else:
                peer.close()

    def close(self):
        self.disarm()
        self.halt.set()
        self.listener.close()
        if self.thread.is_alive():
            self.thread.join(timeout=2)
