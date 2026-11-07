"""Bounded loopback OIP MCP client. JSON/SSE responses; no hardware or implicit Run.

call() returns decoded text. rpc() keeps image blocks for explicit file export.
Evidence paths are optional; raw image data is never printed by this module.
"""
from __future__ import annotations
import argparse
import json
import ntpath
import os
import urllib.request
from pathlib import Path


def project_path(value):
    """Canonical comparison key for the main-process list_projects path field."""
    if not isinstance(value,str) or not value.strip() or '\0' in value:
        raise ValueError('OIP project path is missing')
    if ntpath.splitdrive(value)[0]:
        if not ntpath.isabs(value):raise ValueError('OIP project path must be absolute')
        return ntpath.normcase(ntpath.normpath(value))
    if not os.path.isabs(value):raise ValueError('OIP project path must be absolute')
    return os.path.normcase(os.path.realpath(value))


def require_open_project(listing,expected):
    """Main owns currentRoot; a matching display name alone is insufficient."""
    wanted=project_path(str(expected))
    if not isinstance(listing,dict) or not isinstance(listing.get('projects'),list):
        raise ValueError('OIP did not provide its open project directory')
    opened=[item for item in listing['projects'] if isinstance(item,dict) and item.get('open') is True]
    if len(opened)!=1 or project_path(opened[0].get('path'))!=wanted:
        raise ValueError('OIP open project directory differs from this project; commands remain disarmed')
    return opened[0]['path']


def _decode_response(body: str, content_type: str, request_id: int = 1) -> dict:
    if "text/event-stream" not in content_type and not body.lstrip().startswith(("data:", "event:", ":")):
        response = json.loads(body)
    else:
        response = None
        data_lines = []
        # One complete JSON-RPC response may follow notifications/keepalives.
        for line in body.replace("\r\n", "\n").split("\n") + [""]:
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
            elif line == "" and data_lines:
                payload = "\n".join(data_lines)
                data_lines = []
                if payload == "[DONE]":
                    continue
                event = json.loads(payload)
                if isinstance(event, dict) and event.get("id") == request_id:
                    response = event
                    break
        if response is None:
            raise RuntimeError("OIP SSE stream contained no matching JSON-RPC response")
    if not isinstance(response, dict) or response.get("id") != request_id:
        raise RuntimeError("OIP returned an unexpected JSON-RPC response identity")
    return response


def rpc(method: str, params: dict | None = None, *, port: int = 15190,
        timeout: float = 15, evidence: str | Path | None = None) -> dict:
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("MCP port must be 1..65535")
    request = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/mcp", json.dumps(request).encode(),
        {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        content_type = response.headers.get("Content-Type", "")
        limit = 16 * 1024 * 1024
        if "text/event-stream" in content_type:
            # Streamable HTTP may keep the connection open after the response;
            # stop on the matching event instead of waiting for end of stream.
            total = 0
            event = []
            raw = None
            while True:
                line = response.readline(limit + 1)
                total += len(line)
                if total > limit:
                    raise RuntimeError("OIP MCP response exceeded 16 MiB")
                if not line:
                    break
                text = line.decode("utf-8").rstrip("\r\n")
                if text:
                    event.append(text)
                    continue
                if not event:
                    continue
                block = "\n".join(event) + "\n\n"
                event = []
                try:
                    raw = _decode_response(block, content_type)
                    break
                except RuntimeError as exc:
                    if "no matching JSON-RPC response" not in str(exc):
                        raise
            if raw is None:
                raise RuntimeError("OIP SSE stream ended without a response")
        else:
            body = response.read(limit + 1)
            if len(body) > limit:
                raise RuntimeError("OIP MCP response exceeded 16 MiB")
            raw = _decode_response(body.decode("utf-8"), content_type)
    if evidence:
        target = Path(evidence)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({"request": request, "response": raw}, ensure_ascii=False, indent=2), encoding="utf-8")
    if raw.get("error") or raw.get("result", {}).get("isError"):
        raise RuntimeError(json.dumps(raw.get("error") or raw["result"], ensure_ascii=False))
    return raw


def initialize(**kwargs) -> dict:
    return rpc("initialize", {
        "protocolVersion": "2025-11-25", "capabilities": {},
        "clientInfo": {"name": "PLCdev-OIP-Batch", "version": "1.0"},
    }, **kwargs)["result"]


def call(name: str, arguments: dict | None = None, **kwargs):
    raw = rpc("tools/call", {"name": name, "arguments": arguments or {}}, **kwargs)
    texts = [item["text"] for item in raw["result"].get("content", []) if item.get("type") == "text"]
    text = "\n".join(texts)
    if not text:
        return {"imageCount": sum(item.get("type") == "image" for item in raw["result"].get("content", []))}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name")
    parser.add_argument("arguments", nargs="?", default="{}")
    parser.add_argument("--port", type=int, default=15190)
    parser.add_argument("--evidence")
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    opts = {"port": args.port, "timeout": args.timeout, "evidence": args.evidence}
    result = initialize(**opts) if args.name == "initialize" else call(args.name, json.loads(args.arguments), **opts)
    print(json.dumps(result, ensure_ascii=False, indent=2))
