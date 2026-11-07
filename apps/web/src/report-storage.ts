export interface ReportApplicationRow {
  applicationId: string;
  externalId: string;
  title: string;
  employer: string | null;
  location: string | null;
  countryCode: string | null;
  isInternational: boolean;
  appliedAt: string;
  verifiedAt: string | null;
  rawJson: string | null;
}

export async function loadVerifiedReportApplications(
  db: D1Database,
  reportMonth: string,
): Promise<ReportApplicationRow[]> {
  const rows = await db
    .prepare(
      `SELECT a.id AS application_id, a.applied_at, a.verified_at,
              j.external_id, j.title, j.employer, j.location, j.country_code,
              j.is_international, j.raw_json
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       WHERE a.report_month = ?
         AND a.status = 'verified'
         AND a.applied_at IS NOT NULL
       ORDER BY a.applied_at, a.id`,
    )
    .bind(reportMonth)
    .all<{
      application_id: string;
      applied_at: string;
      verified_at: string | null;
      external_id: string;
      title: string;
      employer: string | null;
      location: string | null;
      country_code: string | null;
      is_international: number;
      raw_json: string | null;
    }>();

  return rows.results.map((row) => ({
    applicationId: row.application_id,
    externalId: row.external_id,
    title: row.title,
    employer: row.employer,
    location: row.location,
    countryCode: row.country_code,
    isInternational: Boolean(row.is_international),
    appliedAt: row.applied_at,
    verifiedAt: row.verified_at,
    rawJson: row.raw_json,
  }));
}
