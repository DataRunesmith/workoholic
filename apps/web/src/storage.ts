import type { JobCandidate } from "../../../packages/core/src/types";

export type RunMode = "manual" | "scheduled";
export type RunStatus = "running" | "completed" | "failed";

const NOT_APPLIED_RECONCILIATION_GRACE_MS = 5 * 60 * 1_000;

export function shouldDelayNotAppliedReclassification(
  appliedAt: string | null,
  nowMs = Date.now(),
): boolean {
  const appliedAtMs = appliedAt ? Date.parse(appliedAt) : Number.NaN;
  return !Number.isFinite(appliedAtMs) || nowMs - appliedAtMs < NOT_APPLIED_RECONCILIATION_GRACE_MS;
}

export interface AutomationRunRow {
  id: string;
  mode: RunMode;
  application_month: string;
  report_month: string;
  status: RunStatus;
  target_count: number;
  verified_count: number;
  workflow_instance_id: string | null;
  last_error: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
}

export function scheduledRunId(applicationMonth: string): string {
  return `scheduled:${applicationMonth}`;
}

export async function createRun(
  db: D1Database,
  input: {
    id: string;
    mode: RunMode;
    applicationMonth: string;
    targetCount: number;
    workflowInstanceId?: string;
  },
): Promise<AutomationRunRow> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO automation_runs
       (id, mode, application_month, report_month, status, target_count, workflow_instance_id)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    )
    .bind(
      input.id,
      input.mode,
      input.applicationMonth,
      input.applicationMonth,
      input.targetCount,
      input.workflowInstanceId ?? null,
    )
    .run();

  if (input.workflowInstanceId) {
    await db
      .prepare(
        `UPDATE automation_runs
         SET workflow_instance_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .bind(input.workflowInstanceId, input.id)
      .run();
  }

  const row = await getRun(db, input.id);
  if (!row) throw new Error("Failed to create automation run");
  return row;
}

export async function getRun(db: D1Database, id: string): Promise<AutomationRunRow | null> {
  return db
    .prepare("SELECT * FROM automation_runs WHERE id = ?")
    .bind(id)
    .first<AutomationRunRow>();
}

export async function failOrphanedRunningRuns(db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE automation_runs
       SET status = 'failed',
           last_error = COALESCE(
             last_error,
             'WORKFLOW_ORPHANED: körningen saknar kopplad workflow-instans och har ingen ansökningsaktivitet.'
           ),
           completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE status = 'running'
         AND workflow_instance_id IS NULL
         AND updated_at <= datetime('now', '-5 minutes')
         AND NOT EXISTS (
           SELECT 1
           FROM applications a
           WHERE a.automation_run_id = automation_runs.id
         )`,
    )
    .run();
}

export async function claimRunStart(
  db: D1Database,
  input: {
    id: string;
    mode: RunMode;
    applicationMonth: string;
    targetCount: number;
  },
): Promise<AutomationRunRow | null> {
  const claimed = await db
    .prepare(
      `INSERT INTO automation_runs
       (id, mode, application_month, report_month, status, target_count,
        verified_count, workflow_instance_id, last_error,
        started_at, completed_at, updated_at)
       SELECT ?, ?, ?, ?, 'running', ?, 0, NULL, NULL,
              CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP
       WHERE NOT EXISTS (
         SELECT 1
         FROM automation_runs active
         WHERE active.status = 'running'
       )
       ON CONFLICT(id) DO UPDATE SET
         mode = excluded.mode,
         application_month = excluded.application_month,
         report_month = excluded.report_month,
         status = 'running',
         target_count = excluded.target_count,
         verified_count = 0,
         workflow_instance_id = NULL,
         last_error = NULL,
         started_at = CURRENT_TIMESTAMP,
         completed_at = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE automation_runs.status = 'failed'`,
    )
    .bind(input.id, input.mode, input.applicationMonth, input.applicationMonth, input.targetCount)
    .run();

  if ((claimed.meta.changes ?? 0) === 0) return null;
  return getRun(db, input.id);
}

