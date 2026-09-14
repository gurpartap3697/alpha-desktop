#!/usr/bin/env node
// Check the updater signing settings before a release build spends 10 minutes compiling:
// the private key decodes, the password opens it, and it matches the public key the app will trust.
//
//   TAURI_SIGNING_PRIVATE_KEY=... TAURI_SIGNING_PRIVATE_KEY_PASSWORD=... ALPHA_UPDATER_PUBKEY=... \
//     node scripts/check-updater-key.mjs
//
// Keys are base64. Whitespace around or inside them (a line break added when pasting into a
// secret) is ignored here and stripped by the release workflow, since the Tauri CLI rejects it.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const clean = (value) => (value ?? "").replace(/\s+/g, "");
const privateKey = clean(process.env.TAURI_SIGNING_PRIVATE_KEY);
const publicKey = clean(process.env.ALPHA_UPDATER_PUBKEY);
if (!privateKey) fail("TAURI_SIGNING_PRIVATE_KEY is empty");
if (!publicKey) fail("ALPHA_UPDATER_PUBKEY is empty");

/** Node's base64 decoder skips invalid characters, but the Tauri CLI and the app reject them, so check strictly. */
function strictBase64(value, what) {
  const bad = [...value.matchAll(/[^A-Za-z0-9+/=]/g)];
  if (!bad.length && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0) return;
  const found = bad.map((m) => `"${m[0]}" at position ${m.index}`).join(", ");
  const hint = bad.some((m) => m[0] === "%" && m.index === value.length - 1)
    ? " A trailing % is usually zsh's end-of-output marker, copied along with `cat`. Set the value from the file instead, e.g. `gh secret set NAME < file`."
    : "";
  fail(`${what} isn't plain base64${found ? `: unexpected ${found}` : " (misplaced padding or wrong length)"}.${hint}`);
}
strictBase64(privateKey, "TAURI_SIGNING_PRIVATE_KEY");
strictBase64(publicKey, "ALPHA_UPDATER_PUBKEY");

/**
 * A minisign key or signature file, base64-encoded as Tauri stores it: the 8-byte key id of its first data line.
 * `kind` is a word its comment line must contain ("secret", "public", "signature").
 */
function keyId(base64File, what, kind) {
  let text;
  try {
    text = Buffer.from(base64File, "base64").toString("utf8");
  } catch {
    fail(`${what} isn't valid base64`);
  }
  const data = text.split(/\r?\n/).find((line) => line && !line.startsWith("untrusted comment:"));
  const bytes = data ? Buffer.from(data, "base64") : Buffer.alloc(0);
  if (!text.startsWith("untrusted comment:") || bytes.length < 10) {
    fail(`${what} isn't a Tauri updater key. Use the contents of the file from \`tauri signer generate\`, unchanged.`);
  }
  if (!text.split("\n", 1)[0].includes(kind)) {
    fail(`${what} holds the wrong kind of key: expected the ${kind} key, found "${text.split("\n", 1)[0]}"`);
  }
  return bytes.subarray(2, 10).toString("hex");
}

const publicId = keyId(publicKey, "ALPHA_UPDATER_PUBKEY (the .pub file)", "public");
keyId(privateKey, "TAURI_SIGNING_PRIVATE_KEY (the file without .pub)", "secret");

const dir = mkdtempSync(join(tmpdir(), "alpha-key-check-"));
try {
  const file = join(dir, "probe.txt");
  writeFileSync(file, "alpha updater key check\n");
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: privateKey, CI: "true" };
  // Unset and empty mean "no password", as in the release build.
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
  try {
    execFileSync("npx", ["--no-install", "tauri", "signer", "sign", file], { env, stdio: "pipe", shell: process.platform === "win32" });
  } catch (e) {
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    if (/wrong password/i.test(output)) {
      fail("TAURI_SIGNING_PRIVATE_KEY_PASSWORD doesn't open TAURI_SIGNING_PRIVATE_KEY (wrong or missing password)");
    }
    if (/invalid input/i.test(output)) {
      fail("TAURI_SIGNING_PRIVATE_KEY is damaged or incomplete. Set it again from the key file, e.g. `gh secret set TAURI_SIGNING_PRIVATE_KEY < key`.");
    }
    fail(`Signing with TAURI_SIGNING_PRIVATE_KEY failed: ${output.trim().split("\n").pop()}`);
  }
  const signatureId = keyId(clean(readFileSync(`${file}.sig`, "utf8")), "signature", "signature");
  if (signatureId !== publicId) {
    fail(
      "TAURI_SIGNING_PRIVATE_KEY and ALPHA_UPDATER_PUBKEY are from different key pairs. Apps would reject every update. " +
        "Set both from the same `tauri signer generate` run.",
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`Updater key OK (key id ${publicId}).`);
