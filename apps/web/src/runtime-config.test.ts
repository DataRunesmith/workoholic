import { describe, expect, it } from "vitest";
import {
  resolveRuntimeConfiguration,
  saveRuntimeConfiguration,
  type RuntimeConfigEnv,
} from "./runtime-config";

interface Row {
  ciphertext: string;
  iv: string;
  updated_at: string;
  updated_by: string | null;
}

function fakeDb(options: { missingTable?: boolean } = {}) {
  let row: Row | null = null;
  let reencryptions = 0;
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args;
          return statement;
        },
        async first() {
          if (!sql.includes("FROM runtime_configuration")) return null;
          if (options.missingTable) {
            throw new Error("D1_ERROR: no such table: runtime_configuration: SQLITE_ERROR");
          }
          return row;
        },
        async run() {
          if (sql.includes("UPDATE runtime_configuration")) {
            reencryptions += 1;
            if (row && row.ciphertext === values[3]) {
              row = { ...row, ciphertext: String(values[0]), iv: String(values[1]) };
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (!sql.includes("INSERT INTO runtime_configuration")) {
            throw new Error("Unexpected SQL");
          }
          row = {
            ciphertext: String(values[1]),
            iv: String(values[2]),
            updated_at: "2026-09-30 22:00:00",
            updated_by: String(values[4]),
          };
          return { success: true };
        },
      };
      return statement;
    },
  } as unknown as D1Database;

  return {
    db,
    storedRow: () => row,
    reencryptions: () => reencryptions,
  };
}

function env(db: D1Database): RuntimeConfigEnv {
  return {
    DB: db,
    EMAIL: {
      async send() {
        return { messageId: "test" };
      },
    },
    WORKOHOLIC_CONFIG_KEY: {
      get: async () => "config-key-used-only-for-key-derivation",
    },
  };
}

