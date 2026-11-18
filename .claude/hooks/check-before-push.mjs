// PreToolUse hook for Bash: AGENTS.md forbids pushing code that has not passed
// the checks CI runs. Before a git push, run the same checks as CI (the "test" job
// in ci.yml, the docs build in pages.yml, Semgrep and Trivy from security.yml) and
// block the push (exit 2) if any of them fails. Keep CHECKS in sync with those files.
// Semgrep and Trivy only report in CI; here they also fail on any finding.
// It fails closed: unparseable input, a missing tool or a timeout blocks the push.
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const SEMGREP = "docker.io/semgrep/semgrep@sha256:31e9989dbc5e2019ea2f793196480e0b2e43f881984f324d2452254a167684e8";
const TRIVY = "docker.io/aquasec/trivy:0.76.2";
// Claude Code cancels a hook after 600 s, and a cancelled hook does not block.
const DEADLINE = Date.now() + 570_000;

const block = (why) => {
  console.error(`Blocked: ${why}`);
  process.exit(2);
};

let command = "";
try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  command = String(JSON.parse(input).tool_input?.command ?? "");
} catch {
  block("the hook input could not be parsed.");
}

// Matches within one command segment, so global options (-C dir, -c k=v) are allowed.
if (!/(^|[;&|(\s])git\s[^;&|]*?\bpush\b/.test(command)) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// Outside the repo: "zensical build --clean" wipes .cache/ inside it.
const VENV = join(tmpdir(), `${basename(root)}-docs-venv`);
const has = (tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0;
const runtime = ["podman", "docker"].find(has);
// Rootless podman maps the container user to the host user; docker needs --user.
const asUser = runtime === "docker" ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];
const container = (...args) => [runtime ?? "podman", ["run", "--rm", ...asUser, ...args]];

const CHECKS = [
  ["pnpm", ["install", "--frozen-lockfile"]],
  ["pnpm", ["test"]],
  ["pnpm", ["typecheck"]],
  ["sh", ["tools/deploy.sh", "cloudflare.example.env", "--dry-run"]],
  ["node", ["tools/check-addresses.mjs"]],
  ["python3", ["-m", "venv", VENV]],
  [`${VENV}/bin/pip`, ["install", "--quiet", "--no-deps", "-r", "requirements-docs.txt"]],
  ["node", ["tools/docs-site.mjs"]],
  [`${VENV}/bin/zensical`, ["build", "--clean", "--strict"]],
  container(
    "--volume", `${root}:/src:ro`, "--workdir", "/src",
    "--env", "HOME=/tmp", "--env", "SEMGREP_SEND_METRICS=off",
    SEMGREP, "semgrep", "scan", "--config", "p/default", "--error", "--quiet", ".",
  ),
  container(
    "--volume", `${root}:/src:ro`, "--workdir", "/src",
    "--env", "TRIVY_INCLUDE_DEV_DEPS=true",
    TRIVY, "fs", "--scanners", "vuln,misconfig,secret,license",
    "--severity", "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL", "--exit-code", "1", "--quiet", "/src",
  ),
];

for (const [cmd, args] of CHECKS) {
  const name = [cmd, ...args].join(" ").slice(0, 120);
  if ((cmd === "podman" || cmd === "docker") && !runtime) {
    block("neither podman nor docker is installed, so Semgrep and Trivy cannot run.");
  }
  const left = DEADLINE - Date.now();
  if (left <= 0) block("the checks took longer than 570 s. Run the slow step on its own first (for example pull the images), then push again.");
  const run = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: left,
  });
  if (run.error || run.status !== 0) {
    const tail = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error?.message ?? ""}`
      .trimEnd()
      .split("\n")
      .slice(-80)
      .join("\n");
    block(`push not allowed, "${name}" failed. Fix it, then push again.\n${tail}`);
  }
}
