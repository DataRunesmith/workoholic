import { MONTHLY_APPLICATION_TARGET } from "../../../packages/core/src/types";
import type { RuntimeConfigurationView } from "./runtime-config";
import { activityExportFileName, type ActivityReportExportRow } from "./activity-export";
import { currentMonthKey, isApplicationAutomationWindow } from "./time";

export interface VerifiedApplicationSlotRow {
  application_id: string;
  updated_at: string | null;
}

export function buildVerifiedQuotaSlots(
  verifiedApplications: readonly VerifiedApplicationSlotRow[],
  target: number = MONTHLY_APPLICATION_TARGET,
) {
  return Array.from({ length: target }, (_, index) => {
    const verifiedApplication = verifiedApplications[index];
    return verifiedApplication
      ? {
          slot_no: index + 1,
          application_id: verifiedApplication.application_id,
          state: "verified" as const,
          updated_at: verifiedApplication.updated_at,
        }
      : {
          slot_no: index + 1,
          application_id: null,
          state: "free" as const,
          updated_at: null,
        };
  });
}

interface DashboardRunState {
  status: string;
  application_month?: string | null;
  verified_count?: number | null;
  target_count?: number | null;
  workflow_instance_id?: string | null;
  application_count?: number | null;
  updated_at?: string | null;
}

const ORPHANED_RUN_AGE_MS = 5 * 60 * 1_000;

export function isOperationallyFailedDashboardRun(
  run: DashboardRunState,
  applicationMonth: string,
): boolean {
  return (
    run.application_month === applicationMonth &&
    run.status === "failed" &&
    Number(run.verified_count ?? 0) < Number(run.target_count ?? MONTHLY_APPLICATION_TARGET)
  );
}

export function isOrphanedDashboardRun(run: DashboardRunState, nowMs = Date.now()): boolean {
  if (run.status !== "running" || run.workflow_instance_id) return false;
  if (Number(run.application_count ?? 0) > 0) return false;
  if (!run.updated_at) return false;

  const timestamp = run.updated_at.includes("T")
    ? run.updated_at
    : `${run.updated_at.replace(" ", "T")}Z`;
  const updatedAtMs = Date.parse(timestamp);
  return Number.isFinite(updatedAtMs) && updatedAtMs <= nowMs - ORPHANED_RUN_AGE_MS;
}

