#!/usr/bin/env python3
"""Publish a desktop app release on the gateway (stdlib only).

The release workflow (.github/workflows/release.yml) attaches the signed installers, updater packages
(*.sig next to each) and SHA256SUMS to a draft GitHub release. Download them into one folder, then:

  ./scripts/publish_release.py stage ~/alpha-0.2.0 --notes "Faster startup"   # copy to public/app/updates/0.2.0/
  ./scripts/publish_release.py promote 0.2.0                                  # offer it to every installed app
  ./scripts/publish_release.py status

Staging makes the files downloadable at /app/updates/<version>/ without offering the update, so it can
be installed by hand on a test machine first. Promoting writes /app/updates/latest.json, which the
apps check hourly, and points /app/download/ at the new installers. Caddy serves both live.

The URLs in latest.json must be on the same host as the app's ALPHA_GATEWAY_URL, or the app refuses
the update. --base-url defaults to GATEWAY_DOMAIN (and HTTP_PORT/HTTPS_PORT) from ../.env.
"""
import argparse
import hashlib
import html
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

GATEWAY_DIR = Path(__file__).resolve().parent.parent
PUBLIC_APP = GATEWAY_DIR / "public" / "app"
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")

ARCHES = {"x86_64": "x86_64", "amd64": "x86_64", "x64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}
ARCH_RE = re.compile(r"(?<![A-Za-z0-9])(" + "|".join(ARCHES) + r")(?![A-Za-z0-9])")


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def arch_of(name):
    m = ARCH_RE.search(name)
    return ARCHES[m.group(1)] if m else None


def updater_targets(name):
    """Updater platform keys a package serves, most specific first (see tauri-plugin-updater's get_urls)."""
    if name.endswith(".app.tar.gz"):
        arches = ["aarch64", "x86_64"] if "universal" in name else [arch_of(name)]
        return [f"darwin-{a}{suffix}" for a in arches if a for suffix in ("-app", "")]
    if name.endswith("-setup.exe"):
        a = arch_of(name)
        return [f"windows-{a}-nsis", f"windows-{a}"] if a else []
    if name.endswith(".msi"):
        a = arch_of(name)
        return [f"windows-{a}-msi"] if a else []
    if name.endswith(".AppImage"):
        a = arch_of(name)
        return [f"linux-{a}-appimage", f"linux-{a}"] if a else []
    if name.endswith(".deb"):
        a = arch_of(name)
        return [f"linux-{a}-deb"] if a else []
    if name.endswith(".rpm"):
        a = arch_of(name)
        return [f"linux-{a}-rpm"] if a else []
    return []


# What people download from /app/download/, in display order.
INSTALLERS = [
    (".dmg", "macOS", "Apple silicon and Intel"),
    ("-setup.exe", "Windows", "Installer"),
    (".msi", "Windows", "MSI package, for managed deployment"),
    (".AppImage", "Linux", "AppImage, updates itself"),
    (".deb", "Linux", "Debian and Ubuntu package"),
    (".rpm", "Linux", "Fedora and RHEL package"),
]


def default_base_url():
    env = {}
    env_file = GATEWAY_DIR / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    domain = env.get("GATEWAY_DOMAIN")
    if not domain:
        return None
    if "://" not in domain:
        domain = f"https://{domain}"
    scheme = domain.split("://", 1)[0]
    port = env.get("HTTPS_PORT" if scheme == "https" else "HTTP_PORT")
    if port and port != ("443" if scheme == "https" else "80") and not re.search(r":\d+$", domain):
        domain = f"{domain}:{port}"
    return domain.rstrip("/")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def check_sums(src):
    sums = src / "SHA256SUMS"
    if not sums.exists():
        print("  (no SHA256SUMS, skipping checksum verification)")
        return
    for line in sums.read_text().splitlines():
        if not line.strip():
            continue
        digest, name = line.split(maxsplit=1)
        name = name.lstrip("*")
        path = src / name
        if not path.exists():
            fail(f"SHA256SUMS lists {name}, which isn't in {src}")
        if sha256(path) != digest:
            fail(f"checksum mismatch for {name}; download it again")
    print("  checksums match SHA256SUMS")


def write_atomic(path, text):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)