describe("dashboard-managed runtime configuration", () => {
  it("rejects weak encryption key material before saving secrets", async () => {
    const state = fakeDb();
    await expect(
      saveRuntimeConfiguration(
        { ...env(state.db), WORKOHOLIC_CONFIG_KEY: "short" },
        { studentConsultingAutoSubmit: false },
        "operator@example.test",
      ),
    ).rejects.toThrow(/at least 32 UTF-8 bytes/);
    expect(state.storedRow()).toBeNull();
  });

  it("stores sensitive values encrypted and resolves them for automation", async () => {
    const state = fakeDb();
    const runtimeEnv = env(state.db);
    await saveRuntimeConfiguration(
      runtimeEnv,
      {
        studentConsulting: {
          email: "user@example.test",
          password: "example-password",
        },
        studentConsultingAutoSubmit: true,
        jobIncludeTerms: "supporttekniker, helpdesk",
        jobAllowedCountries: "se",
        notifyEmailTo: "user@example.test; other@example.test",
        notifyEmailFrom: "jobb@example.test",
        notifyEmailMode: "separate",
      },
      "operator@example.test",
    );

    const stored = state.storedRow();
    expect(stored).not.toBeNull();
    expect(stored?.ciphertext).not.toContain("example-password");
    expect(stored?.ciphertext).not.toContain("user@example.test");
    expect(stored?.updated_by).toBe("operator@example.test");

    const resolved = await resolveRuntimeConfiguration(runtimeEnv);
    expect(resolved.env.STUDENTCONSULTING_EMAIL).toBe("user@example.test");
    expect(resolved.env.STUDENTCONSULTING_PASSWORD).toBe("example-password");
    expect(resolved.env.STUDENTCONSULTING_AUTOSUBMIT).toBe("true");
    expect(resolved.env.JOB_ALLOWED_COUNTRIES).toBe("SE");
    expect(resolved.view).toMatchObject({
      studentConsultingCredentials: true,
      studentConsultingCredentialsSource: "dashboard",
      studentConsultingAutoSubmit: true,
      suitabilityPolicy: true,
      notifyEmailTo: "user@example.test, other@example.test",
      notifyEmailMode: "separate",
      managedConfigurationStored: true,
    });
    expect(JSON.stringify(resolved.view)).not.toContain("example-password");
  });

  it("reports any configured extra suitability filter as active", async () => {
    const state = fakeDb();
    const runtimeEnv = env(state.db);

    await saveRuntimeConfiguration(
      runtimeEnv,
      { jobExcludeTerms: "senior" },
      "operator@example.test",
    );

    const resolved = await resolveRuntimeConfiguration(runtimeEnv);
    expect(resolved.view.suitabilityPolicy).toBe(true);
    expect(resolved.view.suitabilityPolicySource).toBe("dashboard");
  });

  it("keeps deployment values authoritative over dashboard values", async () => {
    const state = fakeDb();
    const runtimeEnv = env(state.db);

    await saveRuntimeConfiguration(
      runtimeEnv,
      {
        studentConsulting: {
          email: "managed@example.test",
          password: "managed-password",
        },
        studentConsultingAutoSubmit: true,
        jobIncludeTerms: "support",
      },
      "operator@example.test",
    );
    const resolved = await resolveRuntimeConfiguration({
      ...runtimeEnv,
      STUDENTCONSULTING_EMAIL: "deployment@example.test",
      STUDENTCONSULTING_PASSWORD: "deployment-password",
      STUDENTCONSULTING_AUTOSUBMIT: "false",
      JOB_INCLUDE_TERMS: "deployment-rule",
    });

    expect(resolved.env.STUDENTCONSULTING_EMAIL).toBe("deployment@example.test");
    expect(resolved.env.STUDENTCONSULTING_PASSWORD).toBe("deployment-password");
    expect(resolved.env.STUDENTCONSULTING_AUTOSUBMIT).toBe("false");
    expect(resolved.env.JOB_INCLUDE_TERMS).toBe("deployment-rule");
    expect(resolved.view.studentConsultingCredentialsSource).toBe("deployment");
    expect(resolved.view.studentConsultingAutoSubmitSource).toBe("deployment");
    expect(resolved.view.suitabilityPolicySource).toBe("deployment");
  });

  it("keeps the dashboard fail-closed when migration 0006 is unavailable", async () => {
    const state = fakeDb({ missingTable: true });
    const runtimeEnv = env(state.db);

    const resolved = await resolveRuntimeConfiguration(runtimeEnv);
    expect(resolved.view.managedConfigurationStorageReady).toBe(false);
    expect(resolved.view.studentConsultingCredentials).toBe(false);
    expect(resolved.env.STUDENTCONSULTING_PASSWORD).toBeUndefined();

    await expect(
      saveRuntimeConfiguration(
        runtimeEnv,
        {
          studentConsulting: {
            email: "user@example.test",
            password: "example-password",
          },
          jobIncludeTerms: "support",
        },
        "operator@example.test",
      ),
    ).rejects.toThrow(/0006_runtime_configuration/);
  });

  it("fails closed when autosubmit lacks StudentConsulting credentials", async () => {
    const state = fakeDb();
    await expect(
      saveRuntimeConfiguration(
        env(state.db),
        { studentConsultingAutoSubmit: true },
        "operator@example.test",
      ),
    ).rejects.toThrow(/Autosubmit/);
  });

  it("allows autosubmit without include terms when credentials are configured", async () => {
    const state = fakeDb();
    const runtimeEnv = env(state.db);

    await saveRuntimeConfiguration(
      runtimeEnv,
      {
        studentConsulting: {
          email: "user@example.test",
          password: "example-password",
        },
        studentConsultingAutoSubmit: true,
      },
      "operator@example.test",
    );

    const resolved = await resolveRuntimeConfiguration(runtimeEnv);
    expect(resolved.env.STUDENTCONSULTING_AUTOSUBMIT).toBe("true");
    expect(resolved.env.JOB_INCLUDE_TERMS).toBeUndefined();
    expect(resolved.view.studentConsultingCredentials).toBe(true);
    expect(resolved.view.suitabilityPolicy).toBe(false);
  });

  it("refuses to overwrite configuration when the current key cannot decrypt it", async () => {
    const state = fakeDb();
    const original = env(state.db);

    await saveRuntimeConfiguration(
      original,
      {
        studentConsulting: {
          email: "old@example.test",
          password: "old-password",
        },
        studentConsultingAutoSubmit: true,
        jobIncludeTerms: "support",
      },
      "operator@example.test",
    );
    const before = state.storedRow();

    const rotated: RuntimeConfigEnv = {
      ...original,
      WORKOHOLIC_CONFIG_KEY: {
        get: async () => "rotated-config-key",
      },
    };
    const unreadable = await resolveRuntimeConfiguration(rotated);
    expect(unreadable.view.managedConfigurationUnreadable).toBe(true);
    expect(unreadable.view.studentConsultingCredentials).toBe(false);
    expect(unreadable.env.STUDENTCONSULTING_PASSWORD).toBeUndefined();

    await expect(
      saveRuntimeConfiguration(
        rotated,
        {
          studentConsulting: {
            email: "new@example.test",
            password: "new-password",
          },
          studentConsultingAutoSubmit: true,
          jobIncludeTerms: "helpdesk",
        },
        "operator@example.test",
      ),
    ).rejects.toThrow(/decrypt/i);

    expect(state.storedRow()).toEqual(before);
  });

  it("migrates a row encrypted with the previous key and keeps its history", async () => {
    const state = fakeDb();
    const legacy: RuntimeConfigEnv = {
      ...env(state.db),
      WORKOHOLIC_CONFIG_KEY: "github-oauth-client-secret",
    };
    await saveRuntimeConfiguration(
      legacy,
      {
        studentConsulting: { email: "user@example.test", password: "kept-password" },
        jobIncludeTerms: "support",
      },
      "operator@example.test",
    );
    const before = state.storedRow()!;

    const migrating: RuntimeConfigEnv = {
      ...env(state.db),
      WORKOHOLIC_CONFIG_KEY: "new-config-key",
      WORKOHOLIC_CONFIG_KEY_PREVIOUS: { get: async () => "github-oauth-client-secret" },
    };
    const resolved = await resolveRuntimeConfiguration(migrating);
    expect(resolved.view.managedConfigurationUnreadable).toBe(false);
    expect(resolved.env.STUDENTCONSULTING_PASSWORD).toBe("kept-password");
    expect(state.reencryptions()).toBe(1);

    const after = state.storedRow()!;
    expect(after.ciphertext).not.toBe(before.ciphertext);
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.updated_by).toBe(before.updated_by);

    // Once re-encrypted, the previous key is no longer needed.
    const currentOnly: RuntimeConfigEnv = {
      ...env(state.db),
      WORKOHOLIC_CONFIG_KEY: "new-config-key",
    };
    const reread = await resolveRuntimeConfiguration(currentOnly);
    expect(reread.env.STUDENTCONSULTING_PASSWORD).toBe("kept-password");
    expect(state.reencryptions()).toBe(1);
  });
});
