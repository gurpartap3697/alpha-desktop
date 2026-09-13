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

The mock also serves `gateway/public/app/config.json` at `/app/config.json`, as Caddy does. A bare vLLM server doesn't, so against one the app falls back to built-in defaults (no thinking toggle, context window from vLLM's `max_model_len`).

### UI only, in a browser

```sh
npm run dev   # open http://localhost:1420
```

Outside Tauri, a fake backend (`src/dev/mockBackend.ts`, dev builds only) stands in for the Rust commands. Start states: `?scenario=no_key`, `rejected`, `unreachable`, `update`, `announcement`, `file_storage`. The key `bad` is rejected. The messages `/error 429|401|404|500|context`, `/drop`, `/slow` and `/unreachable` trigger the matching states.

### Where things are stored

- API key: macOS Keychain, Windows Credential Manager or Linux Secret Service (service `com.alph.desktop`). If none is available it goes to a `0600` file `gateway-key` in the app data directory, and the app says so. Unsigned dev builds on macOS may ask for Keychain access after each rebuild.
- Last good app config: `app-config.json` in the app data directory.
- Conversations: not saved yet (Phase 2).

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

## Phase 1 checklist

Run on each OS against the real gateway:

- [ ] First launch shows the key screen; a wrong key says so; a valid key opens the chat
- [ ] Restarting the app doesn't ask for the key again (it's in the OS keychain; on Linux, check with and without a Secret Service running)
- [ ] Revoking the key mid-session returns to the key screen with the "rejected" message; a new key continues the conversation (Retry)
- [ ] Every model from `/v1/models` is listed with its `config.json` name and description; a model missing from the config still works
- [ ] Editing `config.json` (e.g. an `announcement`) shows up on the next launch; with the gateway down, the cached copy is used
- [ ] Setting `minAppVersion` above the app version shows the update screen
- [ ] Streaming, Stop, and the thinking toggle work for each reasoning model; the thinking panel folds away when the answer starts
- [ ] Markdown tables, code (highlighting and Copy), inline and display math render; links open in the system browser
- [ ] Error states: off VPN, rate limited (countdown), model down (offers other models), dropped stream (keeps partial text), conversation longer than the context window (older messages left out, then "too long")

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
