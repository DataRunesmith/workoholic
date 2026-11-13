#!/usr/bin/env node
// Upload secrets for the deployed Worker from a NAME=value file.
//
//   pnpm secrets:push <file>
//
// The values are sent to wrangler on stdin (never on a command line or into a
// log); only the names are printed. Use it for STUDENTCONSULTING_EMAIL,
// STUDENTCONSULTING_PASSWORD, SMTP_PASSWORD and similar. Lines starting with #
// and blank lines are ignored. CLOUDFLARE_API_TOKEN (and optionally
// CLOUDFLARE_ACCOUNT_ID) come from the environment or from setup.env.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const file = process.argv[2];
if (!file) {
  console.error("usage: pnpm secrets:push <file with NAME=value lines>");
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parse(path, namePattern) {
  const values = new Map(); // a Map has no property names to inject into
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(namePattern);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

const setup = existsSync(join(root, "setup.env")) ? parse(join(root, "setup.env"), /^([A-Z][A-Z0-9_]*)=(.*)$/) : new Map();
const pick = (name) => process.env[name] || setup.get(name)?.trim() || "";
const token = pick("CLOUDFLARE_API_TOKEN");
if (!token) {
  console.error("CLOUDFLARE_API_TOKEN is missing (environment or setup.env).");
  process.exit(1);
}

const secrets = parse(file, /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
for (const [name, value] of secrets) secrets.set(name, value.replace(/^(["'])(.*)\1$/, "$2"));
const names = [...secrets.keys()];
if (!names.length) {
  console.error(`${file} has no NAME=value lines.`);
  process.exit(1);
}

// Built by hand from the Map so no object property is ever written by name.
const body = `{${[...secrets].map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`).join(",")}}`;
const accountId = pick("CLOUDFLARE_ACCOUNT_ID");
const run = spawnSync("pnpm", ["exec", "wrangler", "secret", "bulk", "--name", "workoholic"], {
  cwd: root,
  input: body,
  encoding: "utf8",
  env: { ...process.env, CLOUDFLARE_API_TOKEN: token, ...(accountId && { CLOUDFLARE_ACCOUNT_ID: accountId }), CI: "1" },
});
if (run.status !== 0) {
  console.error(`${run.stdout}${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-10).join("\n"));
  process.exit(run.status ?? 1);
}
console.log(`Uploaded ${names.length} secret(s): ${names.join(", ")}`);
