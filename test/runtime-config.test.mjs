import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readWranglerConfig() {
  return JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
}

test("Workoholic tracked production config cannot be sanitized into a preview-only config", async () => {
  const config = await readWranglerConfig();
  assert.equal(config.name, "workoholic");
  assert.equal(config.observability?.enabled, true);
  assert.ok(config.d1_databases?.some((binding) => binding.binding === "DB"));
  assert.ok(config.r2_buckets?.some((binding) => binding.binding === "EVIDENCE"));
  assert.ok(config.routes?.some((route) => route.pattern === "__PUBLIC_HOST__"));
  assert.ok(config.triggers?.crons?.length > 0);
});

test("Workoholic authenticates with Cloudflare Access and has no GitHub auth config", async () => {
  const config = await readWranglerConfig();
  assert.equal(config.vars?.CF_ACCESS_TEAM_DOMAIN, "__CF_ACCESS_TEAM_DOMAIN__");
  assert.equal(config.vars?.CF_ACCESS_AUD, "__CF_ACCESS_AUD__");
  assert.doesNotMatch(JSON.stringify(config), /GITHUB/);
});

test("Workoholic encrypts runtime configuration with a dedicated rotating key", async () => {
  const config = await readWranglerConfig();
  const byBinding = Object.fromEntries(
    (config.secrets_store_secrets ?? []).map((item) => [item.binding, item.secret_name]),
  );
  assert.equal(byBinding.WORKOHOLIC_CONFIG_KEY, "WORKOHOLIC_CONFIG_KEY");
  // Only bound while a rotation is in progress.
  assert.equal(byBinding.WORKOHOLIC_CONFIG_KEY_PREVIOUS, undefined);
});