export async function getDashboardData(db: D1Database, configuration: RuntimeConfigurationView) {
  const applicationMonth = currentMonthKey();

  const [
    progress,
    unresolvedApplications,
    verifiedApplications,
    runs,
    applications,
    notifications,
    failedNotifications,
    calendarApplications,
    activityExports,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS verified
         FROM applications
         WHERE report_month = ? AND status = 'verified'`,
      )
      .bind(applicationMonth)
      .first<{ verified: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM applications
         WHERE report_month = ? AND status = 'needs_user_action'`,
      )
      .bind(applicationMonth)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT id AS application_id, verified_at AS updated_at
         FROM applications
         WHERE report_month = ? AND status = 'verified'
         ORDER BY verified_at, id
         LIMIT ?`,
      )
      .bind(applicationMonth, MONTHLY_APPLICATION_TARGET)
      .all<VerifiedApplicationSlotRow>(),
    db
      .prepare(
        `SELECT r.id, r.mode, r.application_month, r.status,
                r.target_count, r.verified_count, r.workflow_instance_id,
                r.last_error, r.started_at, r.completed_at, r.updated_at,
                (SELECT COUNT(*) FROM applications a
                 WHERE a.automation_run_id = r.id) AS application_count,
                (SELECT p.status FROM integration_probes p
                 WHERE p.automation_run_id = r.id
                 LIMIT 1) AS probe_status,
                (SELECT p.error_message FROM integration_probes p
                 WHERE p.automation_run_id = r.id
                 LIMIT 1) AS probe_error
         FROM automation_runs r
         ORDER BY r.started_at DESC
         LIMIT 50`,
      )
      .all(),
    db
      .prepare(
        `SELECT a.id, a.automation_run_id, a.status, a.applied_at, a.verified_at,
                a.report_month, a.created_at, a.updated_at,
                j.external_id, j.title, j.employer, j.location, j.country_code,
                j.is_international, j.source_url,
                aa.error_code, aa.error_message,
                (SELECT COUNT(*) FROM evidence e WHERE e.application_id = a.id) AS evidence_count
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         LEFT JOIN application_attempts aa ON aa.id = (
           SELECT aa2.id FROM application_attempts aa2
           WHERE aa2.application_id = a.id
           ORDER BY aa2.attempt_no DESC LIMIT 1
         )
         ORDER BY COALESCE(a.verified_at, a.applied_at, a.created_at) DESC
         LIMIT 100`,
      )
      .all(),
    db
      .prepare(
        `SELECT id, automation_run_id, kind, channel, status, error_message, created_at
         FROM notifications
         ORDER BY created_at DESC
         LIMIT 50`,
      )
      .all(),
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM notifications
         WHERE status = 'failed'
           AND created_at >= datetime('now', '-30 days')`,
      )
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT report_month, applied_at, verified_at
         FROM applications
         WHERE status = 'verified' AND applied_at IS NOT NULL
         ORDER BY report_month, applied_at, id`,
      )
      .all(),
    db
      .prepare(
        `SELECT report_month, target_count, item_count, ready_at, created_at
         FROM activity_report_exports
         ORDER BY report_month DESC`,
      )
      .all<Omit<ActivityReportExportRow, "content_text">>(),
  ]);

  const quotaSlots = buildVerifiedQuotaSlots(verifiedApplications.results);

  const uncertainSlots = Number(unresolvedApplications?.count ?? 0);
  const dashboardRuns = runs.results.map((run) => {
    if (!run || typeof run !== "object" || !("status" in run)) return run;
    return {
      ...run,
      orphaned: isOrphanedDashboardRun(run as unknown as DashboardRunState),
    };
  });
  const orphanedRuns = dashboardRuns.filter(
    (run) => run && typeof run === "object" && "orphaned" in run && run.orphaned === true,
  ).length;
  const activeRun = dashboardRuns.find(
    (run) =>
      run &&
      typeof run === "object" &&
      "status" in run &&
      run.status === "running" &&
      (!("orphaned" in run) || run.orphaned !== true),
  );
  const latestApplicationRun = dashboardRuns.find(
    (run) =>
      run &&
      typeof run === "object" &&
      "application_month" in run &&
      run.application_month === applicationMonth,
  );
  const failedRuns =
    latestApplicationRun &&
    typeof latestApplicationRun === "object" &&
    "status" in latestApplicationRun &&
    isOperationallyFailedDashboardRun(
      latestApplicationRun as unknown as DashboardRunState,
      applicationMonth,
    )
      ? 1
      : 0;

  return {
    generatedAt: new Date().toISOString(),
    applicationMonth,
    target: MONTHLY_APPLICATION_TARGET,
    verified: Number(progress?.verified ?? 0),
    quotaUsed: Number(progress?.verified ?? 0),
    quotaSlots,
    applicationWindowOpen: isApplicationAutomationWindow(),
    activityCalendar: calendarApplications.results,
    activityExports: activityExports.results.map((row) => ({
      ...row,
      file_name: activityExportFileName(row),
    })),
    runs: dashboardRuns,
    applications: applications.results,
    notifications: notifications.results,
    attention: {
      uncertainSlots,
      failedRuns,
      failedNotifications: Number(failedNotifications?.count ?? 0),
      orphanedRuns,
      activeRun: activeRun ?? null,
    },
    configuration,
    automaticMode: {
      enabled: true,
      schedule: "10–13:e varje månad, en gång per dag mellan 10:00–20:00 Europe/Stockholm",
      applicationWindow: "1–14:e varje månad",
    },
  };
}

export async function getRunDetail(db: D1Database, runId: string) {
  const run = await db
    .prepare(
      `SELECT id, mode, application_month, status, target_count,
              verified_count, workflow_instance_id, last_error, started_at,
              completed_at, updated_at
       FROM automation_runs
       WHERE id = ?`,
    )
    .bind(runId)
    .first();

  if (!run) return null;

  const [applications, attempts, evidence, notifications, probe] = await Promise.all([
    db
      .prepare(
        `SELECT a.id, a.status, a.applied_at, a.verified_at, a.report_month,
                a.created_at, a.updated_at,
                j.external_id, j.title, j.employer, j.location, j.country_code,
                j.is_international, j.source_url
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         WHERE a.automation_run_id = ?
         ORDER BY a.created_at, a.id`,
      )
      .bind(runId)
      .all(),
    db
      .prepare(
        `SELECT aa.id, aa.application_id, aa.attempt_no, aa.status,
                aa.error_code, aa.error_message, aa.started_at, aa.finished_at
         FROM application_attempts aa
         JOIN applications a ON a.id = aa.application_id
         WHERE a.automation_run_id = ?
         ORDER BY aa.started_at, aa.attempt_no`,
      )
      .bind(runId)
      .all(),
    db
      .prepare(
        `SELECT e.id, e.application_id, e.kind, e.object_key, e.sha256, e.created_at
         FROM evidence e
         JOIN applications a ON a.id = e.application_id
         WHERE a.automation_run_id = ?
         ORDER BY e.created_at`,
      )
      .bind(runId)
      .all(),
    db
      .prepare(
        `SELECT id, kind, channel, status, error_message, created_at
         FROM notifications
         WHERE automation_run_id = ?
         ORDER BY created_at`,
      )
      .bind(runId)
      .all(),
    db
      .prepare(
        `SELECT id, integration, status, page_url, object_key, summary_json,
                error_message, created_at, updated_at
         FROM integration_probes
         WHERE automation_run_id = ?
         LIMIT 1`,
      )
      .bind(runId)
      .first(),
  ]);

  return {
    run,
    applications: applications.results,
    attempts: attempts.results,
    evidence: evidence.results,
    notifications: notifications.results,
    probe: probe ?? null,
  };
}
