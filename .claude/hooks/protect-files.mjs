// PreToolUse hook for file edits and Bash: AGENTS.md forbids changing workflows
// (only Renovate and Dependabot may) and editing the lockfile by hand.
// It fails closed: input it cannot parse is blocked.
import { realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const WORKFLOWS = "workflows are not changed here (AGENTS.md: only Renovate and Dependabot may). Ask the owner first.";
const LOCKFILE = "never edit the lockfile by hand. Use pnpm add/remove so pnpm updates it.";

const block = (why) => {
  console.error(`Blocked: ${why}`);
  process.exit(2);
};

let data;
try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  data = JSON.parse(input);
} catch {
  block("the hook input could not be parsed.");
}

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    // The file may not exist yet: resolve its nearest existing parent instead.
    try {
      return resolve(realpathSync(dirname(p)), p.slice(dirname(p).length + 1));
    } catch {
      return p;
    }
  }
};

// Returns the reason a project-relative path is protected, or "".
const reasonFor = (file) => {
  const rel = relative(real(root), real(resolve(root, file)))
    .replaceAll("\\", "/")
    .toLowerCase();
  if (rel === ".github/workflows" || rel.startsWith(".github/workflows/")) return WORKFLOWS;
  if (rel === "pnpm-lock.yaml") return LOCKFILE;
  return "";
};

const input = data?.tool_input ?? {};

if (data?.tool_name === "Bash") {
  const command = String(input.command ?? "");
  // Heuristic: a write-type command that names a protected path.
  const writes = /(\bsed\s+(-\S*\s+)*-\S*i|\bperl\s+(-\S*\s+)*-\S*i|\btee\b|\bmv\b|\bcp\b|\brm\b|\bln\b|\btruncate\b|>>?)/;
  if (writes.test(command)) {
    if (/\.github\/workflows\b/i.test(command)) block(WORKFLOWS);
    if (/(^|[\s/'"=])pnpm-lock\.yaml\b/i.test(command)) block(LOCKFILE);
  }
} else {
  const file = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof file !== "string" || file === "") block("the tool call names no file path.");
  const why = reasonFor(file);
  if (why) block(why);
}