def stage(args):
    version = args.version
    src = Path(args.dir).expanduser().resolve()
    if not src.is_dir():
        fail(f"{src} is not a folder")
    base_url = (args.base_url or default_base_url() or "").rstrip("/")
    if not re.match(r"^https?://[^/]+$", base_url):
        fail("pass --base-url https://<gateway host> (the app's ALPHA_GATEWAY_URL), or set GATEWAY_DOMAIN in .env")
    if base_url.startswith("http://"):
        print("warning: release builds only accept updates over HTTPS", file=sys.stderr)

    files = sorted(p for p in src.iterdir() if p.is_file() and not p.name.startswith("."))
    names = {p.name for p in files}
    if "DRY-RUN" in names:
        fail(f"{src} is a release dry run (ALPHA_RELEASE_DRY_RUN): test credentials, not notarized. Don't publish it.")
    print(f"Checking {src}")
    check_sums(src)

    platforms = {}
    for p in files:
        targets = updater_targets(p.name)
        if not targets:
            continue
        if version not in p.name:
            fail(f"{p.name} doesn't look like version {version}")
        if f"{p.name}.sig" not in names:
            # Installers without a signature are fine for /app/download/, just not for the updater.
            print(f"  {p.name}: no .sig, so installed apps won't update from it")
            continue
        signature = (src / f"{p.name}.sig").read_text().strip()
        for target in targets:
            platforms[target] = {"signature": signature, "url": f"{base_url}/app/updates/{version}/{p.name}"}
    for os_name in ("darwin", "windows", "linux"):
        if not any(t.startswith(os_name) for t in platforms):
            message = f"no signed updater package for {os_name}"
            if not args.allow_missing:
                fail(f"{message} (pass --allow-missing to publish anyway)")
            print(f"  warning: {message}")
    if not platforms:
        fail("no updater packages found")

    notes = args.notes
    if args.notes_file:
        notes = Path(args.notes_file).read_text().strip()
    manifest = {
        "version": version,
        "notes": notes or "",
        "pub_date": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "platforms": dict(sorted(platforms.items())),
    }

    dest = PUBLIC_APP / "updates" / version
    if dest.exists():
        if not args.force:
            fail(f"{dest} already exists (pass --force to replace it)")
        shutil.rmtree(dest)
    tmp = dest.with_name(f".{version}.tmp")
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    for p in files:
        shutil.copy2(p, tmp / p.name)
    (tmp / "latest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    tmp.replace(dest)

    print(f"Staged {version} in {dest}")
    for target, entry in manifest["platforms"].items():
        print(f"  {target:24} {entry['url']}")
    print(f"Installers are downloadable under {base_url}/app/updates/{version}/.")
    print(f"When they've been checked: ./scripts/publish_release.py promote {version}")


def parse_version(v):
    return tuple(int(x) for x in v.split("."))


def current_version():
    latest = PUBLIC_APP / "updates" / "latest.json"
    if not latest.exists():
        return None
    try:
        return json.loads(latest.read_text())["version"]
    except (ValueError, KeyError):
        return None


def download_page(version, files):
    rows = []
    for suffix, os_name, label in INSTALLERS:
        for name in sorted(f for f in files if f.endswith(suffix)):
            href = html.escape(f"../updates/{version}/{name}")
            rows.append(
                f'<tr><td>{os_name}</td><td><a href="{href}">{html.escape(name)}</a></td><td>{html.escape(label)}</td></tr>'
            )
    sums = "SHA256SUMS" in files
    return f"""<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download Alpha {version}</title>
<style>
  body {{ font: 15px/1.5 system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1rem; color: #17282b; background: #eef2f1; }}
  h1 {{ font-size: 1.6rem; margin-bottom: .25rem; }}
  table {{ border-collapse: collapse; width: 100%; margin: 1.5rem 0; }}
  td {{ padding: .5rem .75rem .5rem 0; border-bottom: 1px solid #cfd9d7; vertical-align: top; }}
  a {{ color: #0f6b72; }}
  p.small {{ color: #4d5f62; font-size: 13px; }}
  @media (prefers-color-scheme: dark) {{
    body {{ color: #dfe8e6; background: #0f1a1c; }} td {{ border-color: #2a3a3d; }} a {{ color: #6cc3c9; }} p.small {{ color: #9aaeb0; }}
  }}
</style>
<h1>Alpha {version}</h1>
<p>Desktop chat client for the organization's models. Once installed, Alpha keeps itself up to date.</p>
<table>{''.join(rows)}</table>
<p class="small">You need an API key from your administrator. Chat history stays on your computer.
{'Checksums: <a href="../updates/' + version + '/SHA256SUMS">SHA256SUMS</a>.' if sums else ''}</p>
</html>
"""


def promote(args):
    version = args.version
    staged = PUBLIC_APP / "updates" / version
    manifest_path = staged / "latest.json"
    if not manifest_path.exists():
        fail(f"{version} isn't staged; run: ./scripts/publish_release.py stage <folder> --version {version}")
    current = current_version()
    if current and parse_version(version) <= parse_version(current) and not args.force:
        fail(
            f"{current} is already published. Installed apps only move to a newer version, so publish a fix as a "
            "new version (pass --force to switch anyway, e.g. to point new downloads at an older build)"
        )

    manifest = json.loads(manifest_path.read_text())
    manifest["pub_date"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    write_atomic(PUBLIC_APP / "updates" / "latest.json", json.dumps(manifest, indent=2) + "\n")

    download = PUBLIC_APP / "download"
    download.mkdir(parents=True, exist_ok=True)
    write_atomic(download / "index.html", download_page(version, {p.name for p in staged.iterdir()}))

    print(f"Published {version}" + (f" (was {current})" if current else ""))
    print("Installed apps pick it up within an hour, or at their next start.")
    config = PUBLIC_APP / "config.json"
    try:
        min_version = json.loads(config.read_text()).get("minAppVersion")
    except (OSError, ValueError):
        min_version = None
    print(
        f"minAppVersion in {config} is {min_version}. Raise it only when older versions "
        "must stop working; they then see the update screen."
    )


def status(_args):
    current = current_version()
    print(f"Published: {current or 'nothing'}")
    updates = PUBLIC_APP / "updates"
    staged = sorted(
        (p.name for p in updates.iterdir() if p.is_dir() and VERSION_RE.match(p.name)), key=parse_version
    ) if updates.exists() else []
    print(f"Staged:    {', '.join(staged) or 'nothing'}")


def main():
    global PUBLIC_APP
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("stage", help="copy a release into public/app/updates/<version>/ without offering it")
    p.add_argument("dir", help="folder with the release files from GitHub")
    p.add_argument("--version", help="defaults to the version in the file names")
    p.add_argument("--base-url", help="gateway URL the app is built with (ALPHA_GATEWAY_URL)")
    p.add_argument("--notes", help="release notes shown in the app")
    p.add_argument("--notes-file")
    p.add_argument("--allow-missing", action="store_true", help="publish even if an OS has no updater package")
    p.add_argument("--force", action="store_true", help="replace an already staged version")
    p.set_defaults(func=stage)

    p = sub.add_parser("promote", help="offer a staged version to every installed app")
    p.add_argument("version")
    p.add_argument("--force", action="store_true", help="allow a version that isn't newer than the current one")
    p.set_defaults(func=promote)

    p = sub.add_parser("status", help="show the published and staged versions")
    p.set_defaults(func=status)

    parser.add_argument("--public-dir", type=Path, help=f"folder Caddy serves as /app (default {PUBLIC_APP})")
    args = parser.parse_args()
    if args.public_dir:
        PUBLIC_APP = args.public_dir.resolve()
    if args.command == "stage" and not args.version:
        found = {m.group(1) for p in Path(args.dir).expanduser().glob("*") for m in [re.search(r"(\d+\.\d+\.\d+)", p.name)] if m}
        if len(found) != 1:
            fail(f"pass --version (file names mention {', '.join(sorted(found)) or 'no version'})")
        args.version = found.pop()
    if getattr(args, "version", None) and not VERSION_RE.match(args.version.lstrip("v")):
        fail(f"not a version: {args.version}")
    if getattr(args, "version", None):
        args.version = args.version.lstrip("v")
    args.func(args)


if __name__ == "__main__":
    main()