export async function deleteRunRecords(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM notifications WHERE automation_run_id = ?").bind(id),
    db.prepare("DELETE FROM integration_probes WHERE automation_run_id = ?").bind(id),
    db.prepare("DELETE FROM automation_runs WHERE id = ?").bind(id),
  ]);
}

export async function updateRun(
  db: D1Database,
  id: string,
  patch: Partial<{
    status: RunStatus;
    verifiedCount: number;
    workflowInstanceId: string | null;
    lastError: string | null;
    completedAt: string | null;
  }>,
): Promise<void> {
  const assignments: string[] = ["updated_at = CURRENT_TIMESTAMP"];
  const values: unknown[] = [];

  const add = (column: string, value: unknown) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.status !== undefined) add("status", patch.status);
  if (patch.verifiedCount !== undefined) add("verified_count", patch.verifiedCount);
  if (patch.workflowInstanceId !== undefined) add("workflow_instance_id", patch.workflowInstanceId);
  if (patch.lastError !== undefined) add("last_error", patch.lastError);
  if (patch.completedAt !== undefined) add("completed_at", patch.completedAt);

  values.push(id);
  await db
    .prepare(`UPDATE automation_runs SET ${assignments.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function countVerifiedApplications(db: D1Database, month: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM applications
       WHERE report_month = ? AND status = 'verified'`,
    )
    .bind(month)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export interface ApplicationForJobRow {
  id: string;
  status: string;
  applied_at: string | null;
  verified_at: string | null;
  automation_run_id: string | null;
  report_month: string;
  last_attempt_no: number | null;
  last_attempt_error_code: string | null;
  last_attempt_error_message: string | null;
}

export async function getApplicationForJob(
  db: D1Database,
  provider: string,
  externalId: string,
): Promise<ApplicationForJobRow | null> {
  return db
    .prepare(
      `SELECT a.id, a.status, a.applied_at, a.verified_at,
              a.automation_run_id, a.report_month,
              (
                SELECT aa.attempt_no
                FROM application_attempts aa
                WHERE aa.application_id = a.id
                ORDER BY aa.attempt_no DESC
                LIMIT 1
              ) AS last_attempt_no,
              (
                SELECT aa.error_code
                FROM application_attempts aa
                WHERE aa.application_id = a.id
                ORDER BY aa.attempt_no DESC
                LIMIT 1
              ) AS last_attempt_error_code,
              (
                SELECT aa.error_message
                FROM application_attempts aa
                WHERE aa.application_id = a.id
                ORDER BY aa.attempt_no DESC
                LIMIT 1
              ) AS last_attempt_error_message
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       WHERE j.provider = ? AND j.external_id = ?
       LIMIT 1`,
    )
    .bind(provider, externalId)
    .first<ApplicationForJobRow>();
}

export function isRetryablePreSubmitFailure(
  application: ApplicationForJobRow,
  runId: string,
): boolean {
  if (
    application.status !== "failed" ||
    application.applied_at !== null ||
    application.verified_at !== null
  ) {
    return false;
  }

  if (application.automation_run_id === runId) return true;

  if (application.last_attempt_error_code === "APPLICATION_NOT_APPLIED") {
    return true;
  }

  if (application.last_attempt_error_code !== "APPLICATION_FAILED") {
    return false;
  }

  if (
    application.last_attempt_error_message?.startsWith(
      "STUDENTCONSULTING_LOGIN_FORM_NOT_FOUND:",
    ) === true
  ) {
    return true;
  }

  return application.last_attempt_error_message?.startsWith("APPLICATION_REQUIRES_INPUT:") === true;
}

