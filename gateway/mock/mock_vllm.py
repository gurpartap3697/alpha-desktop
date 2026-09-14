#!/usr/bin/env python3
"""Fake vLLM OpenAI-compatible server for local development (stdlib only).

Endpoints: GET /v1/models, POST /v1/chat/completions (streaming and non-streaming), and
GET /app/* (static files from ../public/app, as Caddy serves them in the real gateway: config.json,
and updates/ and download/ once scripts/publish_release.py has published a release). MOCK_PUBLIC_DIR
serves another folder instead, e.g. one passed to publish_release.py --public-dir.

Behaviour:
  - Models: MOCK_MODELS (comma-separated, default "gemma,qwen,nemotron"). Any requested model is served.
  - Reasoning: emitted unless the model name contains "gemma" or the request sets
    chat_template_kwargs.enable_thinking=false. Field name: MOCK_REASONING_FIELD
    ("reasoning" like newer vLLM, or "reasoning_content" like older vLLM).
  - Auth: if MOCK_API_KEY is set, requires "Authorization: Bearer <MOCK_API_KEY>".
  - Context limit: MOCK_MAX_CHARS (default 20000) of total message text -> 400 context error.
  - Error simulation: a user message of "/error 429" (or 401, 404, 500) returns that status;
    "/drop" closes the stream midway without [DONE]; "/slow" streams slowly.

Usage: python3 mock_vllm.py --port 8000
"""
import argparse
import json
import mimetypes
import os
import re
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = [m.strip() for m in os.environ.get("MOCK_MODELS", "gemma,qwen,nemotron").split(",") if m.strip()]
REASONING_FIELD = os.environ.get("MOCK_REASONING_FIELD", "reasoning")
API_KEY = os.environ.get("MOCK_API_KEY", "")
MAX_CHARS = int(os.environ.get("MOCK_MAX_CHARS", "20000"))
PUBLIC_APP = os.path.realpath(
    os.environ.get("MOCK_PUBLIC_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "app")
)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[mock-vllm] {self.address_string()} {fmt % args}")

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message, typ="BadRequestError"):
        self._json(status, {"object": "error", "message": message, "type": typ, "code": status})

    def _authorized(self):
        if not API_KEY:
            return True
        if self.headers.get("Authorization") == f"Bearer {API_KEY}":
            return True
        self._error(401, "Unauthorized", "AuthenticationError")
        return False

    def _static(self, rel):
        path = os.path.realpath(os.path.join(PUBLIC_APP, rel))
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        if not path.startswith(PUBLIC_APP + os.sep) or not os.path.isfile(path):
            return self._error(404, "Not found", "NotFoundError")
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            return self._json(200, {})
        if self.path.startswith("/app/"):
            return self._static(self.path[len("/app/"):].split("?", 1)[0])
        if self.path.rstrip("/") != "/v1/models":
            return self._error(404, "Not found", "NotFoundError")
        if not self._authorized():
            return
        now = int(time.time())
        self._json(200, {
            "object": "list",
            "data": [{"id": m, "object": "model", "created": now, "owned_by": "mock", "max_model_len": 8192}
                     for m in MODELS],
        })

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/chat/completions":
            return self._error(404, "Not found", "NotFoundError")
        if not self._authorized():
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._error(400, "Invalid JSON body")

        model = req.get("model", "")
        messages = req.get("messages") or []
        last_user = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
        if not isinstance(last_user, str):
            last_user = json.dumps(last_user)

        m = re.match(r"^/error (\d{3})", last_user.strip())
        if m:
            status = int(m.group(1))
            if status == 429:
                self.send_response(429)
                body = json.dumps({"error": {"message": "Rate limit exceeded", "code": 429}}).encode()
                self.send_header("Retry-After", "7")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            return self._error(status, f"Simulated error {status}")

        total_chars = sum(len(str(msg.get("content", ""))) for msg in messages)
        if total_chars > MAX_CHARS:
            return self._error(400, f"This model's maximum context length is {MAX_CHARS // 4} tokens. "
                                    f"However, you requested {total_chars // 3} tokens in the messages.")

        kwargs = req.get("chat_template_kwargs") or {}
        thinking = "gemma" not in model.lower() and kwargs.get("enable_thinking", True) is not False
        reasoning = (f"The user said {len(last_user)} characters. Model '{model}', temperature "
                     f"{req.get('temperature')}. I'll echo it back with some markdown.") if thinking else ""
        content = (f"**Mock reply from `{model}`**\n\nYou said:\n\n> {last_user}\n\n"
                   "```python\nprint('hello from the mock')\n```\n\n"
                   "| Model | Reasoning |\n|---|---|\n| qwen | yes |\n| gemma | no |\n\n"
                   "Inline math: $e^{i\\pi}+1=0$, and display math:\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$")
        prompt_tokens = max(1, total_chars // 4)
        completion_tokens = max(1, (len(reasoning) + len(content)) // 4)
        cid = f"chatcmpl-{uuid.uuid4().hex}"
        created = int(time.time())

        if not req.get("stream"):
            msg = {"role": "assistant", "content": content}
            if reasoning:
                msg[REASONING_FIELD] = reasoning
            return self._json(200, {
                "id": cid, "object": "chat.completion", "created": created, "model": model,
                "choices": [{"index": 0, "message": msg, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
                          "total_tokens": prompt_tokens + completion_tokens},
            })

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        delay = 0.25 if last_user.strip().startswith("/slow") else 0.02
        drop = last_user.strip().startswith("/drop")

        def send(delta=None, finish=None, usage=None):
            chunk = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                     "choices": [] if usage else [{"index": 0, "delta": delta or {}, "finish_reason": finish}]}
            if usage:
                chunk["usage"] = usage
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()

        try:
            send({"role": "assistant", "content": ""})
            for piece in re.findall(r"\S+\s*", reasoning):
                send({REASONING_FIELD: piece, "content": None})
                time.sleep(delay)
            pieces = re.findall(r"\S+\s*|\n+", content)
            for i, piece in enumerate(pieces):
                if drop and i == len(pieces) // 2:
                    return  # connection closes without finish_reason or [DONE]
                send({"content": piece})
                time.sleep(delay)
            send({}, finish="stop")
            if (req.get("stream_options") or {}).get("include_usage"):
                send(usage={"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
                            "total_tokens": prompt_tokens + completion_tokens})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            print("[mock-vllm] client disconnected mid-stream")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    print(f"[mock-vllm] listening on http://{args.host}:{args.port} models={MODELS} "
          f"reasoning_field={REASONING_FIELD} auth={'on' if API_KEY else 'off'}")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
