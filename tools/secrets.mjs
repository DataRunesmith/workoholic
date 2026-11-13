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
const secrets = Object.create(null); // no prototype, so a name like __proto__ is just a name
for (const line of readFileSync(file, "utf8").split("\n")) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (match) secrets[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
}
const names = Object.keys(secrets);
if (!names.length) {
  console.error(`${file} has no NAME=value lines.`);
  process.exit(1);
}
const run = spawnSync("pnpm", ["exec", "wrangler", "secret", "bulk", "--name", "workoholic"], {
  cwd: root,
  input: JSON.stringify(secrets),
  encoding: "utf8",
});
if (run.status !== 0) {
  console.error(`${run.stdout}${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-10).join("\n"));
  process.exit(run.status ?? 1);
}
console.log(`Uploaded ${names.length} secret(s): ${names.join(", ")}`);
