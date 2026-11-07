import { MONTHLY_APPLICATION_TARGET, type JobCandidate } from "../../../packages/core/src/types";
import type { StudentConsultingHistoricalApplication } from "../../../packages/studentconsulting/src/provider";
import { buildActivityReportText } from "./activity-export";
import { loadVerifiedReportApplications } from "./report-storage";
import { withStudentConsultingProvider, type ProviderEnv } from "./providers";
import { getApplicationForJob, persistJob } from "./storage";

export interface HistoricalBackfillEnv extends ProviderEnv {
  DB: D1Database;
}

export interface StudentConsultingBackfillResult {
  month: string;
  observed: number;
  imported: number;
  externalIds: string[];
  exportCreated: boolean;
}

export async function backfillStudentConsultingMonth(
  env: HistoricalBackfillEnv,
  month: string,
): Promise<StudentConsultingBackfillResult> {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("BACKFILL_MONTH_INVALID");
  }

  const history = await withStudentConsultingProvider(env, async (provider) => {
    const auth = await provider.authenticate();
    if (auth.status !== "authenticated") {
      throw new Error(
        `STUDENTCONSULTING_BACKFILL_AUTH_FAILED: ${
          "message" in auth && auth.message ? auth.message : auth.status
        }`,
      );
    }
    return provider.loadApplicationHistory(month);
  });

  if (history.length === 0) {
    throw new Error(`STUDENTCONSULTING_BACKFILL_EMPTY: no applications found for ${month}`);
  }

  const ordered = [...history].sort((left, right) => {
    const time = Date.parse(left.applicationTime) - Date.parse(right.applicationTime);
    if (Number.isFinite(time) && time !== 0) return time;
    return left.externalId.localeCompare(right.externalId, "sv");
  });
  const verifiedAt = new Date().toISOString();
  let imported = 0;

  for (const application of ordered) {
    const appliedAt = normalizeApplicationTime(application.applicationTime, month);
    const existing = await getApplicationForJob(
      env.DB,
      "studentconsulting",
      application.externalId,
    );
    if (existing && existing.report_month !== month) {
      throw new Error(
        `BACKFILL_MONTH_CONFLICT: StudentConsulting ${application.externalId} already belongs to ${existing.report_month}`,
      );
    }

    const job = toJobCandidate(application);
    const jobId = await persistJob(env.DB, job);
    const applicationId = existing?.id ?? `history:studentconsulting:${application.externalId}`;

    await env.DB.prepare(
      `INSERT INTO applications
         (id, job_id, status, applied_at, verified_at, report_month, automation_run_id)
         VALUES (?, ?, 'verified', ?, ?, ?, NULL)
         ON CONFLICT(job_id) DO UPDATE SET
           status = 'verified',
           applied_at = COALESCE(applications.applied_at, excluded.applied_at),
           verified_at = COALESCE(applications.verified_at, excluded.verified_at),
           updated_at = CURRENT_TIMESTAMP`,
    )
      .bind(applicationId, jobId, appliedAt, verifiedAt, month)
      .run();

    await env.DB.prepare(
      `INSERT OR IGNORE INTO application_attempts
         (id, application_id, attempt_no, status, started_at, finished_at)
         VALUES (?, ?, 1, 'verified', ?, ?)`,
    )
      .bind(`history-attempt:${application.externalId}`, applicationId, appliedAt, verifiedAt)
      .run();
    imported += 1;
  }

  const verified = await loadVerifiedReportApplications(env.DB, month);
  const exportCreated = await ensureHistoricalExport(env.DB, month, verified);

  return {
    month,
    observed: history.length,
    imported,
    externalIds: ordered.map((application) => application.externalId),
    exportCreated,
  };
}

function toJobCandidate(application: StudentConsultingHistoricalApplication): JobCandidate {
  const country = normalizeCountry(application.country, application.countryCode);
  const scope = normalizeScope(application.scope, application.title);
  const sourceUrl = `https://www.studentconsulting.com/redirect-job?id=${encodeURIComponent(
    application.externalId,
  )}&language=sv-SE`;
  return {
    provider: "studentconsulting",
    externalId: application.externalId,
    title: application.title,
    employer: "StudentConsulting",
    location: application.location,
    country: country.country,
    countryCode: country.countryCode,
    isInternational: country.countryCode ? country.countryCode !== "SE" : false,
    occupation: application.occupation,
    scope,
    applicationUrl: sourceUrl,
    applicationReference: `studentconsulting-history:${application.externalId}`,
    sourceUrl,
  };
}

function normalizeCountry(
  country?: string,
  countryCode?: string,
): { country?: string; countryCode?: string } {
  const code = countryCode?.trim().toUpperCase();
  if (code === "SE" || code === "SWE" || code === "752") {
    return { country: country?.trim() || "Sverige", countryCode: "SE" };
  }
  if (code === "NO" || code === "NOR" || code === "578") {
    return { country: country?.trim() || "Norge", countryCode: "NO" };
  }
  if (code === "DK" || code === "DNK" || code === "208") {
    return { country: country?.trim() || "Danmark", countryCode: "DK" };
  }
  const normalized = country?.trim().toLocaleLowerCase("sv-SE") ?? "";
  if (normalized === "sverige" || normalized === "sweden") {
    return { country: country?.trim() || "Sverige", countryCode: "SE" };
  }
  if (normalized === "norge" || normalized === "norway") {
    return { country: country?.trim() || "Norge", countryCode: "NO" };
  }
  if (normalized === "danmark" || normalized === "denmark") {
    return { country: country?.trim() || "Danmark", countryCode: "DK" };
  }
  return { country: country?.trim() || undefined, countryCode: code || undefined };
}

function normalizeScope(scope: string | undefined, title: string): string {
  const value = scope?.trim();
  const normalized = value?.toLocaleLowerCase("sv-SE") ?? "";
  if (/full.?time|heltid/.test(normalized)) return "Heltid";
  if (/part.?time|deltid|extra/.test(normalized)) return "Deltid/Extra";
  const titleNormalized = title.toLocaleLowerCase("sv-SE");
  if (/(^|[^a-zåäö])heltid([^a-zåäö]|$)/u.test(titleNormalized)) return "Heltid";
  if (/(^|[^a-zåäö])deltid([^a-zåäö]|$)/u.test(titleNormalized)) return "Deltid/Extra";
  return value || "Kontrollera annonsen";
}

function normalizeApplicationTime(value: string, month: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`BACKFILL_APPLICATION_TIME_INVALID: ${value}`);
  }
  const key = `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}`;
  if (key !== month && !value.startsWith(month)) {
    throw new Error(`BACKFILL_APPLICATION_TIME_OUTSIDE_MONTH: ${value}`);
  }
  return parsed.toISOString();
}

async function ensureHistoricalExport(
  db: D1Database,
  month: string,
  applications: Awaited<ReturnType<typeof loadVerifiedReportApplications>>,
): Promise<boolean> {
  if (applications.length < MONTHLY_APPLICATION_TARGET) return false;
  const existing = await db
    .prepare("SELECT report_month FROM activity_report_exports WHERE report_month = ?")
    .bind(month)
    .first<{ report_month: string }>();
  if (existing) return false;

  const selected = applications.slice(0, MONTHLY_APPLICATION_TARGET);
  const readyAt = selected[MONTHLY_APPLICATION_TARGET - 1].appliedAt;
  await db
    .prepare(
      `INSERT INTO activity_report_exports
       (report_month, target_count, item_count, content_text, ready_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      month,
      MONTHLY_APPLICATION_TARGET,
      selected.length,
      buildActivityReportText(selected),
      readyAt,
    )
    .run();
  return true;
}
