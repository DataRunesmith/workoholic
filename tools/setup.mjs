#!/usr/bin/env node
// One-command setup of Workoholic on a Cloudflare account.
//
//   pnpm setup:cloudflare            create resources, render, migrate and deploy
//   pnpm setup:cloudflare --check    only verify the token and show what would be created
//
// Input: a temporary setup token (CLOUDFLARE_API_TOKEN) and PUBLIC_HOST, from
// setup.env or the environment (see setup.example.env). Everything else is
// looked up or generated, and the run can be repeated safely. Secret values are
// never printed; generated ones go to .setup-secrets (owner-only, git-ignored).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const API = "https://api.cloudflare.com/client/v4";
const WORKER = "workoholic";
const BUCKET = "workoholic-evidence";
const KEY_NAME = "WORKOHOLIC_CONFIG_KEY";
const KV_TITLE = "workoholic-config"; // holds the non-secret render settings for cloud builds

function parseEnv(file) {
  const values = new Map(); // a Map has no property names to inject into
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

const fileValues = existsSync(join(root, "setup.env")) ? parseEnv(join(root, "setup.env")) : new Map();
const get = (name, fallback = "") => process.env[name] || fileValues.get(name) || fallback;

const token = get("CLOUDFLARE_API_TOKEN");
if (!token) fail("CLOUDFLARE_API_TOKEN is missing. Put it in setup.env (see setup.example.env).");
const auth = get("AUTH", "password");
if (!["password", "access"].includes(auth)) fail("AUTH must be 'password' or 'access'.");
const host = get("PUBLIC_HOST");
if (!host) fail("PUBLIC_HOST is missing. Set the hostname the app will be served on (a domain in your Cloudflare account).");
// Values end up in request headers, URL paths and the rendered config, so only
// accept the shapes Cloudflare actually uses.
if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) fail("CLOUDFLARE_API_TOKEN looks malformed (letters, digits, _ and - only).");
if (host && !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host)) fail("PUBLIC_HOST must be a plain hostname such as app.example.com.");
if (get("CLOUDFLARE_ACCOUNT_ID") && !/^[0-9a-f]{32}$/.test(get("CLOUDFLARE_ACCOUNT_ID"))) fail("CLOUDFLARE_ACCOUNT_ID must be 32 hex characters.");
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(get("D1_DATABASE_NAME", "workoholic"))) fail("D1_DATABASE_NAME may only contain letters, digits, _ and -.");
if (auth === "access" && (!get("CF_ACCESS_TEAM_DOMAIN") || !get("CF_ACCESS_AUD"))) {
  fail("AUTH=access needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD.");
}

function fail(message) {
  console.error(`✘ ${message}`);
  process.exit(1);
}
const say = (message) => console.log(message);

