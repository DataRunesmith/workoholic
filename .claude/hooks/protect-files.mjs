// PreToolUse hook for Edit and Write: AGENTS.md forbids changing workflows
// (only Renovate and Dependabot may) and editing the lockfile by hand.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const path = String(JSON.parse(input || "{}").tool_input?.file_path ?? "").replaceAll("\\", "/");
const blocked = /(^|\/)\.github\/workflows\//.test(path)
  ? "Workflows are not changed here (AGENTS.md: only Renovate and Dependabot may). Ask the owner first."
  : /(^|\/)pnpm-lock\.yaml$/.test(path)
    ? "Never edit the lockfile by hand. Use pnpm add/remove so pnpm updates it."
    : "";
if (blocked) {
  console.error(blocked);
  process.exit(2);
}
