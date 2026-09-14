# Releasing Alpha

This covers signing, building, publishing, auto-updates and the pilot rollout. It's written for the people who maintain the app and the gateway. The user-facing guide is [user-guide.md](user-guide.md).

```
git tag v0.2.0 ──▶ release workflow ──────────────────────────────▶ draft GitHub release
                   preflight: tag = app version, secrets present      installers, updater packages,
                   bundle ×3: build, sign, notarize, verify           *.sig, SHA256SUMS
                                                                          │
                                   gateway host: publish_release.py ◀─────┘
                                   stage   → /app/updates/0.2.0/      (nothing offered yet)
                                   promote → /app/updates/latest.json (apps update within an hour)
                                             /app/download/           (new installs)
```

The app checks `https://<gateway>/app/updates/latest.json` at startup and every hour. It downloads the package in the background, verifies it against the updater public key compiled into the build, and installs it when the user clicks **Restart to update**. It only downloads from the gateway host.

## One-time setup

All settings are GitHub repository **secrets** (encrypted) or **variables** (Settings → Secrets and variables → Actions). The release workflow's first job checks that they are set and names any that are missing.

| Name | Kind | What |
|---|---|---|
| `ALPHA_GATEWAY_URL` | variable | `https://<gateway host>`. Compiled into the app; must be HTTPS. |
| `ALPHA_UPDATER_PUBKEY` | variable | Contents of the updater public key (`.pub`) |
| `TAURI_SIGNING_PRIVATE_KEY` | secret | Contents of the updater private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | Its password |
| `APPLE_CERTIFICATE` | secret | Developer ID Application certificate, `.p12`, base64 |
| `APPLE_CERTIFICATE_PASSWORD` | secret | The `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | variable | e.g. `Developer ID Application: Example Org (ABCDE12345)` |
| `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_PRIVATE_KEY` | secrets | Notarization with an App Store Connect API key (issuer ID, key ID, `.p8` contents), **or** |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | secrets | notarization with an Apple ID and app-specific password |
| `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` | secrets | Azure Trusted Signing service principal |
| `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` | variables | e.g. `https://eus.codesigning.azure.net`, account name, certificate profile name |
| `ALPHA_ALLOW_UNSIGNED_WINDOWS` | variable | `true` to release with unsigned Windows installers (pilot only, when none of the `AZURE_*` values are set) |

### Updater keypair

Generate it once, on a trusted machine:

```sh
npx tauri signer generate -w ~/.tauri/alpha-updater.key   # asks for a password
```

- Put the contents of `alpha-updater.key` in `TAURI_SIGNING_PRIVATE_KEY`, the password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the contents of `alpha-updater.key.pub` in `ALPHA_UPDATER_PUBKEY`.
- **Back up the private key and its password offline, in two separate places** (for example the org password vault, and an encrypted USB drive in a safe). Every installed app trusts only this key. If it's lost, no installed copy can be updated again, and every user must reinstall by hand.
- Then delete the key from the machine you generated it on.

Replacing the key needs a transition release: build one version with the **new** public key, and sign it with the **old** private key. Once everyone has updated to it, sign later releases with the new key.

### macOS: Developer ID and notarization

Without notarization, Gatekeeper refuses to open the app, so the workflow has no unsigned option for macOS.

1. In the org's Apple Developer Program account, an Account Holder or Admin creates a **Developer ID Application** certificate (Certificates, IDs & Profiles → Certificates → +).
2. Install it in Keychain Access on a Mac. Export it with its private key as `.p12` with a password, then:
   ```sh
   base64 -i DeveloperID.p12 | pbcopy   # paste into APPLE_CERTIFICATE
   security find-identity -v -p codesigning   # the quoted name is APPLE_SIGNING_IDENTITY
   ```
3. Notarization credentials. Prefer an **App Store Connect API key**, since it isn't tied to one person's Apple ID: App Store Connect → Users and Access → Integrations → Team Keys → +, with the *Developer* role. Set `APPLE_API_ISSUER` (issuer ID), `APPLE_API_KEY` (key ID) and `APPLE_API_PRIVATE_KEY` (contents of the downloaded `AuthKey_<id>.p8`, which can only be downloaded once).
   The alternative is an Apple ID with an app-specific password (appleid.apple.com → Sign-In and Security → App-Specific Passwords): set `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID`.

The first notarization of a new app can take hours. Later ones usually take minutes.

### Windows: Azure Trusted Signing

1. In Azure, create a **Trusted Signing account** and complete identity validation for the organization. Then create a **Public Trust** certificate profile.
2. Create an app registration (service principal) with a client secret. Give it the **Trusted Signing Certificate Profile Signer** role on the account.
3. Set the `AZURE_*` secrets and variables above. The workflow installs `trusted-signing-cli` and passes it to Tauri as the sign command (see `scripts/release-config.mjs`). Tauri signs the app binary and both installers before creating the updater signatures.

