# Alpha Desktop

Desktop chat client for the org's self-hosted models (vLLM behind a LiteLLM gateway). Tauri v2 + React + TypeScript. See [plan.md](plan.md).

```
src/          React UI
src-tauri/    Rust core: gateway client, SSE streaming, chat history (SQLite), updater, commands
gateway/      docker-compose for LiteLLM + Postgres + Caddy, mock vLLM, key and release publishing scripts
scripts/      version bump and release build config
docs/         user guide, release and rollout runbook
.github/      CI: tests + unsigned builds on every push; signed releases from version tags
```

- **Users:** [docs/user-guide.md](docs/user-guide.md): install, getting a key, updates, what data is stored where
- **Maintainers:** [docs/releasing.md](docs/releasing.md): signing setup, cutting and publishing a release, pilot rollout

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
ALPHA_GATEWAY_URL=http://localhost:8000 npm run tauri dev

# Option B: full local gateway (see gateway/README.md), then use a key from create-key.sh
ALPHA_GATEWAY_URL=http://localhost:8080 npm run tauri dev
```

`ALPHA_GATEWAY_URL` is compiled into the binary, and the app refuses to talk to any other host. When it is unset, the app uses `http://localhost:4000`. After changing it, Cargo rebuilds automatically.

The mock also serves `gateway/public/app/config.json` at `/app/config.json`, as Caddy does. A bare vLLM server doesn't, so against one the app falls back to built-in defaults (no thinking toggle, context window from vLLM's `max_model_len`).

### UI only, in a browser

```sh
npm run dev   # open http://localhost:1420
```

Outside Tauri, a fake backend (`src/dev/mockBackend.ts`, dev builds only) stands in for the Rust commands. Start states: `?scenario=no_key`, `rejected`, `unreachable`, `update`, `announcement`, `file_storage`, `history_broken`, and `fresh` (empty history, default settings). For updates: `update` (this version is too old and 0.2.0 is published), `update_unpublished` (too old, nothing published), `update_available` (0.2.0 downloads in the background) and `update_broken` (the download fails). "Restart to update" reloads the page as version 0.2.0. The key `bad` is rejected. The messages `/error 429|401|404|500|context`, `/drop`, `/slow` and `/unreachable` trigger the matching states.

The fake keeps chat history and settings in the browser's `localStorage` with a few sample chats (one of them 45 days old, to try auto-delete), so reloading the page behaves like restarting the app. Reloading while an answer streams shows the "closed before the answer finished" state.

### Where things are stored

- API key: macOS Keychain, Windows Credential Manager or Linux Secret Service (service `com.alpha.desktop`). If none is available it goes to a `0600` file `gateway-key` in the app data directory, and the app says so. Unsigned dev builds on macOS may ask for Keychain access after each rebuild.
- Last good app config: `app-config.json` in the app data directory.
- Chat history: `history.sqlite3` in the app data directory (macOS `~/Library/Application Support/com.alpha.desktop`, Windows `%APPDATA%\com.alpha.desktop`, Linux `~/.local/share/com.alpha.desktop`). Only the Rust core opens it. The webview gets typed commands, not SQL. Answers are written as they stream (about every 0.75 s). Any answer still marked as streaming at startup was cut off by the app closing and is marked as such. Schema migrations are in `src-tauri/src/db.rs`, and the version is tracked with `PRAGMA user_version`. An older app refuses to open history written by a newer one. Deleted chats are overwritten on disk (`secure_delete`), and "Delete all chats" also compacts the file and its WAL.
- Updates: nothing is stored. The update found by the last check and its downloaded package are kept in memory until installed. Release builds check `<gateway>/app/updates/latest.json` at startup and hourly. Development builds and builds without an updater key don't update (Settings → Updates says why).
- Settings (theme, defaults for new chats, auto-delete): the `settings` table of the same database, one row per setting. The theme is also copied to the webview's `localStorage` so the window starts in the right colors. Auto-delete runs when the app starts and hourly while it's open. It goes by each chat's last message, and never deletes a chat that is answering.

## Test

```sh
cd src-tauri
cargo test                                                                # unit tests (SSE parser, trimming, history, settings, …)
ALPHA_TEST_GATEWAY=http://127.0.0.1:8000 ALPHA_TEST_MOCK=1 cargo test       # + live tests against the mock
ALPHA_TEST_GATEWAY=http://127.0.0.1:8000 ALPHA_TEST_MODEL=Qwen/Qwen3-1.7B \
  cargo test live_ -- --nocapture --test-threads=1                        # live tests against a real model
```

UI flows (key screen, chat, sidebar, settings, shortcuts) run in Playwright against the dev server with the fake backend:

