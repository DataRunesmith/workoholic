export const RUNTIME_CONFIGURATION_MIGRATION_NAME =
  "0008_runtime_configuration_access_identity.sql";

export async function runtimeConfigurationMigrationReady(db: D1Database): Promise<boolean> {
  try {
    const state = await db
      .prepare(
        `SELECT
           EXISTS(
             SELECT 1
             FROM sqlite_schema
             WHERE type = 'table' AND name = 'runtime_configuration'
           ) AS schema_ready,
           EXISTS(
             SELECT 1
             FROM d1_migrations
             WHERE name = ?
           ) AS migration_tracked`,
      )
      .bind(RUNTIME_CONFIGURATION_MIGRATION_NAME)
      .first<{ schema_ready: number; migration_tracked: number }>();

    return Number(state?.schema_ready ?? 0) === 1 && Number(state?.migration_tracked ?? 0) === 1;
  } catch {
    return false;
  }
}
