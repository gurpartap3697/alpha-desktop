#!/usr/bin/env python3
"""Phase 0 probe: how does each deployed model stream, and how is reasoning toggled?

For every model it sends a small streaming request per variant and reports which delta
fields carried text (reasoning / reasoning_content / content), whether <think> tags leaked
into content, finish_reason, usage and time to first token. Stdlib only.

Run it twice — against a vLLM instance directly and through the gateway — to confirm
LiteLLM forwards chat_template_kwargs and preserves the reasoning field.

  python3 probe_models.py --base https://llm.example.org --key sk-...           # via gateway
  python3 probe_models.py --base http://vllm-qwen:8000 --key $VLLM_API_KEY      # direct
  python3 probe_models.py --base ... --key ... --models qwen --config ../public/app/config.json

Variants: "default" (no overrides) plus onBody/offBody from --config if the model has them,
otherwise the common chat_template_kwargs.enable_thinking true/false toggle.
Add --insecure only to diagnose TLS problems (it disables certificate checks).
"""
import argparse
import json
import ssl
import sys
import time
import urllib.error
import urllib.request

PROMPT = "What is 17 * 23? Answer with just the number."


def request(base, path, key, body=None, ctx=None, timeout=300):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base.rstrip("/") + path, data=data, method="POST" if data else "GET")
    req.add_header("Authorization", f"Bearer {key}")
    if data:
        req.add_header("Content-Type", "application/json")
    return urllib.request.urlopen(req, timeout=timeout, context=ctx)


def probe(base, key, model, extra, ctx, max_tokens):
    body = {"model": model, "messages": [{"role": "user", "content": PROMPT}], "stream": True,
            "stream_options": {"include_usage": True}, "max_tokens": max_tokens, "temperature": 0}
    body.update(extra)
    res = {"fields": {}, "finish": None, "usage": None, "ttft": None, "error": None, "done": False, "content": ""}
    start = time.monotonic()
    try:
        resp = request(base, "/v1/chat/completions", key, body, ctx)
    except urllib.error.HTTPError as e:
        res["error"] = f"HTTP {e.code}: {e.read().decode(errors='replace')[:300]}"
        return res
    except Exception as e:  # noqa: BLE001 - report anything (TLS, DNS, refused)
        res["error"] = f"{type(e).__name__}: {e}"
        return res
    with resp:
        for raw in resp:
            line = raw.decode(errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                res["done"] = True
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                res["error"] = f"bad chunk: {data[:200]}"
                continue
            if chunk.get("error"):
                res["error"] = json.dumps(chunk["error"])[:300]
            if chunk.get("usage"):
                res["usage"] = chunk["usage"]
            for ch in chunk.get("choices") or []:
                delta = ch.get("delta") or {}
                for k, v in delta.items():
                    if isinstance(v, str) and v and k != "role":
                        if res["ttft"] is None:
                            res["ttft"] = time.monotonic() - start
                        res["fields"][k] = res["fields"].get(k, 0) + len(v)
                        if k == "content":
                            res["content"] += v
                if ch.get("finish_reason"):
                    res["finish"] = ch["finish_reason"]
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", required=True, help="Base URL without /v1")
    ap.add_argument("--key", required=True)
    ap.add_argument("--models", help="Comma-separated model ids (default: all from /v1/models)")
    ap.add_argument("--config", help="Path to app config.json for onBody/offBody variants")
    ap.add_argument("--max-tokens", type=int, default=1024)
    ap.add_argument("--insecure", action="store_true", help="Disable TLS verification (diagnosis only)")
    args = ap.parse_args()

    ctx = None
    if args.insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    try:
        with request(args.base, "/v1/models", args.key, ctx=ctx, timeout=15) as r:
            listed = [m["id"] for m in json.load(r)["data"]]
    except Exception as e:  # noqa: BLE001
        sys.exit(f"GET /v1/models failed: {e}")
    print(f"/v1/models: {listed}\n")

    meta = {}
    if args.config:
        with open(args.config) as f:
            meta = json.load(f).get("models", {})

    models = args.models.split(",") if args.models else listed
    for model in models:
        reasoning = (meta.get(model) or {}).get("reasoning") or {}
        variants = [("default", {})]
        if reasoning.get("onBody") or reasoning.get("offBody"):
            variants += [("config onBody", reasoning.get("onBody") or {}),
                         ("config offBody", reasoning.get("offBody") or {})]
        else:
            variants += [("enable_thinking=true", {"chat_template_kwargs": {"enable_thinking": True}}),
                         ("enable_thinking=false", {"chat_template_kwargs": {"enable_thinking": False}})]

        print(f"== {model}")
        for name, extra in variants:
            r = probe(args.base, args.key, model, extra, ctx, args.max_tokens)
            if r["error"] and not r["fields"]:
                print(f"  {name:24} ERROR {r['error']}")
                continue
            fields = ", ".join(f"{k}={n}ch" for k, n in r["fields"].items()) or "(no text)"
            flags = []
            if "<think>" in r["content"] or "</think>" in r["content"]:
                flags.append("THINK-TAGS-IN-CONTENT (reasoning parser not enabled?)")
            if not r["done"]:
                flags.append("NO [DONE]")
            if r["usage"] is None:
                flags.append("no usage")
            if r["error"]:
                flags.append(f"error: {r['error']}")
            ttft = f"{r['ttft']:.2f}s" if r["ttft"] is not None else "-"
            answer = r["content"].strip().replace("\n", " ")[:40]
            print(f"  {name:24} {fields:45} finish={r['finish']} ttft={ttft} answer={answer!r} {' '.join(flags)}")
        print()


if __name__ == "__main__":
    main()
