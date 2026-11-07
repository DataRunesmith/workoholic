import { describe, expect, it } from "vitest";
import {
  claimRunStart,
  deleteRunRecords,
  failOrphanedRunningRuns,
  isRetryablePreSubmitFailure,
  listRetryableFailedJobs,
  reclassifyApplicationNotSubmitted,
  requeueFailedPreSubmitApplication,
  shouldDelayNotAppliedReclassification,
  verifyApplicationFromAttention,
  type ApplicationForJobRow,
  type AutomationRunRow,
} from "./storage";

function runRow(overrides: Partial<AutomationRunRow> = {}): AutomationRunRow {
  return {
    id: "scheduled:2026-10",
    mode: "scheduled",
    application_month: "2026-10",
    report_month: "2026-10",
    status: "running",
    target_count: 10,
    verified_count: 0,
    workflow_instance_id: null,
    last_error: null,
    started_at: "2026-10-01 16:00:00",
    completed_at: null,
    updated_at: "2026-10-01 16:00:00",
    ...overrides,
  };
}

function claimDb(changes: number, row = runRow()) {
  const sql: string[] = [];
  const binds: unknown[][] = [];

  const db = {
    prepare(statement: string) {
      sql.push(statement);
      return {
        bind(...values: unknown[]) {
          binds.push(values);
          return this;
        },
        async run() {
          return { meta: { changes } };
        },
        async first() {
          return row;
        },
      };
    },
  } as unknown as D1Database;

  return { db, sql, binds };
}

function applicationRow(overrides: Partial<ApplicationForJobRow> = {}): ApplicationForJobRow {
  return {
    id: "application:studentconsulting:87544",
    status: "failed",
    applied_at: null,
    verified_at: null,
    automation_run_id: "manual:old",
    report_month: "2026-10",
    last_attempt_no: null,
    last_attempt_error_code: null,
    last_attempt_error_message: null,
    ...overrides,
  };
}