async function api(method, path, body) {
  // Only ever talk to the Cloudflare API, whatever the path was built from.
  const url = new URL(`${API}${path}`);
  if (url.origin !== new URL(API).origin || !/^\/client\/v4\/(user|accounts)(\/|$)/.test(url.pathname)) {
    throw new Error(`refusing to call ${url.origin}${url.pathname}`);
  }
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.success === false) {
    const detail = (json.errors ?? []).map((e) => `${e.message} [code: ${e.code}]`).join("; ");
    throw new Error(`${method} ${path} -> HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return json.result;
}

let accountId = ""; // set once the account is known, so wrangler targets the same one

// Wrangler reads the token from the environment; it is never put on a command line.
function wrangler(args, { input, cwd = root } = {}) {
  const run = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, ...(accountId && { CLOUDFLARE_ACCOUNT_ID: accountId }), CI: "1" },
  });
  if (run.status !== 0) {
    const text = `${run.stdout}\n${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
    throw new Error(`wrangler ${args[0]} ${args[1] ?? ""} failed:\n${text.trim().split("\n").slice(-12).join("\n")}`);
  }
  return run.stdout;
}

async function main() {
  // 1. Token and account
  const accounts = await api("GET", "/accounts");
  if (accounts.length !== 1 && !get("CLOUDFLARE_ACCOUNT_ID")) {
    fail(`The token sees ${accounts.length} accounts. Set CLOUDFLARE_ACCOUNT_ID in setup.env.`);
  }
  const account = get("CLOUDFLARE_ACCOUNT_ID") || accounts[0].id;
  accountId = account;
  say(`✔ Token works (account ${accounts.find((a) => a.id === account)?.name ?? account})`);

  const dbName = get("D1_DATABASE_NAME", "workoholic");
  const databases = await api("GET", `/accounts/${account}/d1/database?name=${encodeURIComponent(dbName)}`);
  let database = databases.find((d) => d.name === dbName);
  let r2Enabled = true;
  // Filtered by name, so the bucket is found however many others the account has.
  const buckets = await api("GET", `/accounts/${account}/r2/buckets?name_contains=${encodeURIComponent(BUCKET)}`).catch((error) => {
    if (!String(error).includes("10042")) throw error;
    r2Enabled = false;
    return [];
  });
  if (!r2Enabled && !check) fail("R2 is not enabled. Enable it once in the dashboard (R2), then run again.");
  const hasBucket = (buckets.buckets ?? buckets).some((b) => b.name === BUCKET);
  // Look for the key in every store and every page, so an existing one is never missed.
  const stores = await api("GET", `/accounts/${account}/secrets_store/stores`);
  let store = stores[0];
  let hasKey = false;
  for (const candidate of stores) {
    for (let page = 1; !hasKey; page++) {
      const secrets = await api("GET", `/accounts/${account}/secrets_store/stores/${candidate.id}/secrets?per_page=100&page=${page}`);
      if (secrets.some((s) => s.name === KEY_NAME)) {
        hasKey = true;
        store = candidate;
      }
      if (secrets.length < 100) break;
    }
    if (hasKey) break;
  }
  // A new key cannot decrypt configuration saved under an earlier one.
  const keyBlocked = !hasKey && Boolean(database) && !get("ALLOW_NEW_CONFIG_KEY");
  const keyBlockedMessage = `D1 database "${dbName}" already exists but ${KEY_NAME} was not found in any Secrets Store. A new key could not decrypt settings saved earlier. Restore the old key, or set ALLOW_NEW_CONFIG_KEY=1 in setup.env if the database holds no saved settings.`;

  // Every page of namespaces, so an existing one is never missed.
  let kv;
  for (let page = 1; !kv; page++) {
    const namespaces = await api("GET", `/accounts/${account}/storage/kv/namespaces?per_page=100&page=${page}`);
    kv = namespaces.find((item) => item.title === KV_TITLE);
    if (namespaces.length < 100) break;
  }

  if (check) {
    say(`Would ${database ? "reuse" : "create"} D1 database "${dbName}"`);
    say(`Would ${kv ? "reuse" : "create"} KV namespace "${KV_TITLE}" and store the render settings in it`);
    say(r2Enabled ? `Would ${hasBucket ? "reuse" : "create"} R2 bucket "${BUCKET}"` : "✘ R2 is not enabled yet: enable it in the dashboard (R2) before the real run");
    say(`Would ${store ? "reuse" : "create"} a Secrets Store${hasKey ? "" : ` and add ${KEY_NAME}`}`);
    if (keyBlocked) say(`✘ ${keyBlockedMessage}`);
    say(`Would deploy "${WORKER}" on ${host} with ${auth} login`);
    say("Nothing was changed.");
    return;
  }

  if (keyBlocked) fail(keyBlockedMessage);

  // 2. Resources
  if (!database) {
    database = await api("POST", `/accounts/${account}/d1/database`, { name: dbName });
    say(`✔ Created D1 database "${dbName}"`);
  } else say(`✔ D1 database "${dbName}" exists`);
  if (!hasBucket) {
    await api("POST", `/accounts/${account}/r2/buckets`, { name: BUCKET });
    say(`✔ Created R2 bucket "${BUCKET}"`);
  } else say(`✔ R2 bucket "${BUCKET}" exists`);
  if (!store) {
    store = await api("POST", `/accounts/${account}/secrets_store/stores`, { name: "default_secrets_store" });
    say("✔ Created Secrets Store");
  } else say("✔ Secrets Store exists");
  if (!kv) {
    kv = await api("POST", `/accounts/${account}/storage/kv/namespaces`, { title: KV_TITLE });
    say(`✔ Created KV namespace "${KV_TITLE}"`);
  } else say(`✔ KV namespace "${KV_TITLE}" exists`);

  if (!hasKey) {
    // Never replaced afterwards: the configuration in D1 is encrypted with it.
    await api("POST", `/accounts/${account}/secrets_store/stores/${store.id}/secrets`, [
      {
        name: KEY_NAME,
        value: randomBytes(32).toString("base64"),
        scopes: ["workers"],
        comment: "Workoholic: encrypts the runtime configuration in D1. Do not delete.",
      },
    ]);
    say(`✔ Created ${KEY_NAME} in the Secrets Store`);
  } else say(`✔ ${KEY_NAME} exists (left untouched)`);

  // 3. Render
  const renderEnv = {
    ...process.env,
    PUBLIC_HOST: host,
    CF_ACCESS_TEAM_DOMAIN: auth === "access" ? get("CF_ACCESS_TEAM_DOMAIN") : "",
    CF_ACCESS_AUD: auth === "access" ? get("CF_ACCESS_AUD") : "",
    D1_DATABASE_NAME: dbName,
    D1_DATABASE_ID: database.uuid,
    SECRETS_STORE_ID: store.id,
    CONFIG_NAMESPACE: get("CONFIG_NAMESPACE", "Workoholic"),
    SITE_FAMILY: get("SITE_FAMILY", "Workoholic"),
    THEME_KEY_PREFIX: get("THEME_KEY_PREFIX", "workoholic"),
    THEME_COOKIE_DOMAIN: get("THEME_COOKIE_DOMAIN", ""),
  };
  const render = spawnSync("node", ["tools/render.mjs", "-", "build"], { cwd: root, env: renderEnv, encoding: "utf8" });
  if (render.status !== 0) fail(`render failed:\n${render.stderr}`);
  say("✔ Rendered build/");

  // The settings are not secret. Cloud builds read them from KV, so no build
  // variables have to be typed in.
  const buildVariables = Object.fromEntries(
    [
      "PUBLIC_HOST",
      "D1_DATABASE_NAME",
      "D1_DATABASE_ID",
      "SECRETS_STORE_ID",
      "CF_ACCESS_TEAM_DOMAIN",
      "CF_ACCESS_AUD",
      "CONFIG_NAMESPACE",
      "SITE_FAMILY",
      "THEME_KEY_PREFIX",
      "THEME_COOKIE_DOMAIN",
    ].map((name) => [name, renderEnv[name]]),
  );
  if (!/^[0-9a-f]{32}$/.test(kv.id)) fail("Unexpected KV namespace ID.");
  await api("PUT", `/accounts/${account}/storage/kv/namespaces/${kv.id}/values/settings`, buildVariables);
  say(`✔ Stored the render settings in KV ("${KV_TITLE}", key "settings")`);

  // 4. Database, then the Worker
  wrangler(["d1", "migrations", "apply", "DB", "--remote", "--cwd", "build"]);
  say("✔ Migrations applied");
  wrangler(["deploy", "--cwd", "build"]);
  say(`✔ Deployed "${WORKER}"`);

  // 5. Login secrets (only the first time; deploys never delete secrets)
  const existing = JSON.parse(wrangler(["secret", "list", "--format", "json", "--cwd", "build"]) || "[]").map((s) => s.name);
  if (auth === "password") {
    if (!existing.includes("ADMIN_PASSWORD")) {
      const password = randomBytes(18).toString("base64url");
      // Saved locally first, so a failed upload or a crash can never lose it.
      const file = join(root, ".setup-secrets");
      writeFileSync(file, `ADMIN_PASSWORD=${password}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      wrangler(["secret", "bulk", "--cwd", "build"], {
        input: JSON.stringify({ AUTH_MODE: "password", ADMIN_PASSWORD: password }),
      });
      say("✔ Set AUTH_MODE and a generated ADMIN_PASSWORD");
      say("→ The password is in .setup-secrets. Save it in your password manager, then delete the file.");
    } else if (!existing.includes("AUTH_MODE")) {
      // The password exists but AUTH_MODE was removed (a switch to Access and back).
      wrangler(["secret", "bulk", "--cwd", "build"], { input: JSON.stringify({ AUTH_MODE: "password" }) });
      say("✔ ADMIN_PASSWORD exists (left untouched); set AUTH_MODE=password again");
    } else say("✔ ADMIN_PASSWORD and AUTH_MODE exist (left untouched)");
  } else if (existing.includes("AUTH_MODE")) {
    // Switching to Access: an earlier password setting would still take priority.
    wrangler(["secret", "delete", "AUTH_MODE", "--cwd", "build"], { input: "y\n" });
    say("✔ Removed the old AUTH_MODE secret so Cloudflare Access is used");
  }

  // 6. Workers Builds: set the build and deploy commands
  const buildsNote = await configureWorkersBuilds(account);
  if (buildsNote) {
    say(`
${buildsNote}
Set these two by hand in Workers & Pages → ${WORKER} → Settings → Builds (no build variables are needed):
  Build command : ${BUILD_COMMAND}
  Deploy command: ${DEPLOY_COMMAND}
If the build fails at the migration step, select an API token with D1 Edit and Workers Scripts Edit under Settings → Builds → API token (the default build token may lack D1 access).
If it cannot read the KV settings (it needs Cloudflare credentials to do so), use this build command instead and add these build variables (not secret):
  Build command : pnpm install --frozen-lockfile && node tools/render.mjs - build
${Object.entries(buildVariables).map(([name, value]) => `    ${name}=${value}`).join("\n")}`);
  }
  say("Then delete the setup token in the dashboard (it is only needed for this step).");
}

const BUILD_COMMAND = `pnpm install --frozen-lockfile && node tools/render.mjs kv:${KV_TITLE} build`;
const DEPLOY_COMMAND = "npx wrangler d1 migrations apply DB --remote --cwd build && npx wrangler deploy --cwd build";

// Returns "" when Workers Builds is configured, otherwise why it was not.
async function configureWorkersBuilds(account) {
  try {
    const scripts = await api("GET", `/accounts/${account}/workers/scripts`);
    const tag = scripts.find((script) => script.id === WORKER)?.tag;
    if (!tag) return "→ Workers Builds: the Worker's tag was not found.";
    const triggers = await api("GET", `/accounts/${account}/builds/workers/${encodeURIComponent(tag)}/triggers`);
    if (triggers.length === 0) return `→ Workers Builds: no repository is connected yet. Connect it in Workers & Pages → ${WORKER} → Settings → Builds, then run this again.`;
    // Only the production trigger (builds main) gets the production commands.
    const trigger = triggers.find((item) => item.branch_includes?.join() === "main" && !item.branch_excludes?.length);
    if (!trigger) return '→ Workers Builds: no production trigger (branch_includes ["main"]) was found.';
    if (!/^[0-9a-f-]{36}$/i.test(trigger.trigger_uuid)) return "→ Workers Builds: unexpected trigger ID.";
    await api("PATCH", `/accounts/${account}/builds/triggers/${trigger.trigger_uuid}`, {
      build_command: BUILD_COMMAND,
      deploy_command: DEPLOY_COMMAND,
      root_directory: "/",
    });
    say("✔ Workers Builds: build and deploy commands are set");
    return "";
  } catch (error) {
    const denied = /HTTP 40[13]/.test(String(error));
    return denied
      ? "→ Workers Builds was not configured: the token lacks the Workers CI permission (Workers CI: Edit)."
      : `→ Workers Builds was not configured: ${error.message}`;
  }
}

main().catch((error) => fail(error.message));
