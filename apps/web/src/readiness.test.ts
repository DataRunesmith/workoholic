import { describe, expect, it } from "vitest";
import { getReadiness, readinessResponse } from "./readiness";

interface FakeDbOptions {
  databaseOk?: boolean;
  runtimeConfiguration?: boolean;
  passwordRateLimit?: boolean;
  error?: Error;
}

function fakeDb(options: FakeDbOptions = {}): D1Database {
  const { databaseOk = true, runtimeConfiguration = true, passwordRateLimit = true, error } = options;

  return {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (error) throw error;
          if (sql.includes("SELECT 1 AS ok")) {
            return { ok: databaseOk ? 1 : 0 };
          }
          if (sql.includes("dashboard_login_attempts")) {
            return passwordRateLimit ? { name: "dashboard_login_attempts" } : null;
          }
          if (sql.includes("runtime_configuration")) {
            return {
              schema_ready: runtimeConfiguration ? 1 : 0,
              migration_tracked: runtimeConfiguration ? 1 : 0,
            };
          }
          return null;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe("readiness", () => {
  const access = {
    CF_ACCESS_TEAM_DOMAIN: "yourteam.cloudflareaccess.com",
    CF_ACCESS_AUD: "a".repeat(64),
  };
  const accessAuth = {
    ...access,
    WORKOHOLIC_CONFIG_KEY: {
      get: async () => "config-key",
    },
  };

  it("is ready when D1, runtime schema, Access and the config key are ready", async () => {
    await expect(getReadiness(fakeDb(), accessAuth)).resolves.toEqual({
      status: "ready",
      checks: {
        database: true,
        dashboardAuth: true,
        runtimeConfiguration: true,
        passwordLoginRateLimit: true,
      },
    });
  });

  it("fails closed while the runtime configuration migration is missing", async () => {
    const result = await getReadiness(fakeDb({ runtimeConfiguration: false }), accessAuth);

    expect(result).toEqual({
      status: "degraded",
      checks: {
        database: true,
        dashboardAuth: true,
        runtimeConfiguration: false,
        passwordLoginRateLimit: true,
      },
    });
  });

  it("fails closed when the config key cannot be resolved", async () => {
    const result = await getReadiness(fakeDb(), {
      ...access,
      WORKOHOLIC_CONFIG_KEY: {
        get: async () => {
          throw new Error("secret unavailable");
        },
      },
    });

    expect(result).toEqual({
      status: "degraded",
      checks: {
        database: true,
        dashboardAuth: false,
        runtimeConfiguration: true,
        passwordLoginRateLimit: true,
      },
    });
  });

  it("fails closed when password mode lacks its atomic login rate-limit migration", async () => {
    const result = await getReadiness(fakeDb({ passwordRateLimit: false }), {
      AUTH_MODE: "password",
      ADMIN_PASSWORD: "correct horse battery",
      WORKOHOLIC_CONFIG_KEY: {
        get: async () => "config-key",
      },
    });

    expect(result).toEqual({
      status: "degraded",
      checks: {
        database: true,
        dashboardAuth: true,
        runtimeConfiguration: true,
        passwordLoginRateLimit: false,
      },
    });
  });

  it("fails closed when D1 cannot be read", async () => {
    const result = await getReadiness(fakeDb({ error: new Error("D1 unavailable") }), accessAuth);
    expect(result.status).toBe("degraded");
    expect(result.checks.database).toBe(false);
    expect(result.checks.runtimeConfiguration).toBe(false);
  });

  it("fails closed for partial Access configuration", async () => {
    const response = await readinessResponse(fakeDb(), {
      CF_ACCESS_TEAM_DOMAIN: "yourteam.cloudflareaccess.com",
      WORKOHOLIC_CONFIG_KEY: "config-key",
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      checks: {
        database: true,
        dashboardAuth: false,
        runtimeConfiguration: true,
      },
    });
  });

  it("fails closed when dashboard auth is missing", async () => {
    const response = await readinessResponse(fakeDb(), {});
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      checks: {
        database: true,
        dashboardAuth: false,
        runtimeConfiguration: true,
      },
    });
  });
});