For a pilot before this is ready, set `ALPHA_ALLOW_UNSIGNED_WINDOWS=true`. Users then have to click through SmartScreen (see the user guide).

To use an OV code-signing certificate instead, change the `signCommand` in `scripts/release-config.mjs` to your signing tool. OV keys must be kept on a hardware token or a cloud HSM, so this usually means the vendor's cloud signing CLI.

### Linux

There's nothing to sign for the packages themselves. The draft release includes `SHA256SUMS`, and `publish_release.py` checks every file against it. The updater verifies the AppImage, `.deb` and `.rpm` against the updater key like any other package.

### Gateway

Caddy already serves `gateway/public/app/` as `/app/`. Published releases live in `public/app/updates/` and `public/app/download/`. Both are ignored by git, so they survive `git pull` on the gateway host. They're rebuilt from the GitHub releases if lost.

To see which versions are in use, uncomment the access log in `caddy/Caddyfile`. The app's requests carry `User-Agent: alpha-desktop/<version>`, and Caddy redacts the `Authorization` header.

## Cutting a release

1. **Set the version** on a branch, and merge once CI is green:
   ```sh
   npm run set-version -- 0.2.0     # package.json, package-lock.json, Cargo.toml, Cargo.lock, tauri.conf.json
   git commit -am "Release 0.2.0"
   ```
   Versions are plain `major.minor.patch`. Windows MSI packages don't allow pre-release tags such as `-beta`.
2. **Tag the merged commit:**
   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. **Wait for the `release` workflow.** It fails early if the tag and the version disagree or a secret is missing. Each OS then builds, signs and verifies its bundles: `codesign`, `spctl` (must say *Notarized Developer ID*) and `stapler` on macOS, Authenticode on Windows. The last job creates a **draft** release with these files:
   ```
   Alpha_0.2.0_universal.dmg                                        macOS installer
   Alpha_0.2.0_universal.app.tar.gz(.sig)                           macOS update
   Alpha_0.2.0_x64-setup.exe(.sig)   Alpha_0.2.0_x64_en-US.msi(.sig)   Windows installers, also used as updates
   Alpha_0.2.0_amd64.AppImage(.sig)  Alpha_0.2.0_amd64.deb(.sig)  Alpha-0.2.0-1.x86_64.rpm(.sig)
   SHA256SUMS
   ```
4. **Stage it on the gateway host:**
   ```sh
   cd gateway
   gh release download v0.2.0 -R <owner>/<repo> -D ~/alpha-0.2.0   # or download the files and scp them over
   ./scripts/publish_release.py stage ~/alpha-0.2.0 --notes "Faster startup; long chats no longer stall"
   ```
   The notes appear in the app's update notice, so keep them to one or two short sentences for users. The URLs in the manifest use `GATEWAY_DOMAIN` from `.env`. If that isn't the exact host of `ALPHA_GATEWAY_URL`, pass `--base-url`, because the app refuses packages from any other host.