describe("application retry state", () => {
  it("retries only definite pre-submit failures", () => {
    expect(
      isRetryablePreSubmitFailure(
        applicationRow({ automation_run_id: "manual:new" }),
        "manual:new",
      ),
    ).toBe(true);
    expect(
      isRetryablePreSubmitFailure(
        applicationRow({
          automation_run_id: "manual:new",
          applied_at: "2026-10-02T12:00:00Z",
        }),
        "manual:new",
      ),
    ).toBe(false);
    expect(
      isRetryablePreSubmitFailure(
        applicationRow({
          automation_run_id: "manual:new",
          verified_at: "2026-10-02T12:01:00Z",
        }),
        "manual:new",
      ),
    ).toBe(false);

    for (const status of ["queued", "applying", "submitted", "verified", "needs_user_action"]) {
      expect(
        isRetryablePreSubmitFailure(
          applicationRow({
            automation_run_id: "manual:new",
            status,
          }),
          "manual:new",
        ),
      ).toBe(false);
    }

    expect(
      isRetryablePreSubmitFailure(
        applicationRow({
          automation_run_id: "manual:other",
          last_attempt_error_code: "APPLICATION_NOT_APPLIED",
        }),
        "manual:new",
      ),
    ).toBe(true);
    expect(
      isRetryablePreSubmitFailure(
        applicationRow({
          automation_run_id: "manual:other",
          last_attempt_error_code: "APPLICATION_FAILED",
          last_attempt_error_message:
            "STUDENTCONSULTING_LOGIN_FORM_NOT_FOUND: StudentConsulting login form could not be identified.",
        }),
        "manual:new",
      ),
    ).toBe(true);
    expect(
      isRetryablePreSubmitFailure(
        applicationRow({
          automation_run_id: "manual:other",
          last_attempt_no: 4,
          last_attempt_error_code: "APPLICATION_FAILED",
          last_attempt_error_message:
            "APPLICATION_REQUIRES_INPUT: a required application field is empty.",
        }),
        "manual:new",
      ),
    ).toBe(true);
    expect(
      isRetryablePreSubmitFailure(
        applicationRow({
          automation_run_id: "manual:other",
          last_attempt_no: 12,
          last_attempt_error_code: "APPLICATION_FAILED",
          last_attempt_error_message:
            "APPLICATION_REQUIRES_INPUT: a required application field is empty.",
        }),
        "manual:new",
      ),
    ).toBe(true);
  });

  it("loads persisted retryable failures for a later run", async () => {
    const job = {
      provider: "studentconsulting" as const,
      externalId: "87581",
      title: "Kundservice",
      isInternational: false,
      sourceUrl: "https://www.studentconsulting.com/sv/lediga-jobb/vasteras/kundservice/87581",
    };
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all() {
            return {
              results: [
                {
                  ...applicationRow({
                    automation_run_id: "manual:old",
                    last_attempt_no: 7,
                    last_attempt_error_code: "APPLICATION_FAILED",
                    last_attempt_error_message:
                      "APPLICATION_REQUIRES_INPUT: a required application field is empty.",
                  }),
                  raw_json: JSON.stringify(job),
                },
              ],
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(listRetryableFailedJobs(db, "2026-10", "manual:new")).resolves.toEqual([job]);
  });

  it("atomically requeues only one definite pre-submit failed application", async () => {
    const fake = claimDb(1);

    await expect(
      requeueFailedPreSubmitApplication(fake.db, {
        id: "application:studentconsulting:87544",
        runId: "manual:new",
        reportMonth: "2026-10",
      }),
    ).resolves.toBe(true);

    expect(fake.sql).toHaveLength(1);
    expect(fake.sql[0]).toContain("SET status = 'queued'");
    expect(fake.sql[0]).toContain("automation_run_id = ?");
    expect(fake.sql[0]).toContain("report_month = ?");
    expect(fake.sql[0]).toContain("status = 'failed'");
    expect(fake.sql[0]).toContain("applied_at IS NULL");
    expect(fake.sql[0]).toContain("verified_at IS NULL");
    expect(fake.sql[0]).toContain("APPLICATION_NOT_APPLIED");
    expect(fake.sql[0]).toContain("APPLICATION_REQUIRES_INPUT");
    expect(fake.sql[0]).not.toContain("aa.attempt_no < 5");
    expect(fake.binds[0]).toEqual([
      "2026-10",
      "manual:new",
      "application:studentconsulting:87544",
      "manual:new",
    ]);
  });

  it("rejects a lost retry race when no failed row was changed", async () => {
    const fake = claimDb(0);

    await expect(
      requeueFailedPreSubmitApplication(fake.db, {
        id: "application:studentconsulting:87544",
        runId: "manual:new",
        reportMonth: "2026-10",
      }),
    ).resolves.toBe(false);
  });
});

describe("uncertain application reconciliation", () => {
  const now = Date.parse("2026-10-02T13:10:00.000Z");

  it("keeps a possible submission blocked during the five-minute provider grace period", () => {
    expect(shouldDelayNotAppliedReclassification("2026-10-02T13:06:00.000Z", now)).toBe(true);
  });

  it("allows a definite not-applied result to release after the grace period", () => {
    expect(shouldDelayNotAppliedReclassification("2026-10-02T13:04:59.000Z", now)).toBe(false);
  });

  it("fails closed when the applied timestamp is missing or invalid", () => {
    expect(shouldDelayNotAppliedReclassification(null, now)).toBe(true);
    expect(shouldDelayNotAppliedReclassification("invalid", now)).toBe(true);
  });
});

describe("user-attention verification", () => {
  it("promotes only an applied unresolved application to verified", async () => {
    const fake = claimDb(1);

    await expect(
      verifyApplicationFromAttention(
        fake.db,
        "application:studentconsulting:87570",
        "2026-10-02T15:30:00.000Z",
      ),
    ).resolves.toBe(true);

    expect(fake.sql).toHaveLength(1);
    expect(fake.sql[0]).toContain("SET status = 'verified'");
    expect(fake.sql[0]).toContain("status = 'needs_user_action'");
    expect(fake.sql[0]).toContain("applied_at IS NOT NULL");
    expect(fake.sql[0]).toContain("verified_at IS NULL");
    expect(fake.sql[0]).toContain("s.state = 'uncertain'");
    expect(fake.binds[0]).toEqual([
      "2026-10-02T15:30:00.000Z",
      "application:studentconsulting:87570",
    ]);
  });

  it("rejects a lost attention-resolution race", async () => {
    const fake = claimDb(0);
    await expect(
      verifyApplicationFromAttention(
        fake.db,
        "application:studentconsulting:87570",
        "2026-10-02T15:30:00.000Z",
      ),
    ).resolves.toBe(false);
  });
});

describe("definite not-applied reconciliation", () => {
  function reclassifyDb(
    current: {
      status: string;
      applied_at: string | null;
      verified_at: string | null;
      slot_state: string;
    } | null,
    changes: [number, number] = [1, 1],
  ) {
    const sql: string[] = [];
    const binds: unknown[][] = [];

    const db = {
      prepare(statement: string) {
        sql.push(statement);
        return {
          bind(...values: unknown[]) {
            binds.push(values);
            return this;
          },
          async first() {
            return current;
          },
        };
      },
      async batch() {
        return changes.map((count) => ({ meta: { changes: count } }));
      },
    } as unknown as D1Database;

    return { db, sql, binds };
  }

  it("atomically frees an uncertain slot only after a definite not-applied result", async () => {
    const fake = reclassifyDb({
      status: "needs_user_action",
      applied_at: "2026-10-02T12:27:17.152Z",
      verified_at: null,
      slot_state: "uncertain",
    });

    await expect(
      reclassifyApplicationNotSubmitted(fake.db, "application:studentconsulting:87570"),
    ).resolves.toBe(true);

    expect(fake.sql.some((statement) => statement.includes("state = 'free'"))).toBe(true);
    expect(fake.sql.some((statement) => statement.includes("applied_at = NULL"))).toBe(true);
  });

  it("does not free a submitted or verified application", async () => {
    const fake = reclassifyDb({
      status: "submitted",
      applied_at: "2026-10-02T12:27:17.152Z",
      verified_at: null,
      slot_state: "submitted",
    });

    await expect(
      reclassifyApplicationNotSubmitted(fake.db, "application:studentconsulting:87570"),
    ).resolves.toBe(false);
    expect(fake.sql).toHaveLength(1);
  });
});

describe("automation run claims", () => {
  it("uses one atomic statement to reject overlapping active runs", async () => {
    const fake = claimDb(0);

    await expect(
      claimRunStart(fake.db, {
        id: "manual:2026-10:test",
        mode: "manual",
        applicationMonth: "2026-10",
        targetCount: 10,
      }),
    ).resolves.toBeNull();

    expect(fake.sql).toHaveLength(1);
    expect(fake.sql[0]).toContain("WHERE NOT EXISTS");
    expect(fake.sql[0]).toContain("active.status = 'running'");
    expect(fake.binds[0]).toEqual(["manual:2026-10:test", "manual", "2026-10", "2026-10", 10]);
  });

  it("resets a failed stable run to clean running state when the atomic claim succeeds", async () => {
    const claimedRow = runRow();
    const fake = claimDb(1, claimedRow);

    await expect(
      claimRunStart(fake.db, {
        id: "scheduled:2026-10",
        mode: "scheduled",
        applicationMonth: "2026-10",
        targetCount: 10,
      }),
    ).resolves.toEqual(claimedRow);

    expect(fake.sql[0]).toContain("ON CONFLICT(id) DO UPDATE SET");
    expect(fake.sql[0]).toContain("status = 'running'");
    expect(fake.sql[0]).toContain("verified_count = 0");
    expect(fake.sql[0]).toContain("workflow_instance_id = NULL");
    expect(fake.sql[0]).toContain("last_error = NULL");
    expect(fake.sql[0]).toContain("completed_at = NULL");
    expect(fake.sql[0]).toContain("WHERE automation_runs.status = 'failed'");
    expect(fake.sql[1]).toBe("SELECT * FROM automation_runs WHERE id = ?");
  });

  it("deletes only run-scoped auxiliary records and the run row", async () => {
    const statements: string[] = [];
    const binds: unknown[][] = [];
    let batchSize = 0;
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind(...values: unknown[]) {
            binds.push(values);
            return this;
          },
        };
      },
      async batch(items: unknown[]) {
        batchSize = items.length;
        return [];
      },
    } as unknown as D1Database;

    await deleteRunRecords(db, "manual:test");

    expect(batchSize).toBe(3);
    expect(statements).toEqual([
      "DELETE FROM notifications WHERE automation_run_id = ?",
      "DELETE FROM integration_probes WHERE automation_run_id = ?",
      "DELETE FROM automation_runs WHERE id = ?",
    ]);
    expect(binds).toEqual([["manual:test"], ["manual:test"], ["manual:test"]]);
  });

  it("reconciles orphaned unlinked runs globally before a new claim", async () => {
    let statement = "";
    let bindCalled = false;
    const db = {
      prepare(sql: string) {
        statement = sql;
        return {
          bind() {
            bindCalled = true;
            return this;
          },
          async run() {
            return { meta: { changes: 0 } };
          },
        };
      },
    } as unknown as D1Database;

    await failOrphanedRunningRuns(db);

    expect(statement).toContain("status = 'running'");
    expect(statement).toContain("workflow_instance_id IS NULL");
    expect(statement).toContain("datetime('now', '-5 minutes')");
    expect(statement).toContain("NOT EXISTS");
    expect(statement).not.toContain("application_month = ?");
    expect(bindCalled).toBe(false);
  });
});
