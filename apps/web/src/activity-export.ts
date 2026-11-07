import { MONTHLY_APPLICATION_TARGET, type JobCandidate } from "../../../packages/core/src/types";
import { loadVerifiedReportApplications, type ReportApplicationRow } from "./report-storage";
import { stockholmDateKey } from "./time";

export interface ActivityReportExportRow {
  report_month: string;
  target_count: number;
  item_count: number;
  content_text: string;
  ready_at: string;
  created_at: string;
}

// Rows written before the job type/scope rework lack this label and are rebuilt once.
const CURRENT_FORMAT_LABEL = "Jobbtyp: ";

const ROLE_WORD =
  /^[a-zåäöæø]*(?:förare|arbetare|medarbetare|medarbeider|arbeider|tekniker|operatör|operatør|mottagare|säljare|biträde|plockare|chaufför|sjåfør|montör|montør|städare|assistent|handläggare|lagerist|vaktmästare|elektriker|mekaniker|kock|servitör|rådgivare|agent)$/u;

function parseJob(rawJson: string | null): Partial<JobCandidate> {
  if (!rawJson) return {};
  try {
    return JSON.parse(rawJson) as JobCandidate;
  } catch {
    // Old rows may contain malformed/legacy payloads.
    return {};
  }
}

const capitalize = (value: string) => value.charAt(0).toLocaleUpperCase("sv-SE") + value.slice(1);

/**
 * The kind of job, e.g. "Truckförare". A specific occupation wins; a broad
 * category such as "Logistik / Transport" gives way to the role named in the title.
 */
export function activityJobType(rawJson: string | null, title: string): string {
  const occupation = parseJob(rawJson).occupation?.trim();
  if (occupation && !occupation.includes("/")) return occupation;
  const role = title
    .toLocaleLowerCase("sv-SE")
    .split(/[^a-zåäöæø]+/u)
    .find((word) => ROLE_WORD.test(word));
  return role ? capitalize(role) : title;
}

export function activityScope(rawJson: string | null, title: string): string {
  const scope = parseJob(rawJson).scope?.trim();
  if (scope) return scope;

  const normalized = title.toLocaleLowerCase("sv-SE");
  if (/(^|[^a-zåäö])heltid([^a-zåäö]|$)/u.test(normalized)) return "Heltid";
  if (/(^|[^a-zåäö])deltid([^a-zåäö]|$)/u.test(normalized)) return "Deltid";
  if (/extrajobb|(^|[^a-zåäö])extra([^a-zåäö]|$)/u.test(normalized)) return "Extrajobb";
  return "Kontrollera annonsen";
}

export function buildActivityReportText(applications: readonly ReportApplicationRow[]): string {
  return applications
    .map((application) =>
      [
        `Jobb-ID: ${application.externalId}`,
        `${CURRENT_FORMAT_LABEL}${activityJobType(application.rawJson, application.title)}`,
        `Stad: ${application.location ?? ""}`,
        `Omfattning: ${activityScope(application.rawJson, application.title)}`,
      ].join("\n"),
    )
    .join("\n\n")
    .concat("\n");
}

/** File name carries the day the month's tenth application was verified. */
export function activityExportFileName(row: Pick<ActivityReportExportRow, "ready_at">): string {
  return `jobbansokningar_${stockholmDateKey(row.ready_at)}.txt`;
}

export async function ensureMonthlyActivityExport(
  db: D1Database,
  reportMonth: string,
  applications: readonly ReportApplicationRow[],
): Promise<{ row: ActivityReportExportRow; created: boolean } | null> {
  const existing = await getMonthlyActivityExport(db, reportMonth);
  if (existing) return { row: existing, created: false };
  if (applications.length < MONTHLY_APPLICATION_TARGET) return null;

  const selected = applications.slice(0, MONTHLY_APPLICATION_TARGET);
  const readyAt = selected.reduce((latest, application) => {
    const value = application.verifiedAt ?? application.appliedAt;
    return Date.parse(value) > Date.parse(latest) ? value : latest;
  }, selected[0].verifiedAt ?? selected[0].appliedAt);

  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO activity_report_exports
       (report_month, target_count, item_count, content_text, ready_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      reportMonth,
      MONTHLY_APPLICATION_TARGET,
      selected.length,
      buildActivityReportText(selected),
      readyAt,
    )
    .run();

  const row = await getMonthlyActivityExport(db, reportMonth);
  return row ? { row, created: (inserted.meta.changes ?? 0) > 0 } : null;
}

/**
 * The month's export for download or e-mail: created on first need once the
 * month has ten verified applications, and rebuilt once if it predates the
 * current format.
 */
export async function loadActivityExport(
  db: D1Database,
  reportMonth: string,
): Promise<ActivityReportExportRow | null> {
  const existing = await getMonthlyActivityExport(db, reportMonth);
  if (existing?.content_text.includes(CURRENT_FORMAT_LABEL)) return existing;

  const applications = await loadVerifiedReportApplications(db, reportMonth);
  if (!existing)
    return (await ensureMonthlyActivityExport(db, reportMonth, applications))?.row ?? null;

  const content = buildActivityReportText(applications.slice(0, existing.item_count));
  await db
    .prepare("UPDATE activity_report_exports SET content_text = ? WHERE report_month = ?")
    .bind(content, reportMonth)
    .run();
  return { ...existing, content_text: content };
}

export async function getMonthlyActivityExport(
  db: D1Database,
  reportMonth: string,
): Promise<ActivityReportExportRow | null> {
  return db
    .prepare(
      `SELECT report_month, target_count, item_count, content_text, ready_at, created_at
       FROM activity_report_exports
       WHERE report_month = ?`,
    )
    .bind(reportMonth)
    .first<ActivityReportExportRow>();
}
