# Alpha user guide

Alpha is a desktop app for chatting with the language models our organization runs on its own servers. Your messages go only to those servers, and your chat history stays on your computer.

- [Before you start](#before-you-start)
- [Install](#install)
- [Connect with your key](#connect-with-your-key)
- [Updates](#updates)
- [What is stored where](#what-is-stored-where)
- [Uninstall](#uninstall)
- [Troubleshooting](#troubleshooting)

## Before you start

You need:

- **A computer running** macOS 11 (Big Sur) or later, Windows 10 or 11, or Linux with a recent desktop (Ubuntu 22.04 or later, Fedora 38 or later, or similar).
- **Access to the internal network.** Connect to the VPN when you're not in the office.
- **An API key.** Your administrator creates one for you and sends it through a secure channel, such as a password manager share. The key is personal: don't share it, and don't paste it into chat or email. If you think someone else has seen it, ask your administrator to replace it.
- **The download page link** from your administrator. It ends in `/app/download/`.

## Install

Open the download page and pick the file for your system.

### macOS

1. Download `Alpha_<version>_universal.dmg`. It works on Apple silicon and Intel Macs.
2. Open it and drag **Alpha** into **Applications**.
3. Open Alpha from Applications or Launchpad.

### Windows

1. Download `Alpha_<version>_x64-setup.exe`.
2. Run it. Alpha installs for your user account, so you don't need administrator rights. If your computer doesn't have Microsoft Edge WebView2, the installer downloads it.
3. Open Alpha from the Start menu.

If Windows shows **"Windows protected your PC"**, check with your administrator that the pilot build is unsigned. If it is, click **More info**, then **Run anyway**. Signed builds don't show this warning.

The `.msi` package is meant for IT to deploy centrally. Use the `.exe` unless you've been told otherwise.

### Linux

Choose one:

- **AppImage (recommended).** Download `Alpha_<version>_amd64.AppImage` and make it executable:
  ```sh
  chmod +x Alpha_*_amd64.AppImage
  ./Alpha_*_amd64.AppImage
  ```
  Keep it somewhere permanent, such as `~/Applications`, because Alpha updates the file in place. On Ubuntu 22.04, AppImages need FUSE: `sudo apt install libfuse2`. On Ubuntu 24.04, run `sudo apt install libfuse2t64`.
- **Debian or Ubuntu package:** `sudo apt install ./Alpha_<version>_amd64.deb`
- **Fedora or RHEL package:** `sudo dnf install ./Alpha-<version>-1.x86_64.rpm`

With the `.deb` or `.rpm` package, installing an update asks for your password.

Alpha keeps your key in the system keyring (GNOME Keyring or KWallet). Most desktops have one. Without a keyring, Alpha saves the key in a private file instead and shows a notice about it.

## Connect with your key

1. On first launch, Alpha asks for your API key. Paste it and click **Connect**.
2. Alpha checks the key with the model server, then saves it in your system's keychain. You won't be asked again on this computer.
3. On macOS, you may see *"Alpha wants to use your confidential information stored in 'com.alpha.desktop' in your keychain."* Enter your Mac password and click **Always Allow**.

After that, pick a model at the top of the window and start typing. Some tips:

- **Thinking:** some models can reason before they answer. The **Thinking** switch under the message box turns this on or off. The reasoning is folded away above the answer.
- **Stop, regenerate, edit:** stop an answer with **Esc** or the **Stop** button. Hover over a message to regenerate the last answer, or edit one of your messages and send it again. Editing removes the messages after it.
- **Chats:** the sidebar lists your chats. Search covers titles and message text. Use a chat's **⋯** menu to rename it, export it as Markdown, or delete it.
- **Settings** (gear icon, or ⌘, on macOS / Ctrl+, on Windows and Linux): theme, defaults for new chats, auto-delete of old chats, updates, and the list of keyboard shortcuts.
- **Long chats:** every model has a limit on how much text it can take in. When a chat goes past it, Alpha leaves out the oldest messages and says so above the answer. If a chat covers several topics, start a new one per topic.

## Updates

Alpha updates itself. It checks for a new version when it starts and every hour, and downloads it in the background. When the download is ready, a notice says **Alpha x.y.z is ready to install**:

- **Restart to update** installs it and reopens Alpha. If an answer is still being written, Alpha asks first. The text written so far is kept.
- **Later** hides the notice until Alpha is next opened. You can also install from **Settings → Updates**.

Every update is signed. Alpha installs an update only if the signature checks out, and downloads updates only from our model server.

Sometimes the model server stops supporting an old version. Alpha then shows **This version of Alpha is no longer supported** and downloads the update, and you click **Restart to update**. If that doesn't work, install the new version from the download page, as in [Install](#install). Your chats are kept either way.

## What is stored where

| What | Where | Notes |
|---|---|---|
| Chat history | `history.sqlite3` in Alpha's data folder (below) | Only on this computer. Not synced or backed up by Alpha. |
| Settings | The same file | Theme, defaults for new chats, auto-delete period |
| API key | macOS Keychain, Windows Credential Manager, or Linux keyring, under `com.alpha.desktop` | Without a keyring on Linux: a private file `gateway-key` in the data folder |
| Model list and notices | `app-config.json` in the data folder | A copy of what the server published, so Alpha works when the server can't be reached |
| Window preferences | The app's web view storage | Theme and whether the sidebar is open |

Alpha's data folder:

- **macOS:** `~/Library/Application Support/com.alpha.desktop`
- **Windows:** `%APPDATA%\com.alpha.desktop`
- **Linux:** `~/.local/share/com.alpha.desktop`

**Settings → History** shows the exact path and has a button to open the folder.

**What leaves your computer.** When you send a message, Alpha sends the conversation to our model server over an encrypted connection. The server works out an answer and sends it back. The server records **who** made a request, **which model**, **how many tokens** and **when**, for capacity planning and rate limits. It does **not** store the content of your messages or the answers.

**Protecting your history.** Alpha doesn't encrypt the history file itself. It relies on your computer's disk encryption, so make sure that is on: FileVault on macOS, BitLocker or Device Encryption on Windows, LUKS on Linux. Your IT department usually manages this.

**Deleting chats.**

- Delete a single chat from its **⋯** menu.
- **Settings → History → Delete chats automatically** removes chats that have been inactive for the period you choose. Alpha applies it at startup and every hour.
- **Settings → History → Delete all chats** removes every chat from this computer. Deleted chats are overwritten in the file, not just hidden.
- **Export as Markdown** writes a copy to a location you choose. That copy is yours to look after, and deleting the chat in Alpha doesn't remove it.

## Uninstall

Uninstalling removes the app but **not** your chat history or key. To remove everything:

1. In Alpha, go to **Settings → Account → Sign out and remove key**. Optionally, first use **Settings → History → Delete all chats**.
2. Uninstall the app:
   - **macOS:** drag Alpha from Applications to the Bin.
   - **Windows:** Settings → Apps → Installed apps → Alpha → Uninstall.
   - **Linux:** delete the AppImage, or remove the package with `sudo apt remove alpha` or `sudo dnf remove alpha`. If that name isn't found, look it up with `dpkg -l | grep -i alpha` or `rpm -qa | grep -i alpha`.
3. Delete the data folders:
   - **macOS:** `~/Library/Application Support/com.alpha.desktop`, `~/Library/Caches/com.alpha.desktop` and `~/Library/WebKit/com.alpha.desktop`
   - **Windows:** `%APPDATA%\com.alpha.desktop` and `%LOCALAPPDATA%\com.alpha.desktop`
   - **Linux:** `~/.local/share/com.alpha.desktop` and `~/.cache/com.alpha.desktop`

If you skipped step 1, remove the key by hand. On macOS, open Keychain Access and delete `com.alpha.desktop`. On Windows, open Credential Manager → Windows Credentials and remove the `com.alpha.desktop` entry. On Linux, use Seahorse ("Passwords and Keys") or KWallet Manager.

## Troubleshooting

| You see | What to do |
|---|---|
| **Can't reach the model server. Are you on VPN?** | Connect to the VPN and click **Try again**. If you are connected, the server may be down. Ask your administrator. |
| **The server rejected your key** | The key was mistyped, replaced or revoked. Paste it again, or ask your administrator for a new one. Your chats are kept. |
| **Too many requests** | You've reached your request limit for the moment. Wait for the countdown, then retry. |
| **This model isn't available right now** | That model's server is down or restarting. Pick another model from the notice, or try again later. |
| **This conversation is too long** | Start a new chat, or shorten your message. |
| **The connection dropped before the answer finished** | The partial answer is kept. Click **Regenerate** to try again. |
| **No system keychain was found** (Linux) | Install and unlock GNOME Keyring or KWallet, then sign out and enter your key again. Until then the key is in a private file. |
| macOS keeps asking for keychain access | Click **Always Allow**, not **Allow**. |
| The AppImage doesn't start | Install FUSE (see [Linux](#linux)), and check the file is executable. |
| **This version of Alpha is no longer supported**, and the update doesn't install | Install the new version from the download page. |

**Getting help.** Tell your administrator:

- Your Alpha version, shown in **Settings → Updates**
- Your operating system
- The text of the message, including **Details** if the notice has them

Never send your API key. Don't send chat content unless it's needed to reproduce the problem.