export async function listRetryableFailedJobs(
  db: D1Database,
  reportMonth: string,
  runId: string,
): Promise<JobCandidate[]> {
  const rows = await db
    .prepare(
      `SELECT a.id, a.status, a.applied_at, a.verified_at,
              a.automation_run_id, a.report_month, j.raw_json,
              (
                SELECT aa.attempt_no
                FROM application_attempts aa
                WHERE aa.application_id = a.id
                ORDER BY aa.attempt_no DESC
                LIMIT 1
              ) AS last_attempt_no,
              (
                SELECT aa.error_code
                FROM application_attempts aa
                WHERE aa.application_id = a.id
                ORDER BY aa.attempt_no DESC
                LIMIT 1
              ) AS last_attempt_error_code,
              (
                SELECT aa.error_message
                FROM application_attempts aa
                WHERE aa.application_id = a.id
                ORDER BY aa.attempt_no DESC
                LIMIT 1
              ) AS last_attempt_error_message
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       WHERE a.report_month = ?
         AND a.status = 'failed'
         AND a.applied_at IS NULL
         AND a.verified_at IS NULL
       ORDER BY a.updated_at, a.id
       LIMIT 50`,
    )
    .bind(reportMonth)
    .all<ApplicationForJobRow & { raw_json: string | null }>();

  const jobs: JobCandidate[] = [];
  for (const row of rows.results) {
    if (!isRetryablePreSubmitFailure(row, runId) || !row.raw_json) continue;
    try {
      const job = JSON.parse(row.raw_json) as JobCandidate;
      if (job.provider === "studentconsulting") jobs.push(job);
    } catch {
      // Invalid persisted payload is not safe to retry.
    }
  }
  return jobs;
}

export async function requeueFailedPreSubmitApplication(
  db: D1Database,
  input: {
    id: string;
    runId: string;
    reportMonth: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE applications
       SET status = 'queued',
           report_month = ?,
           automation_run_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND status = 'failed'
         AND applied_at IS NULL
         AND verified_at IS NULL
         AND (
           automation_run_id = ?
           OR EXISTS (
             SELECT 1
             FROM application_attempts aa
             WHERE aa.application_id = applications.id
               AND aa.attempt_no = (
                 SELECT MAX(latest.attempt_no)
                 FROM application_attempts latest
                 WHERE latest.application_id = applications.id
               )
               AND (
                 aa.error_code = 'APPLICATION_NOT_APPLIED'
                 OR (
                   aa.error_code = 'APPLICATION_FAILED'
                   AND (
                     aa.error_message LIKE 'STUDENTCONSULTING_LOGIN_FORM_NOT_FOUND:%'
                     OR aa.error_message LIKE 'APPLICATION_REQUIRES_INPUT:%'
                   )
                 )
               )
           )
         )`,
    )
    .bind(input.reportMonth, input.runId, input.id, input.runId)
    .run();

  return Number(result.meta.changes ?? 0) === 1;
}

export async function verifyApplicationFromAttention(
  db: D1Database,
  applicationId: string,
  verifiedAt: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE applications
       SET status = 'verified',
           verified_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND status = 'needs_user_action'
         AND applied_at IS NOT NULL
         AND verified_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM monthly_application_slots s
           WHERE s.application_id = applications.id
             AND s.state = 'uncertain'
         )`,
    )
    .bind(verifiedAt, applicationId)
    .run();

  return Number(result.meta.changes ?? 0) === 1;
}

export async function reclassifyApplicationNotSubmitted(
  db: D1Database,
  applicationId: string,
): Promise<boolean> {
  const current = await db
    .prepare(
      `SELECT a.status, a.applied_at, a.verified_at, s.state AS slot_state
       FROM applications a
       JOIN monthly_application_slots s ON s.application_id = a.id
       WHERE a.id = ?
       LIMIT 1`,
    )
    .bind(applicationId)
    .first<{
      status: string;
      applied_at: string | null;
      verified_at: string | null;
      slot_state: string;
    }>();

  if (
    !current ||
    current.status !== "needs_user_action" ||
    current.applied_at === null ||
    current.verified_at !== null ||
    current.slot_state !== "uncertain"
  ) {
    return false;
  }

  const [applicationResult, slotResult] = await db.batch([
    db
      .prepare(
        `UPDATE applications
         SET status = 'failed',
             applied_at = NULL,
             verified_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND status = 'needs_user_action'
           AND applied_at IS NOT NULL
           AND verified_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM monthly_application_slots s
             WHERE s.application_id = applications.id
               AND s.state = 'uncertain'
           )`,
      )
      .bind(applicationId),
    db
      .prepare(
        `UPDATE monthly_application_slots
         SET application_id = NULL,
             reservation_owner = NULL,
             state = 'free',
             updated_at = CURRENT_TIMESTAMP
         WHERE application_id = ?
           AND state = 'uncertain'
           AND EXISTS (
             SELECT 1
             FROM applications a
             WHERE a.id = ?
               AND a.status = 'failed'
               AND a.applied_at IS NULL
               AND a.verified_at IS NULL
           )`,
      )
      .bind(applicationId, applicationId),
  ]);

  return (
    Number(applicationResult.meta.changes ?? 0) === 1 && Number(slotResult.meta.changes ?? 0) === 1
  );
}

