#!/usr/bin/env node
// Write the Tauri config merged over tauri.conf.json for release builds (see .github/workflows/release.yml):
// updater packages signed with the updater key and, when configured, Windows code signing.
//
//   ALPHA_UPDATER_PUBKEY=... node scripts/release-config.mjs out.json
//   npm run tauri -- build --config out.json      # also needs TAURI_SIGNING_PRIVATE_KEY
//
// Windows signing (Azure Trusted Signing through trusted-signing-cli) is added when SIGN_WINDOWS=true,
// using AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT and AZURE_SIGNING_PROFILE.

import { writeFileSync } from "node:fs";

const env = process.env;
const out = process.argv[2];
// Base64, so any whitespace (such as a line break pasted into the variable) is safe to drop.
const pubkey = env.ALPHA_UPDATER_PUBKEY?.replace(/\s+/g, "");
if (!out || !pubkey) {
  console.error("usage: ALPHA_UPDATER_PUBKEY=<public key> release-config.mjs <output.json>");
  process.exit(2);
}

const config = {
  bundle: { createUpdaterArtifacts: true },
  plugins: { updater: { pubkey } },
};

if (env.SIGN_WINDOWS === "true") {
  const names = ["AZURE_SIGNING_ENDPOINT", "AZURE_SIGNING_ACCOUNT", "AZURE_SIGNING_PROFILE"];
  const missing = names.filter((n) => !env[n]);
  if (missing.length) {
    console.error(`SIGN_WINDOWS=true but ${missing.join(", ")} not set`);
    process.exit(2);
  }
  // Object form: Tauri splits the string form on spaces, without quoting.
  config.bundle.windows = {
    signCommand: {
      cmd: "trusted-signing-cli",
      args: ["-e", env.AZURE_SIGNING_ENDPOINT, "-a", env.AZURE_SIGNING_ACCOUNT, "-c", env.AZURE_SIGNING_PROFILE, "-d", "Alpha", "%1"],
    },
  };
}

writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Wrote ${out}${config.bundle.windows ? " (with Windows signing)" : ""}`);
