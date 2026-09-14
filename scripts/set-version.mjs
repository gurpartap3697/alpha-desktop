#!/usr/bin/env node
// Set the app version everywhere it is declared: package.json, package-lock.json, src-tauri/Cargo.toml,
// src-tauri/Cargo.lock and src-tauri/tauri.conf.json. `cargo test` fails if they disagree.
//
//   npm run set-version -- 0.2.0
//   npm run set-version -- --check v0.2.0   # exit 1 unless every file already says 0.2.0 (used by the release workflow)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args[0] === "--check";
const version = (check ? args[1] : args[0])?.replace(/^v/, "");

// Numbers only: Windows installers (MSI) reject pre-release versions such as 1.0.0-beta.
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: set-version.mjs [--check] <major.minor.patch>");
  process.exit(2);
}

/** Each entry reads the current version from a file and returns the file with `v` swapped in. */
const files = [
  {
    path: "package.json",
    get: (s) => JSON.parse(s).version,
    set: (s, v) => s.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${v}$2`),
  },
  {
    path: "package-lock.json",
    get: (s) => {
      const lock = JSON.parse(s);
      return lock.version === lock.packages[""].version ? lock.version : `${lock.version} / ${lock.packages[""].version}`;
    },
    set: (s, v) => {
      const lock = JSON.parse(s);
      lock.version = v;
      lock.packages[""].version = v;
      return `${JSON.stringify(lock, null, 2)}\n`;
    },
  },
  {
    path: "src-tauri/tauri.conf.json",
    get: (s) => JSON.parse(s).version,
    set: (s, v) => s.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${v}$2`),
  },
  {
    path: "src-tauri/Cargo.toml",
    get: (s) => s.match(/^\[package\][^[]*?^version\s*=\s*"([^"]*)"/ms)?.[1],
    set: (s, v) => s.replace(/^(\[package\][^[]*?^version\s*=\s*")[^"]*(")/ms, `$1${v}$2`),
  },
  {
    path: "src-tauri/Cargo.lock",
    get: (s) => s.match(/^name = "alpha-desktop"\nversion = "([^"]*)"/m)?.[1],
    set: (s, v) => s.replace(/^(name = "alpha-desktop"\nversion = ")[^"]*(")/m, `$1${v}$2`),
  },
];

let mismatched = 0;
for (const f of files) {
  const path = join(root, f.path);
  const text = readFileSync(path, "utf8");
  const current = f.get(text);
  if (check) {
    if (current !== version) {
      console.error(`${f.path}: version is ${current}, expected ${version}`);
      mismatched++;
    }
    continue;
  }
  const next = f.set(text, version);
  if (f.get(next) !== version) throw new Error(`${f.path}: couldn't set the version`);
  if (next !== text) writeFileSync(path, next);
  console.log(`${f.path}: ${current} → ${version}`);
}

if (check && mismatched) {
  console.error("Run `npm run set-version -- <version>` and commit before tagging.");
  process.exit(1);
}
if (check) console.log(`All files are at ${version}.`);
