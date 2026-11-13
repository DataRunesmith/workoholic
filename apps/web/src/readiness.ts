import { dashboardAuthMode, type DashboardAuthEnv } from "./auth";
import { resolveConfigKeys, type ConfigKeyEnv } from "./config-keys";
import { runtimeConfigurationMigrationReady } from "./runtime-migration";
import { passwordLoginRateLimitReady } from "./password-auth";

export interface ReadinessResult {
  status: "ready" | "degraded";
  checks: {
    database: boolean;
    dashboardAuth: boolean;
    runtimeConfiguration: boolean;
    passwordLoginRateLimit: boolean;
  };
}

export async function getReadiness(
  db: D1Database,
  env: DashboardAuthEnv & ConfigKeyEnv,
): Promise<ReadinessResult> {
  let database = false;
  try {
    const result = await db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    database = Number(result?.ok ?? 0) === 1;
  } catch {
    database = false;
  }

  const runtimeConfiguration = database ? await runtimeConfigurationMigrationReady(db) : false;
  const passwordLoginRateLimit =
    dashboardAuthMode(env) === "password" ? await passwordLoginRateLimitReady(db) : true;

  let dashboardAuth = false;
  if (dashboardAuthMode(env) !== "misconfigured") {
    try {
      await resolveConfigKeys(env);
      dashboardAuth = true;
    } catch {
      dashboardAuth = false;
    }
  }

  return {
    status: database && dashboardAuth && runtimeConfiguration && passwordLoginRateLimit ? "ready" : "degraded",
    checks: {
      database,
      dashboardAuth,
      runtimeConfiguration,
      passwordLoginRateLimit,
    },
  };
}

export async function readinessResponse(
  db: D1Database,
  env: DashboardAuthEnv & ConfigKeyEnv,
): Promise<Response> {
  const result = await getReadiness(db, env);
  return Response.json(result, {
    status: result.status === "ready" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
