#!/usr/bin/env node
// Check the macOS signing certificate before the release build spends 10 minutes compiling. The Tauri
// signer needs APPLE_CERTIFICATE to be a base64-encoded .p12 containing the private key, opened by
// APPLE_CERTIFICATE_PASSWORD, issued by Apple (codesign refuses untrusted, e.g. self-signed, identities),
// and named like "Developer ID Application: Name (TEAMID)" with the team ID as organizational unit.
//
//   APPLE_CERTIFICATE=... APPLE_CERTIFICATE_PASSWORD=... APPLE_SIGNING_IDENTITY=... [DRY_RUN=true] \
//     node scripts/check-apple-certificate.mjs
//
// Needs OpenSSL 3 on PATH (ubuntu-22.04 runners have it).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const env = process.env;
const dryRun = env.DRY_RUN === "true";
// The signer strips whitespace itself, so line-wrapped base64 is fine.
const encoded = (env.APPLE_CERTIFICATE ?? "").replace(/\s+/g, "");
if (!encoded) {
  console.log("APPLE_CERTIFICATE isn't set; the macOS app won't be signed.");
  process.exit(0);
}

const exportHelp =
  "Export the certificate with its private key from Keychain Access (right-click → Export → .p12), then " +
  "`base64 -i cert.p12 | tr -d '\\n' > cert.p12.base64 && gh secret set APPLE_CERTIFICATE < cert.p12.base64`.";

if (encoded.startsWith("-----BEGIN")) {
  fail(`APPLE_CERTIFICATE holds PEM text (-----BEGIN …), but it must be a base64-encoded .p12 file. ${exportHelp}`);
}
const bad = encoded.match(/[^A-Za-z0-9+/=]/);
if (bad || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
  fail(`APPLE_CERTIFICATE isn't base64${bad ? ` (unexpected "${bad[0]}" at position ${bad.index})` : ""}. ${exportHelp}`);
}
const der = Buffer.from(encoded, "base64");
if (der.subarray(0, 10).toString("latin1").startsWith("-----BEGIN")) {
  fail(`APPLE_CERTIFICATE is a base64-encoded PEM file, but it must be a base64-encoded .p12 file. ${exportHelp}`);
}
if (env.APPLE_CERTIFICATE_PASSWORD === undefined || env.APPLE_CERTIFICATE_PASSWORD === "") {
  fail("APPLE_CERTIFICATE_PASSWORD is empty. Keychain Access requires a password when exporting a .p12; set it as this secret.");
}

const dir = mkdtempSync(join(tmpdir(), "alpha-cert-check-"));
try {
  const p12 = join(dir, "cert.p12");
  writeFileSync(p12, der);

  /** `openssl pkcs12` with the password from the environment; retries with -legacy for older .p12 encryption. */
  const pkcs12 = (...args) => {
    const run = (extra) =>
      execFileSync("openssl", ["pkcs12", "-in", p12, "-passin", "env:APPLE_CERTIFICATE_PASSWORD", ...extra, ...args], {
        stdio: "pipe",
        encoding: "utf8",
      });
    try {
      return run([]);
    } catch (first) {
      try {
        return run(["-legacy"]);
      } catch (second) {
        // OpenSSL 3.0 reports a legacy .p12 as "unsupported" first; the -legacy attempt says whether the password is wrong.
        const output = `${first.stderr ?? ""}\n${second.stderr ?? ""}`;
        if (/mac verify|invalid password|bad decrypt/i.test(output)) {
          fail("APPLE_CERTIFICATE_PASSWORD doesn't open APPLE_CERTIFICATE (wrong password)");
        }
        fail(`APPLE_CERTIFICATE isn't a valid .p12 file (${`${first.stderr ?? ""}`.trim().split("\n")[0] || "openssl couldn't read it"}). ${exportHelp}`);
      }
    }
  };

  if (!/PRIVATE KEY/.test(pkcs12("-nocerts", "-nodes"))) {
    fail(`APPLE_CERTIFICATE contains no private key, so it can't sign. ${exportHelp}`);
  }

  const certPem = pkcs12("-nokeys", "-clcerts");
  const certFile = join(dir, "cert.pem");
  writeFileSync(certFile, certPem);
  const x509 = (...args) => execFileSync("openssl", ["x509", "-in", certFile, "-noout", ...args], { stdio: "pipe", encoding: "utf8" });

  /** RFC 2253 name → { CN: [...], OU: [...], O: [...] }, honouring escaped commas. */
  const parseName = (line) => {
    const fields = {};
    for (const part of line.replace(/^\w+=/, "").trim().split(/(?<!\\),/)) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      const key = part.slice(0, i).trim();
      (fields[key] ??= []).push(part.slice(i + 1).replace(/\\(.)/g, "$1"));
    }
    return fields;
  };
  const subject = parseName(x509("-subject", "-nameopt", "RFC2253"));
  const issuer = parseName(x509("-issuer", "-nameopt", "RFC2253"));
  const cn = subject.CN?.[0] ?? "";

  try {
    x509("-checkend", "0");
  } catch {
    fail(`The certificate "${cn}" has expired. Create a new one in the Apple Developer account.`);
  }

  const prefixes = dryRun
    ? ["Developer ID Application:", "Apple Development:", "Apple Distribution:", "Mac Development:", "Mac App Distribution:"]
    : ["Developer ID Application:"];
  if (!prefixes.some((p) => cn.startsWith(p))) {
    fail(
      `The certificate is "${cn}", but ${dryRun ? "the Tauri signer only uses Apple certificates (" + prefixes.join(", ") + ")" : "releases outside the App Store need a \"Developer ID Application\" certificate"}.`,
    );
  }
  if (!subject.OU?.length) {
    fail(`The certificate "${cn}" has no organizational unit (team ID); the Tauri signer can't use it.`);
  }
  if (!(issuer.O ?? []).includes("Apple Inc.")) {
    fail(
      `The certificate "${cn}" isn't issued by Apple (issuer: ${issuer.CN?.[0] ?? "unknown"}). codesign refuses untrusted, ` +
        "e.g. self-signed, certificates. For a dry run, leave APPLE_CERTIFICATE unset to build unsigned, or use an Apple Development certificate.",
    );
  }
  const identity = env.APPLE_SIGNING_IDENTITY?.trim();
  if (identity && !cn.includes(identity)) {
    fail(`APPLE_SIGNING_IDENTITY is "${identity}", but the certificate is "${cn}". Set APPLE_SIGNING_IDENTITY to the certificate name.`);
  }
  console.log(`Signing certificate OK: "${cn}" (team ${subject.OU[0]}).`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