5. **Test the staged build.** Install it by hand from `https://<gateway>/app/updates/0.2.0/` on one machine per OS, and run the [release checklist](#release-checklist).
6. **Promote it:**
   ```sh
   ./scripts/publish_release.py promote 0.2.0
   ./scripts/publish_release.py status
   ```
   Running apps find it within an hour, and apps that start later find it at startup. `/app/download/` now offers 0.2.0 to new users.
7. **Publish the GitHub draft release**, so the repository shows what was shipped.

### Requiring the new version

`minAppVersion` in `gateway/public/app/config.json` blocks older versions. They show the "no longer supported" screen, which installs the update. Use it only when older apps would break, for example after an incompatible gateway change.

Promote the release **first**, then raise `minAppVersion`. Otherwise the update screen has nothing to install. Apps pick up the change at startup and hourly. An app that is answering at that moment waits for the next hourly check, so a half-written answer isn't cut off.

### A bad release

The updater only moves forward. Apps never install a lower version.

- **Not promoted yet:** don't promote it. Staged releases aren't offered to anyone.
- **Promoted:** release a fix as the next patch version, as quickly as possible. To stop apps that haven't downloaded the bad version yet, and to take it off the download page in the meantime, run `./scripts/publish_release.py promote <previous version> --force`. Apps that already installed it stay on it until the fix is out.

## Testing the updater locally

Before the first real release, test a complete update locally with a throwaway key. Release builds only accept updates over HTTPS, so this test build allows HTTP explicitly.

```sh
npx tauri signer generate --ci -p "" -w /tmp/alpha-test.key
ALPHA_UPDATER_PUBKEY="$(cat /tmp/alpha-test.key.pub)" node scripts/release-config.mjs /tmp/release.json
node -e 'const f="/tmp/release.json",c=require(f);c.plugins.updater.dangerousInsecureTransportProtocol=true;require("fs").writeFileSync(f,JSON.stringify(c))'
export TAURI_SIGNING_PRIVATE_KEY="$(cat /tmp/alpha-test.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" ALPHA_GATEWAY_URL=http://localhost:8000

# 1. The "old" app: build and install it (macOS: copy the .app to /Applications)
npm run tauri -- build --config /tmp/release.json

# 2. The "new" version
npm run set-version -- 0.1.1
npm run tauri -- build --config /tmp/release.json
mkdir -p /tmp/alpha-0.1.1 && cp src-tauri/target/release/bundle/macos/Alpha.app.tar.gz /tmp/alpha-0.1.1/Alpha_0.1.1_universal.app.tar.gz \
  && cp src-tauri/target/release/bundle/macos/Alpha.app.tar.gz.sig /tmp/alpha-0.1.1/Alpha_0.1.1_universal.app.tar.gz.sig
gateway/scripts/publish_release.py stage /tmp/alpha-0.1.1 --base-url http://localhost:8000 --allow-missing
gateway/scripts/publish_release.py promote 0.1.1

# 3. Serve it and open the old app: it offers 0.1.1, restarts into it, and your chats are still there
python3 gateway/mock/mock_vllm.py --port 8000

# Clean up
npm run set-version -- 0.1.0 && rm -rf gateway/public/app/updates gateway/public/app/download
```

On Windows, copy `bundle/nsis/*-setup.exe` and its `.sig`. On Linux, copy the AppImage and its `.sig`. The test build uses the real app identifier, so it shares the keychain entry and chat history with any Alpha installed on that machine.

## Release checklist

For every release, on one machine per OS, with the staged build:

- [ ] **macOS:** the downloaded `.dmg` opens, and Alpha starts without a Gatekeeper warning. `spctl -a -vv /Applications/Alpha.app` says *Notarized Developer ID*.
- [ ] **Windows:** the installer shows the organization as publisher, with no "unknown publisher" warning (unless the pilot is explicitly unsigned). Alpha installs without admin rights.
- [ ] **Linux:** the AppImage runs on Ubuntu 22.04. The `.deb` installs with `apt` and the `.rpm` with `dnf`, and each starts from the app menu.
- [ ] Existing chats, settings and the saved key are still there after installing over the previous version.
- [ ] **Auto-update**, after promoting: a machine on the previous version shows "Alpha x.y.z is ready to install" within an hour (or at startup), and **Restart to update** reopens the new version. Settings → Updates shows the new version and "up to date". Check this on each OS, and on Linux for the AppImage and one package format.
- [ ] Restarting to update while an answer is streaming asks first, and keeps the partial answer.
- [ ] With `minAppVersion` raised above the old version, the old app shows the update screen and updates from it.
- [ ] Off VPN, Settings → Updates shows "Can't reach the model server", and the app otherwise works from its cached config.

## Pilot and rollout

**Pilot group.** Five to ten people who will use Alpha daily. Include each OS: macOS on Apple silicon and Intel if both are in use, Windows 10 and 11, and a Linux desktop. Include at least one person who works remotely over VPN.

**Before inviting them:**

1. The latest release is promoted, and the release checklist passes.
2. Each person has a key with the pilot's limits (`gateway/scripts/create-key.sh <email> <rpm> <tpm> <parallel>`), sent through the password manager.
3. They have the [user guide](user-guide.md), the download link (`https://<gateway>/app/download/`) and a place to report problems. The report should include the app version from Settings → Updates.
4. Message logging is confirmed off on the gateway (`gateway/README.md` → *Check that message content is not being stored*).

**During the pilot (about two weeks):**

- Ship fixes as patch releases through the normal flow. Each one also tests auto-update on real machines. Nobody should have to reinstall by hand. If someone does, treat it as a bug.
- Watch the gateway: LiteLLM usage per key, `429` rate-limit errors (raise limits if normal use hits them), and model server latency.
- With the Caddy access log on, check that pilot users' `alpha-desktop/<version>` moves to each new release.

**Exit criteria for wider rollout** (the Phase 4 exit):

- [ ] Every pilot machine runs the latest release and got it by auto-update
- [ ] Signed installers install without security warnings on all three OSes
- [ ] No open issue that loses data, blocks sign-in, or breaks updates
- [ ] Gateway capacity holds at pilot load, with headroom for the next group

**Wider rollout.** Invite people in batches, for example one team at a time. Create keys per batch, and check gateway load before the next one. There's a single update channel, so every promoted release reaches everyone. Run the release checklist on the staged build first, and promote at a time when you can watch for reports.
