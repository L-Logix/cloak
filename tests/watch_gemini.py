"""Print live Gemini page traffic from Chrome's local DevTools Protocol."""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

try:
    import websocket
except ImportError:  # pragma: no cover - exercised by the CLI error path
    websocket = None

GEMINI_HOST = "gemini.google.com"
GEMINI_PATH_PREFIX = "/_/BardChatUi/data/"


def is_gemini_endpoint(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    return parsed.hostname == GEMINI_HOST and parsed.path.startswith(GEMINI_PATH_PREFIX)


def expand_nested_json(value: Any) -> Any:
    """Decode Gemini's JSON-inside-form-inside-JSON request representation."""
    if isinstance(value, dict):
        return {key: expand_nested_json(child) for key, child in value.items()}
    if isinstance(value, list):
        return [expand_nested_json(child) for child in value]
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith(("{", "[")):
            try:
                return expand_nested_json(json.loads(stripped))
            except json.JSONDecodeError:
                pass
    return value


def readable_request_body(body: str) -> str:
    """Return a pretty representation with Gemini's nested f.req expanded."""
    try:
        parsed = json.loads(body)
        return json.dumps(expand_nested_json(parsed), ensure_ascii=False, indent=2)
    except json.JSONDecodeError:
        form = urllib.parse.parse_qs(body, keep_blank_values=True)
        if form:
            expanded = {
                key: [expand_nested_json(item) for item in values]
                for key, values in form.items()
            }
            return json.dumps(expanded, ensure_ascii=False, indent=2)
        return body


def fetch_targets(port: int) -> list[dict[str, Any]]:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/json/list",
        headers={"Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=2) as response:
        return json.loads(response.read().decode("utf-8"))


def find_gemini_target(port: int) -> dict[str, Any] | None:
    for target in fetch_targets(port):
        if target.get("type") == "page" and target.get("url", "").startswith("https://gemini.google.com/"):
            return target
    return None


class GeminiTrafficWatcher:
    def __init__(self, target: dict[str, Any], max_chars: int = 50000):
        if websocket is None:
            raise RuntimeError("Missing websocket-client. Install it with: python3 -m pip install websocket-client")
        self.target = target
        self.max_chars = max_chars
        self.next_command_id = 0
        self.pending_commands: dict[int, tuple[str, str | None]] = {}
        self.request_urls: dict[str, str] = {}
        self.response_metadata: dict[str, dict[str, Any]] = {}
        self.ws = websocket.create_connection(
            target["webSocketDebuggerUrl"],
            timeout=1,
            suppress_origin=True,
        )

    def command(self, method: str, params: dict[str, Any] | None = None, request_id: str | None = None) -> None:
        self.next_command_id += 1
        command_id = self.next_command_id
        self.pending_commands[command_id] = (method, request_id)
        self.ws.send(json.dumps({"id": command_id, "method": method, "params": params or {}}))

    def start(self) -> None:
        self.command("Network.enable", {
            "maxTotalBufferSize": 100_000_000,
            "maxResourceBufferSize": 10_000_000,
            "maxPostDataSize": 10_000_000,
        })
        self.command("Runtime.enable")
        print(f"Attached to Gemini tab: {self.target.get('url', '')}")
        print("Watching local browser traffic. Press Ctrl+C to stop. Chat text is printed below.\n")
        self.run()

    def run(self) -> None:
        while True:
            try:
                message = json.loads(self.ws.recv())
            except websocket.WebSocketTimeoutException:
                continue
            if "id" in message:
                self.handle_command_result(message)
            else:
                self.handle_event(message.get("method", ""), message.get("params", {}))

    def handle_command_result(self, message: dict[str, Any]) -> None:
        pending = self.pending_commands.pop(message["id"], None)
        if not pending:
            return
        method, request_id = pending
        if "error" in message:
            error = message["error"].get("message", "unknown CDP error")
            if method == "Network.getResponseBody":
                print(f"[Gemini response unavailable] {error}")
            return

        result = message.get("result", {})
        if method == "Network.getRequestPostData" and request_id:
            body = result.get("postData")
            if body is not None:
                print("--- Request body sent to Gemini ---")
                self.print_limited(readable_request_body(body))
                print("--- End request body ---\n")
        elif method == "Network.getResponseBody" and request_id:
            body = result.get("body", "")
            if result.get("base64Encoded"):
                body = base64.b64decode(body).decode("utf-8", errors="replace")
            metadata = self.response_metadata.pop(request_id, {})
            status = metadata.get("status", "?")
            mime_type = metadata.get("mimeType", "unknown content type")
            print(f"--- Gemini server response (HTTP {status}, {mime_type}) ---")
            self.print_limited(body)
            print("--- End Gemini server response ---\n")

    def handle_event(self, method: str, params: dict[str, Any]) -> None:
        if method == "Runtime.consoleAPICalled":
            self.print_promptmask_console(params)
        elif method == "Network.requestWillBeSent":
            request = params.get("request", {})
            url = request.get("url", "")
            if is_gemini_endpoint(url):
                request_id = params.get("requestId", "")
                self.request_urls[request_id] = url
                print(f"[Browser -> Gemini] {request.get('method', 'POST')} {url}")
                if request.get("postData") is not None:
                    print("--- Request body sent to Gemini ---")
                    self.print_limited(readable_request_body(request["postData"]))
                    print("--- End request body ---\n")
                elif request.get("hasPostData"):
                    self.command("Network.getRequestPostData", {"requestId": request_id}, request_id)
        elif method == "Network.responseReceived":
            request_id = params.get("requestId", "")
            if request_id in self.request_urls:
                response = params.get("response", {})
                self.response_metadata[request_id] = {
                    "status": response.get("status", "?"),
                    "mimeType": response.get("mimeType", "unknown content type"),
                }
        elif method == "Network.loadingFinished":
            request_id = params.get("requestId", "")
            if request_id in self.request_urls and request_id in self.response_metadata:
                self.command("Network.getResponseBody", {"requestId": request_id}, request_id)
                self.request_urls.pop(request_id, None)

    def print_promptmask_console(self, params: dict[str, Any]) -> None:
        args = params.get("args", [])
        parts = []
        for argument in args:
            value = argument.get("value")
            if value is None:
                value = argument.get("description", "")
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False)
            parts.append(str(value))
        message = " ".join(parts)
        if "[PromptMask]" in message:
            print(f"[Browser console] {message}\n")

    def print_limited(self, text: str) -> None:
        if len(text) <= self.max_chars:
            print(text)
        else:
            print(text[: self.max_chars])
            print(f"... truncated at {self.max_chars} characters (use --max-chars to increase)")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Watch real Gemini tab requests and responses through Chrome DevTools Protocol."
    )
    parser.add_argument("--port", type=int, default=9222, help="Chrome remote debugging port (default: 9222)")
    parser.add_argument("--wait", type=int, default=120, help="Seconds to wait for a Gemini tab to appear")
    parser.add_argument("--max-chars", type=int, default=50000, help="Maximum printed characters per body")
    args = parser.parse_args()

    if websocket is None:
        print("Missing websocket-client. Install it with: python3 -m pip install websocket-client", file=sys.stderr)
        return 2

    deadline = time.monotonic() + args.wait
    target = None
    while time.monotonic() < deadline:
        try:
            target = find_gemini_target(args.port)
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
            target = None
        if target:
            break
        print("Waiting for Chrome with remote debugging and an open Gemini tab...", end="\r", flush=True)
        time.sleep(1)

    if not target:
        print(
            "\nNo Gemini tab found. Start Chrome with --remote-debugging-port=9222 "
            "and a separate --user-data-dir, then open https://gemini.google.com.",
            file=sys.stderr,
        )
        return 1

    try:
        GeminiTrafficWatcher(target, max_chars=args.max_chars).start()
    except KeyboardInterrupt:
        print("\nStopped watching Gemini traffic.")
    except (OSError, RuntimeError, websocket.WebSocketException) as error:
        print(f"Could not attach to Chrome DevTools: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
