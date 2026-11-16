// PreToolUse hook for Bash: before a git commit, remind the agent of the
// review AGENTS.md requires. It does not block; it adds the reminder to context.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const command = String(JSON.parse(input || "{}").tool_input?.command ?? "");
if (/(^|[;&|\s])git\s+(-\S+\s+)*commit\b/.test(command)) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        "Before this commit: run /security-review and /code-review on the full diff and fix every finding (AGENTS.md). Check for secrets in logs and conditions controlled by environment input.",
    },
  }));
}