```sh
npx playwright install chromium   # once
npm run test:e2e                  # starts Vite on port 1430, so it can run next to `tauri dev`
```

These exercise the React app and its state, not the Rust core or the native webviews. The Rust side is covered by `cargo test`, and the OS-specific parts by the checklists below.

## Keyboard shortcuts

| | macOS | Windows / Linux |
|---|---|---|
| New chat | ⌘N | Ctrl+N |
| Go to the message box | ⌘L | Ctrl+L |
| Search chats | ⌘K | Ctrl+K |
| Settings | ⌘, | Ctrl+, |
| Stop the answer | Esc | Esc |

Esc only stops the answer when it isn't closing something else (a menu, a dialog, an edit, a search).

## Build

```sh
ALPHA_GATEWAY_URL=https://llm.example.org npm run tauri build
```

A local build has no updater key, so it doesn't update itself. CI (`.github/workflows/build.yml`) builds the same unsigned bundles on native runners for every push:

- macOS: universal `.dmg`
- Windows: NSIS `.exe` and `.msi`
- Linux: AppImage, `.deb` and `.rpm`

Set the repository variable `ALPHA_GATEWAY_URL` so CI builds point at the real gateway.

## Release

```sh
npm run set-version -- 0.2.0          # commit, merge, then:
git tag v0.2.0 && git push origin v0.2.0
```

The `release` workflow builds, signs (macOS Developer ID and notarization, Windows Authenticode) and verifies the bundles, adds updater packages signed with the updater key, and attaches everything to a draft GitHub release. On the gateway host, `gateway/scripts/publish_release.py stage` and then `promote` make it the version installed apps update to. Setup, the full procedure and the pilot plan are in [docs/releasing.md](docs/releasing.md).

## Phase 4 checklist

- [ ] Updater keypair generated, stored in repository secrets and backed up offline in two places
- [ ] Apple Developer ID certificate and notarization credentials in secrets; a release build opens on a clean Mac with no Gatekeeper warning
- [ ] Windows signing (Azure Trusted Signing) set up, or `ALPHA_ALLOW_UNSIGNED_WINDOWS` chosen deliberately for the pilot
- [ ] First tagged release: every job green, and the draft release has all files from docs/releasing.md
- [ ] Staged and promoted on the gateway. `/app/download/` lists the installers and `/app/updates/latest.json` has all platforms
- [ ] Auto-update from one release to the next works on macOS, Windows and Linux (AppImage, plus `.deb` or `.rpm`), keeping chats and the key
- [ ] Raising `minAppVersion` shows the update screen, which installs the update
- [ ] User guide shared with the pilot group; install and key steps followed by someone who hasn't seen the app
- [ ] Pilot exit criteria met (docs/releasing.md → Pilot and rollout)

## Phase 3 checklist

Run on each OS:

- [ ] Settings → Appearance: Light and Dark apply at once, including the window's title bar; after a restart the window opens in that theme without a flash; Match system follows an OS theme change
- [ ] Settings → New chats: a default model, thinking, temperature, answer length and system prompt apply to the next new chat (and the empty one on screen), not to existing chats
- [ ] Settings → History: the path is right and "Show in Finder / Explorer / folder" opens it; choosing an auto-delete period that covers old chats asks first and says how many; after restarting, chats past the period are gone
- [ ] Delete all chats (with confirmation) empties the sidebar, stops an answer in progress, and stays empty after a restart
- [ ] Shortcuts from the table above work, including while typing in the message box; Esc in a menu or the rename box doesn't stop an answer
- [ ] Loading: starting with a slow gateway shows placeholders rather than blank panels
- [ ] Settings → Account shows the server and where the key is kept; signing out returns to the key screen and chats are still there after entering a key

## Phase 2 checklist

Run on each OS:

- [ ] Send a few messages, quit the app, reopen it: the chats are in the sidebar and open with their model, system prompt and settings
- [ ] Quit while an answer is streaming: after reopening, the partial answer is kept and marked as interrupted, with Regenerate
- [ ] A new chat gets a short generated title after its first answer. If generation fails (e.g. a model that can't switch thinking off), the start of the first message stays as the title
- [ ] Rename (menu or double-click), delete (with confirmation), and search by title and by message text; search results show the matching text
- [ ] Regenerate the last answer, including with another model from the "model unavailable" notice. Editing an earlier message removes the messages after it
- [ ] Export as Markdown opens a save dialog and writes a readable file (thinking folded in `<details>`)
- [ ] Start an answer, switch to another chat and back: it kept streaming, and the sidebar shows a dot while it runs
- [ ] A long conversation keeps working past the model's context window ("N older messages weren't sent")

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
