#!/usr/bin/env node
// Upload secrets for the deployed Worker from secrets.env.
//
//   pnpm secrets:push
//
// secrets.env (git-ignored, in the repository root) holds NAME=value lines, for
// example STUDENTCONSULTING_EMAIL, STUDENTCONSULTING_PASSWORD or SMTP_PASSWORD.
// Lines starting with # and blank lines are ignored. The values are sent to
// wrangler on stdin (never on a command line or into a log); only the names are
// printed. CLOUDFLARE_API_TOKEN (and optionally CLOUDFLARE_ACCOUNT_ID) come from
// the environment, which the package script fills from setup.env.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform === "win32") {
  console.error("✘ Run this on macOS, Linux or WSL. Windows is not supported.");
  process.exit(1);
}
const FILE = join(root, "secrets.env"); // a fixed location, never a path from the command line

let text;
try {
  text = readFileSync(FILE, "utf8");
} catch {
  console.error("secrets.env was not found in the repository root. Create it with NAME=value lines.");
  process.exit(1);
}

const secrets = new Map(); // a Map has no property names to inject into
for (const line of text.split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (match) secrets.set(match[1], match[2].replace(/^(["'])(.*)\1$/, "$2"));
}
const names = [...secrets.keys()];
if (!names.length) {
  console.error("secrets.env has no NAME=value lines.");
  process.exit(1);
}

// Built by hand from the Map so no object property is ever written by name.
const body = `{${[...secrets].map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`).join(",")}}`;
const run = spawnSync("pnpm", ["exec", "wrangler", "secret", "bulk", "--name", "workoholic"], {
  cwd: root,
  input: body,
  encoding: "utf8",
  env: { ...process.env, CI: "1" },
});
if (run.status !== 0) {
  console.error(`${run.stdout}${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-10).join("\n"));
  process.exit(run.status ?? 1);
}
console.log(`Uploaded ${names.length} secret(s): ${names.join(", ")}`);
