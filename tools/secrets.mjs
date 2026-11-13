#!/usr/bin/env node
// Upload secrets for the deployed Worker from a NAME=value file.
//
//   pnpm secrets:push <file>
//
// The values are sent to wrangler on stdin (never on a command line or into a
// log); only the names are printed. Use it for STUDENTCONSULTING_EMAIL,
// STUDENTCONSULTING_PASSWORD, SMTP_PASSWORD and similar. Lines starting with #
// and blank lines are ignored. Needs CLOUDFLARE_API_TOKEN in the environment.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: pnpm secrets <file with NAME=value lines>");
  process.exit(2);
}
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const secrets = new Map(); // a Map has no property names to inject into
for (const line of readFileSync(file, "utf8").split("\n")) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (match) secrets.set(match[1], match[2].replace(/^(["'])(.*)\1$/, "$2"));
}
const names = [...secrets.keys()];
if (!names.length) {
  console.error(`${file} has no NAME=value lines.`);
  process.exit(1);
}
// Built by hand from the Map so no object property is ever written by name.
const body = `{${[...secrets].map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`).join(",")}}`;
const run = spawnSync("pnpm", ["exec", "wrangler", "secret", "bulk", "--name", "workoholic"], {
  cwd: root,
  input: body,
  encoding: "utf8",
});
if (run.status !== 0) {
  console.error(`${run.stdout}${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-10).join("\n"));
  process.exit(run.status ?? 1);
}
console.log(`Uploaded ${names.length} secret(s): ${names.join(", ")}`);
