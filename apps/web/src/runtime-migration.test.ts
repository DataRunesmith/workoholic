import { describe, expect, it } from "vitest";
import {
  RUNTIME_CONFIGURATION_MIGRATION_NAME,
  runtimeConfigurationMigrationReady,
} from "./runtime-migration";

function fakeDb(schemaReady: boolean, migrationTracked: boolean): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
        async first<T>() {
          expect(sql).toContain("runtime_configuration");
          expect(statement.values).toEqual([RUNTIME_CONFIGURATION_MIGRATION_NAME]);
          return {
            schema_ready: schemaReady ? 1 : 0,
            migration_tracked: migrationTracked ? 1 : 0,
          } as T;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe("runtime configuration migration readiness", () => {
  it("requires both the schema and D1 migration tracking row", async () => {
    await expect(runtimeConfigurationMigrationReady(fakeDb(true, true))).resolves.toBe(true);
    await expect(runtimeConfigurationMigrationReady(fakeDb(true, false))).resolves.toBe(false);
    await expect(runtimeConfigurationMigrationReady(fakeDb(false, true))).resolves.toBe(false);
  });

  it("fails closed when D1 cannot verify migration state", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            throw new Error("D1 unavailable");
          },
        };
      },
    } as unknown as D1Database;

    await expect(runtimeConfigurationMigrationReady(db)).resolves.toBe(false);
  });
});
