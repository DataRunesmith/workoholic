// PreToolUse hook for Bash: before a git commit or push, remind the agent of the
// review AGENTS.md requires. It does not block; it adds the reminder to context.
let command = "";
try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  command = String(JSON.parse(input).tool_input?.command ?? "");
} catch {
  process.exit(0);
}
// Matches within one command segment, so global options (-C dir, -c k=v) are allowed.
if (/(^|[;&|(\s])git\s[^;&|]*?\b(commit|push)\b/.test(command)) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        "Before this commit or push: run /security-review and /code-review (or the security-reviewer subagent) on the full diff and fix every finding (AGENTS.md). Check for secrets in logs and conditions controlled by environment input.",
    },
  }));
}
