# Alph Desktop

Desktop chat client for the org's self-hosted models (vLLM behind a LiteLLM gateway). Tauri v2 + React + TypeScript. See [plan.md](plan.md).

```
src/          React UI
src-tauri/    Rust core: gateway client, SSE streaming, commands
gateway/      docker-compose for LiteLLM + Postgres + Caddy, mock vLLM, probe/key scripts
.github/      CI: tests + unsigned builds for macOS, Windows, Linux
```

## Prerequisites

- Node.js LTS
- Rust **1.88+** via [rustup](https://rustup.rs). Homebrew's `rust` is often too old; `rustup update stable` fixes that.
- Platform dependencies from <https://tauri.app/start/prerequisites/>:
  - macOS: Xcode Command Line Tools
  - Windows: MSVC Build Tools and WebView2
  - Linux: `libwebkit2gtk-4.1-dev`, `librsvg2-dev`, `patchelf`

## Develop

```sh
npm install

# Option A: mock server only (any key works)
python3 gateway/mock/mock_vllm.py --port 8000
ALPH_GATEWAY_URL=http://localhost:8000 npm run tauri dev

# Option B: full local gateway (see gateway/README.md), then use a key from create-key.sh
ALPH_GATEWAY_URL=http://localhost:8080 npm run tauri dev
```

`ALPH_GATEWAY_URL` is compiled into the binary, and the app refuses to talk to any other host. When it is unset, the app uses `http://localhost:4000`. After changing it, Cargo rebuilds automatically.

## Test

```sh
cd src-tauri
cargo test                                                                # unit tests
ALPH_TEST_GATEWAY=http://127.0.0.1:8000 ALPH_TEST_MOCK=1 cargo test       # + live tests against the mock
ALPH_TEST_GATEWAY=http://127.0.0.1:8000 ALPH_TEST_MODEL=Qwen/Qwen3-1.7B \
  cargo test live_ -- --nocapture --test-threads=1                        # live tests against a real model
```

## Build

```sh
ALPH_GATEWAY_URL=https://llm.example.org npm run tauri build
```

CI (`.github/workflows/build.yml`) builds unsigned bundles on native runners:

- macOS: universal `.dmg`
- Windows: NSIS `.exe` and `.msi`
- Linux: AppImage, `.deb` and `.rpm`

Set the repository variable `ALPH_GATEWAY_URL` so CI builds point at the real gateway.

## Phase 0 checklist

- [ ] Gateway is running in front of the 3 vLLM instances, and 2–3 test keys exist (`gateway/README.md`)
- [ ] `probe_models.py` has been run directly and through the gateway for each model; reasoning toggle and field confirmed; `config.json` updated
- [ ] Each instance's `--max-model-len` is recorded in `config.json`
- [ ] Spike app on **macOS**: key accepted, each model streams, Stop works, and the thinking toggle works through overrides
- [ ] Same on **Windows**
- [ ] Same on **Linux** (Ubuntu 22.04+)
- [ ] The gateway's TLS certificate is accepted on all 3 OSes with no extra steps. If it comes from an internal CA, confirm the CA is in each OS trust store on managed machines.
- [ ] Off-VPN or gateway down shows `unreachable`; a revoked key shows `unauthorized`
- [ ] CI is green and the build artifacts install on each OS