export async function persistJob(db: D1Database, job: JobCandidate): Promise<string> {
  const id = `${job.provider}:${job.externalId}`;
  await db
    .prepare(
      `INSERT INTO jobs
       (id, provider, external_id, title, employer, location, country_code,
        is_international, source_url, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, external_id) DO UPDATE SET
         title = excluded.title,
         employer = excluded.employer,
         location = excluded.location,
         country_code = excluded.country_code,
         is_international = excluded.is_international,
         source_url = excluded.source_url,
         raw_json = excluded.raw_json`,
    )
    .bind(
      id,
      job.provider,
      job.externalId,
      job.title,
      job.employer ?? null,
      job.location ?? null,
      job.countryCode ?? null,
      job.isInternational ? 1 : 0,
      job.sourceUrl,
      JSON.stringify(job),
    )
    .run();
  return id;
}

export async function createApplication(
  db: D1Database,
  input: {
    id: string;
    jobId: string;
    runId: string;
    reportMonth: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO applications
       (id, job_id, automation_run_id, status, report_month)
       VALUES (?, ?, ?, 'queued', ?)`,
    )
    .bind(input.id, input.jobId, input.runId, input.reportMonth)
    .run();
}

export async function setApplicationStatus(
  db: D1Database,
  id: string,
  status: "queued" | "applying" | "submitted" | "verified" | "failed" | "needs_user_action",
  options: { appliedAt?: string; verifiedAt?: string } = {},
): Promise<void> {
  await db
    .prepare(
      `UPDATE applications
       SET status = ?,
           applied_at = COALESCE(?, applied_at),
           verified_at = COALESCE(?, verified_at),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(status, options.appliedAt ?? null, options.verifiedAt ?? null, id)
    .run();
}

export async function nextAttemptNumber(db: D1Database, applicationId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next FROM application_attempts WHERE application_id = ?",
    )
    .bind(applicationId)
    .first<{ next: number }>();
  return Number(row?.next ?? 1);
}

export async function startAttempt(
  db: D1Database,
  applicationId: string,
  attemptNo: number,
): Promise<string> {
  const id = `${applicationId}:attempt:${attemptNo}`;
  await db
    .prepare(
      `INSERT INTO application_attempts
       (id, application_id, attempt_no, status)
       VALUES (?, ?, ?, 'started')`,
    )
    .bind(id, applicationId, attemptNo)
    .run();
  return id;
}

export async function finishAttempt(
  db: D1Database,
  attemptId: string,
  status: "submitted" | "verified" | "failed" | "unknown",
  errorCode?: string,
  errorMessage?: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE application_attempts
       SET status = ?, error_code = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(status, errorCode ?? null, errorMessage ?? null, attemptId)
    .run();
}

export async function addEvidence(
  db: D1Database,
  input: { id: string; applicationId: string; kind: string; objectKey: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO evidence (id, application_id, kind, object_key)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(input.id, input.applicationId, input.kind, input.objectKey)
    .run();
}

export async function recordNotification(
  db: D1Database,
  input: {
    id: string;
    runId: string | null;
    kind: "export_email";
    channel: "email";
    status: "sent" | "failed";
    error?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notifications
       (id, automation_run_id, kind, channel, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.id, input.runId, input.kind, input.channel, input.status, input.error ?? null)
    .run();
}
