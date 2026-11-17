"""Eight-bit loopback Modbus fixture, for the real Runtime master plugin only."""
from __future__ import annotations
import socket
import struct
import threading
import time


class LoopbackServer:
    def __init__(self):
        self.inputs = 0
        self.outputs = 0
        self.events = []
        self.failure = None
        self.halt = threading.Event()
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # Binding fails if Factory I/O or another process already owns this port.
        self.listener.bind(('127.0.0.1', 1503))
        self.listener.listen(1)
        self.listener.settimeout(0.1)
        self.peer = None
        self.thread = threading.Thread(target=self.run, daemon=True)

    def start(self):
        self.thread.start()

    @staticmethod
    def receive(peer, size):
        data = bytearray()
        while len(data) < size:
            chunk = peer.recv(size - len(data))
            if not chunk:
                raise ConnectionError('Peer closed')
            data.extend(chunk)
        return bytes(data)

    def run(self):
        try:
            while not self.halt.is_set():
                try:
                    self.peer, address = self.listener.accept()
                except socket.timeout:
                    continue
                if address[0] != '127.0.0.1':
                    raise RuntimeError('Non-loopback peer refused')
                self.peer.settimeout(1)
                try:
                    while not self.halt.is_set():
                        header = self.receive(self.peer, 7)
                        transaction, protocol, length, unit = struct.unpack('>HHHB', header)
                        if protocol != 0 or unit != 1 or not 2 <= length <= 254:
                            raise RuntimeError('Invalid MBAP header')
                        pdu = self.receive(self.peer, length - 1)
                        function = pdu[0]
                        if function == 2 and len(pdu) == 5 and struct.unpack('>HH', pdu[1:]) == (0, 8):
                            reply = bytes([2, 1, self.inputs])
                        elif function == 15 and len(pdu) == 7 and struct.unpack('>HHB', pdu[1:6]) == (0, 8, 1):
                            self.outputs = pdu[6]
                            reply = pdu[:5]
                        else:
                            raise RuntimeError('Unexpected request outside eight-bit fixture')
                        self.events.append(dict(at=time.monotonic(), fc=function, inputs=self.inputs, outputs=self.outputs))
                        self.peer.sendall(struct.pack('>HHHB', transaction, 0, len(reply) + 1, unit) + reply)
                except (ConnectionError, OSError):
                    pass
                finally:
                    self.peer.close()
                    self.peer = None
        except Exception as exc:
            self.failure = str(exc)

    def close(self):
        self.halt.set()
        if self.peer:
            try:
                self.peer.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.listener.close()
        self.thread.join(timeout=3)
