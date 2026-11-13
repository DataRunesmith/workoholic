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

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const check = process.argv.includes("--check");
const API = "https://api.cloudflare.com/client/v4";
const WORKER = "workoholic";
const BUCKET = "workoholic-evidence";
const KEY_NAME = "WORKOHOLIC_CONFIG_KEY";

function parseEnv(file) {
  const values = Object.create(null); // no prototype, so a key like __proto__ is just a name
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

const fileValues = existsSync(join(root, "setup.env")) ? parseEnv(join(root, "setup.env")) : {};
const get = (name, fallback = "") => process.env[name] || fileValues[name] || fallback;

const token = get("CLOUDFLARE_API_TOKEN");
if (!token) fail("CLOUDFLARE_API_TOKEN is missing. Put it in setup.env (see setup.example.env).");
const auth = get("AUTH", "password");
if (!["password", "access"].includes(auth)) fail("AUTH must be 'password' or 'access'.");
const host = get("PUBLIC_HOST");
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
  const response = await fetch(`${API}${path}`, {
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

// Wrangler reads the token from the environment; it is never put on a command line.
function wrangler(args, { input, cwd = root } = {}) {
  const run = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CI: "1" },
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
  say(`✔ Token works (account ${accounts.find((a) => a.id === account)?.name ?? account})`);

  const dbName = get("D1_DATABASE_NAME", "workoholic");
  const databases = await api("GET", `/accounts/${account}/d1/database?name=${encodeURIComponent(dbName)}`);
  let database = databases.find((d) => d.name === dbName);
  let r2Enabled = true;
  const buckets = await api("GET", `/accounts/${account}/r2/buckets`).catch((error) => {
    if (!String(error).includes("10042")) throw error;
    r2Enabled = false;
    return [];
  });
  if (!r2Enabled && !check) fail("R2 is not enabled. Enable it once in the dashboard (R2), then run again.");
  const hasBucket = (buckets.buckets ?? buckets).some((b) => b.name === BUCKET);
  const stores = await api("GET", `/accounts/${account}/secrets_store/stores`);
  let store = stores[0];
  let hasKey = false;
  if (store) {
    const secrets = await api("GET", `/accounts/${account}/secrets_store/stores/${store.id}/secrets?per_page=100`);
    hasKey = secrets.some((s) => s.name === KEY_NAME);
  }

  if (check) {
    say(`Would ${database ? "reuse" : "create"} D1 database "${dbName}"`);
    say(r2Enabled ? `Would ${hasBucket ? "reuse" : "create"} R2 bucket "${BUCKET}"` : "✘ R2 is not enabled yet: enable it in the dashboard (R2) before the real run");
    say(`Would ${store ? "reuse" : "create"} a Secrets Store${hasKey ? "" : ` and add ${KEY_NAME}`}`);
    say(`Would deploy "${WORKER}" ${host ? `on ${host}` : "on workers.dev (no PUBLIC_HOST)"} with ${auth} login`);
    say("Nothing was changed.");
    return;
  }

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

  const generated = [];
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
  if (!host) {
    // No custom domain: serve on workers.dev instead.
    const path = join(root, "build", "wrangler.jsonc");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.workers_dev = true;
    delete config.routes;
    delete config.vars.PUBLIC_BASE_URL;
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  say("✔ Rendered build/");

  // 4. Database, then the Worker
  wrangler(["d1", "migrations", "apply", "DB", "--remote", "--cwd", "build"]);
  say("✔ Migrations applied");
  wrangler(["deploy", "--cwd", "build"]);
  say(`✔ Deployed "${WORKER}"`);

  // 5. Login secrets (only the first time; deploys never delete secrets)
  if (auth === "password") {
    const existing = JSON.parse(wrangler(["secret", "list", "--format", "json", "--cwd", "build"]) || "[]").map((s) => s.name);
    if (!existing.includes("ADMIN_PASSWORD")) {
      const password = randomBytes(18).toString("base64url");
      wrangler(["secret", "bulk", "--cwd", "build"], {
        input: JSON.stringify({ AUTH_MODE: "password", ADMIN_PASSWORD: password }),
      });
      generated.push(`ADMIN_PASSWORD=${password}`);
      say("✔ Set AUTH_MODE and a generated ADMIN_PASSWORD");
    } else say("✔ ADMIN_PASSWORD exists (left untouched)");
  }
  if (generated.length) {
    const file = join(root, ".setup-secrets");
    writeFileSync(file, `${generated.join("\n")}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    say("→ Generated values are in .setup-secrets. Save them in your password manager, then delete the file.");
  }

  // 6. Workers Builds hand-off (no secrets here)
  say(`
Next: connect the repo in Cloudflare (Workers & Pages → ${WORKER} → Settings → Builds).
  Build command : pnpm install --frozen-lockfile && node tools/render.mjs - build
  Deploy command: npx wrangler d1 migrations apply DB --remote --cwd build && npx wrangler deploy --cwd build
  Build variables (not secret):
    PUBLIC_HOST=${host}
    D1_DATABASE_NAME=${dbName}
    D1_DATABASE_ID=${database.uuid}
    SECRETS_STORE_ID=${store.id}
    CF_ACCESS_TEAM_DOMAIN=${renderEnv.CF_ACCESS_TEAM_DOMAIN}
    CF_ACCESS_AUD=${renderEnv.CF_ACCESS_AUD}
    CONFIG_NAMESPACE=${renderEnv.CONFIG_NAMESPACE}
    SITE_FAMILY=${renderEnv.SITE_FAMILY}
    THEME_KEY_PREFIX=${renderEnv.THEME_KEY_PREFIX}
    THEME_COOKIE_DOMAIN=${renderEnv.THEME_COOKIE_DOMAIN}
Then delete the setup token in the dashboard (it is only needed for this step).`);
}

main().catch((error) => fail(error.message));
