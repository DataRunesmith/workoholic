import { MONTHLY_APPLICATION_TARGET, type JobCandidate } from "../../../packages/core/src/types";
import type { StudentConsultingProvider } from "../../../packages/studentconsulting/src/provider";
import { emailActivityExport, exportEmailConfigured, type NotificationEnv } from "./notifier";
import { activityExportFileName, ensureMonthlyActivityExport } from "./activity-export";
import { evaluateSuitability, type SuitabilityEnv } from "./policy";
import { loadVerifiedReportApplications } from "./report-storage";
import { withStudentConsultingProvider, type ProviderEnv } from "./providers";
import {
  claimMonthlyApplicationSlot,
  countOccupiedMonthlyApplicationSlots,
  reconcileMonthlyApplicationSlotState,
  releaseMonthlyApplicationSlot,
  setOwnedMonthlyApplicationSlotState,
} from "./quota";
import {
  addEvidence,
  countVerifiedApplications,
  createApplication,
  createRun,
  finishAttempt,
  getApplicationForJob,
  isRetryablePreSubmitFailure,
  listRetryableFailedJobs,
  nextAttemptNumber,
  persistJob,
  reclassifyApplicationNotSubmitted,
  requeueFailedPreSubmitApplication,
  scheduledRunId,
  shouldDelayNotAppliedReclassification,
  setApplicationStatus,
  startAttempt,
  updateRun,
  verifyApplicationFromAttention,
  type RunMode,
} from "./storage";
import { currentMonthKey, isApplicationAutomationWindow, isScheduledSafetyWindow } from "./time";

export interface AutomationEnv extends ProviderEnv, NotificationEnv, SuitabilityEnv {
  DB: D1Database;
  EVIDENCE: R2Bucket;
}

export interface AutomationResult {
  runId: string;
  status: "skipped" | "completed" | "failed";
  applicationMonth: string;
  verifiedCount: number;
  message?: string;
}

export async function executeAutomation(
  env: AutomationEnv,
  input: { mode: RunMode; runId?: string; now?: Date },
): Promise<AutomationResult> {
  const clock = () => input.now ?? new Date();
  const now = clock();
  const applicationMonth = currentMonthKey(now);

  if (!isApplicationAutomationWindow(now)) {
    return {
      runId:
        input.runId ??
        (input.mode === "scheduled"
          ? scheduledRunId(applicationMonth)
          : `manual:${applicationMonth}:${crypto.randomUUID()}`),
      status: "skipped",
      applicationMonth,
      verifiedCount: await countVerifiedApplications(env.DB, applicationMonth),
      message:
        "Job application automation is disabled outside the 1st–14th Europe/Stockholm monthly window.",
    };
  }

  if (input.mode === "scheduled" && !isScheduledSafetyWindow(now)) {
    return {
      runId: input.runId ?? scheduledRunId(applicationMonth),
      status: "skipped",
      applicationMonth,
      verifiedCount: await countVerifiedApplications(env.DB, applicationMonth),
      message: "Outside the autonomous fallback window: 10th–13th, 10:00–20:00 Europe/Stockholm.",
    };
  }

  const runId =
    input.runId ??
    (input.mode === "scheduled"
      ? scheduledRunId(applicationMonth)
      : `manual:${applicationMonth}:${crypto.randomUUID()}`);

  const run = await createRun(env.DB, {
    id: runId,
    mode: input.mode,
    applicationMonth,
    targetCount: MONTHLY_APPLICATION_TARGET,
  });

  if (run.status === "completed") {
    return {
      runId,
      status: "completed",
      applicationMonth,
      verifiedCount: run.verified_count,
    };
  }

  await updateRun(env.DB, runId, { status: "running", lastError: null });

  let verifiedCount = await countVerifiedApplications(env.DB, applicationMonth);
  if (verifiedCount < MONTHLY_APPLICATION_TARGET) {
    const applicationResult = await fillMonthlyApplicationTarget(
      env,
      runId,
      applicationMonth,
      verifiedCount,
      () => {
        const executionTime = clock();
        return (
          isApplicationAutomationWindow(executionTime) &&
          (input.mode !== "scheduled" || isScheduledSafetyWindow(executionTime))
        );
      },
    );
    verifiedCount = applicationResult.verifiedCount;

    await updateRun(env.DB, runId, { verifiedCount });

    if (verifiedCount < MONTHLY_APPLICATION_TARGET) {
      const occupiedSlots = await countOccupiedMonthlyApplicationSlots(env.DB, applicationMonth);
      const message =
        applicationResult.error ??
        `Only ${verifiedCount}/${MONTHLY_APPLICATION_TARGET} verified applications are available; ${occupiedSlots}/${MONTHLY_APPLICATION_TARGET} quota slots are occupied.`;
      await updateRun(env.DB, runId, {
        status: "failed",
        lastError: message,
        completedAt: new Date().toISOString(),
      });
      return {
        runId,
        status: "failed",
        applicationMonth,
        verifiedCount,
        message,
      };
    }
  }

  const currentMonthApplications = await loadVerifiedReportApplications(env.DB, applicationMonth);
  const monthlyExport = await ensureMonthlyActivityExport(
    env.DB,
    applicationMonth,
    currentMonthApplications,
  );
  if (monthlyExport?.created) await emailNewExport(env, monthlyExport.row, runId);

  await updateRun(env.DB, runId, {
    status: "completed",
    verifiedCount,
    completedAt: new Date().toISOString(),
  });
  return {
    runId,
    status: "completed",
    applicationMonth,
    verifiedCount,
    message: `Månadsmålet är uppnått: ${Math.min(verifiedCount, MONTHLY_APPLICATION_TARGET)}/${MONTHLY_APPLICATION_TARGET} ansökningar.${monthlyExport ? ` Månadsfilen ${activityExportFileName(monthlyExport.row)} är klar.` : ""}`,
  };
}

/** A new monthly .txt goes out by e-mail when recipients are set; a failed send never fails the run. */
async function emailNewExport(
  env: AutomationEnv,
  row: Parameters<typeof emailActivityExport>[1],
  runId: string | null,
): Promise<void> {
  if (!exportEmailConfigured(env)) return;
  try {
    await emailActivityExport(env, row, runId);
  } catch (error) {
    console.error("Monthly export e-mail failed", {
      month: row.report_month,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function fillMonthlyApplicationTarget(
  env: AutomationEnv,
  runId: string,
  applicationMonth: string,
  startingVerifiedCount: number,
  canSubmitNow: () => boolean,
): Promise<{ verifiedCount: number; error?: string }> {
  if (env.STUDENTCONSULTING_AUTOSUBMIT !== "true") {
    return {
      verifiedCount: startingVerifiedCount,
      error:
        "StudentConsulting autosubmit is disabled. Set STUDENTCONSULTING_AUTOSUBMIT=true after validating account configuration.",
    };
  }

  if (!canSubmitNow()) {
    return {
      verifiedCount: startingVerifiedCount,
      error:
        "Application window closed before automation execution; no StudentConsulting submission was attempted.",
    };
  }

  return withStudentConsultingProvider(env, async (provider) => {
    const auth = await provider.authenticate();
    if (auth.status !== "authenticated") {
      return {
        verifiedCount: startingVerifiedCount,
        error:
          auth.status === "failed"
            ? `${auth.code}: ${auth.message}`
            : "StudentConsulting authentication did not complete.",
      };
    }

    let verifiedCount = await reconcilePendingApplications(env, provider, applicationMonth, runId);
    if (verifiedCount >= MONTHLY_APPLICATION_TARGET) {
      return { verifiedCount };
    }

    const occupiedBefore = await countOccupiedMonthlyApplicationSlots(env.DB, applicationMonth);
    if (occupiedBefore >= MONTHLY_APPLICATION_TARGET) {
      const safetyHolds = Math.max(0, occupiedBefore - verifiedCount);
      return {
        verifiedCount,
        error:
          `${safetyHolds} ansökningar väntar fortfarande på säker verifiering och bara ${verifiedCount}/${MONTHLY_APPLICATION_TARGET} är godkända. ` +
          "De osäkra ansökningarna räknas inte som godkända platser, men nya skick stoppas tills de har verifierats eller markerats som inte inskickade.",
      };
    }

    const [retryableFailed, discovered] = await Promise.all([
      listRetryableFailedJobs(env.DB, applicationMonth, runId),
      provider.discover(),
    ]);
    const rejectionCounts = new Map<string, number>();
    const candidates = [
      ...new Map(
        [...retryableFailed, ...discovered].map(
          (job) => [`${job.provider}:${job.externalId}`, job] as const,
        ),
      ).values(),
    ];
    const suitable = candidates.filter((job) => {
      const assessment = evaluateSuitability(env, job);
      if (assessment.suitable) return true;
      for (const reason of assessment.reasons) {
        rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
      }
      return false;
    });
    console.info("StudentConsulting discovery evaluated", {
      runId,
      retryableFailedCount: retryableFailed.length,
      discoveredCount: discovered.length,
      candidateCount: candidates.length,
      suitableCount: suitable.length,
      rejectionCounts: Object.fromEntries(rejectionCounts),
    });

    for (const job of suitable) {
      verifiedCount = await countVerifiedApplications(env.DB, applicationMonth);
      if (verifiedCount >= MONTHLY_APPLICATION_TARGET) break;

      if (!canSubmitNow()) {
        return {
          verifiedCount,
          error:
            "Application window closed before the next submission; automation stopped without sending another application.",
        };
      }

      if (
        (await countOccupiedMonthlyApplicationSlots(env.DB, applicationMonth)) >=
        MONTHLY_APPLICATION_TARGET
      ) {
        break;
      }

      const existingApplication = await getApplicationForJob(env.DB, job.provider, job.externalId);
      if (existingApplication && !isRetryablePreSubmitFailure(existingApplication, runId)) {
        continue;
      }

      const applicationId =
        existingApplication?.id ?? `application:${job.provider}:${job.externalId}`;
      const reservationOwner = `${runId}:${crypto.randomUUID()}`;
      const quotaClaim = await claimMonthlyApplicationSlot(
        env.DB,
        applicationMonth,
        applicationId,
        reservationOwner,
      );
      if (!quotaClaim) {
        if (
          (await countOccupiedMonthlyApplicationSlots(env.DB, applicationMonth)) >=
          MONTHLY_APPLICATION_TARGET
        ) {
          break;
        }
        continue;
      }

      let attemptId: string | undefined;
      let submissionAttempted = false;
      let verificationCommitted = false;

      try {
        const jobId = await persistJob(env.DB, job);
        if (existingApplication) {
          const requeued = await requeueFailedPreSubmitApplication(env.DB, {
            id: applicationId,
            runId,
            reportMonth: applicationMonth,
          });
          if (!requeued) {
            await releaseMonthlyApplicationSlot(env.DB, applicationId, reservationOwner);
            continue;
          }
        } else {
          await createApplication(env.DB, {
            id: applicationId,
            jobId,
            runId,
            reportMonth: applicationMonth,
          });
        }

        const claim = await env.DB.prepare(
          `SELECT automation_run_id, status
             FROM applications WHERE id = ?`,
        )
          .bind(applicationId)
          .first<{ automation_run_id: string | null; status: string }>();
        if (!claim || claim.automation_run_id !== runId || claim.status !== "queued") {
          await releaseMonthlyApplicationSlot(env.DB, applicationId, reservationOwner);
          continue;
        }

        await setApplicationStatus(env.DB, applicationId, "applying");

        const attemptNo = await nextAttemptNumber(env.DB, applicationId);
        attemptId = await startAttempt(env.DB, applicationId, attemptNo);

        if (!canSubmitNow()) {
          await finishAttempt(
            env.DB,
            attemptId,
            "failed",
            "APPLICATION_WINDOW_CLOSED",
            "Application window closed before the external submit control was activated.",
          );
          await setApplicationStatus(env.DB, applicationId, "failed");
          await releaseMonthlyApplicationSlot(env.DB, applicationId, reservationOwner);
          continue;
        }

        const result = await provider.apply(job);
        submissionAttempted = result.submissionAttempted === true || result.status === "submitted";
        const appliedAt = submissionAttempted ? new Date().toISOString() : undefined;

        if (result.status !== "submitted") {
          await finishAttempt(
            env.DB,
            attemptId,
            result.status === "failed" && !submissionAttempted ? "failed" : "unknown",
            result.status === "failed" && !submissionAttempted
              ? "APPLICATION_FAILED"
              : "APPLICATION_UNKNOWN",
            result.error,
          );

          if (result.status === "failed" && !submissionAttempted) {
            await setApplicationStatus(env.DB, applicationId, "failed");
            await releaseMonthlyApplicationSlot(env.DB, applicationId, reservationOwner);
          } else {
            await setOwnedMonthlyApplicationSlotState(
              env.DB,
              applicationId,
              reservationOwner,
              "uncertain",
            );
            await setApplicationStatus(
              env.DB,
              applicationId,
              "needs_user_action",
              appliedAt ? { appliedAt } : {},
            );
          }
          continue;
        }

        await setOwnedMonthlyApplicationSlotState(
          env.DB,
          applicationId,
          reservationOwner,
          "submitted",
        );
        await setApplicationStatus(env.DB, applicationId, "submitted", {
          appliedAt,
        });

        const verified = await provider.verify(job);
        if (!verified) {
          await finishAttempt(
            env.DB,
            attemptId,
            "unknown",
            "VERIFICATION_FAILED",
            "StudentConsulting did not show the exact Jobb-ID in Ansökningar.",
          );
          await setApplicationStatus(
            env.DB,
            applicationId,
            "needs_user_action",
            appliedAt ? { appliedAt } : {},
          );
          continue;
        }

        const verifiedAt = new Date().toISOString();
        await finishAttempt(env.DB, attemptId, "verified");
        await setOwnedMonthlyApplicationSlotState(
          env.DB,
          applicationId,
          reservationOwner,
          "verified",
        );
        await setApplicationStatus(env.DB, applicationId, "verified", {
          appliedAt,
          verifiedAt,
        });
        verificationCommitted = true;

        verifiedCount = await countVerifiedApplications(env.DB, applicationMonth);
        await updateRun(env.DB, runId, { verifiedCount });

        await persistVerificationEvidence(
          env,
          runId,
          applicationId,
          applicationMonth,
          job,
          appliedAt ?? verifiedAt,
          verifiedAt,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (verificationCommitted) {
          await recordApplicationDiagnostic(
            env.DB,
            applicationId,
            "POST_VERIFICATION_ERROR",
            message,
          );
          continue;
        }

        if (attemptId) {
          await finishAttempt(
            env.DB,
            attemptId,
            submissionAttempted ? "unknown" : "failed",
            "UNEXPECTED_APPLICATION_ERROR",
            message,
          );
        }

        if (submissionAttempted) {
          await setOwnedMonthlyApplicationSlotState(
            env.DB,
            applicationId,
            reservationOwner,
            "uncertain",
          );
          await setApplicationStatus(env.DB, applicationId, "needs_user_action");
        } else {
          await setApplicationStatus(env.DB, applicationId, "failed");
          await releaseMonthlyApplicationSlot(env.DB, applicationId, reservationOwner);
        }
      }
    }

    verifiedCount = await countVerifiedApplications(env.DB, applicationMonth);
    const occupied = await countOccupiedMonthlyApplicationSlots(env.DB, applicationMonth);
    return {
      verifiedCount,
      error:
        verifiedCount < MONTHLY_APPLICATION_TARGET
          ? occupied >= MONTHLY_APPLICATION_TARGET
            ? `${Math.max(0, occupied - verifiedCount)} ansökningar väntar på säker verifiering och bara ${verifiedCount}/${MONTHLY_APPLICATION_TARGET} är godkända. De räknas inte som godkända platser, men nya skick stoppas tills de verifierats eller markerats som inte inskickade.`
            : candidates.length === 0
              ? "STUDENTCONSULTING_MATCHED_PROFILE_EMPTY: inga retrybara tidigare försök eller upptäckbara Matcha-jobb återstår."
              : suitable.length === 0
                ? `STUDENTCONSULTING_NO_SUITABLE_MATCHES: ${candidates.length} kandidater granskades (${retryableFailed.length} retry, ${discovered.length} Matcha-jobb) men alla stoppades av fail-closed policy. ${summarizeRejections(rejectionCounts)}`
                : `Only ${verifiedCount}/${MONTHLY_APPLICATION_TARGET} suitable verified applications could be completed. ${retryableFailed.length} tidigare failures återköades, ${discovered.length} Matcha-jobb hittades och ${suitable.length} kandidater passerade policy.`
          : undefined,
    };
  });
}

function summarizeRejections(rejectionCounts: Map<string, number>): string {
  if (rejectionCounts.size === 0) return "Ingen specifik policyorsak registrerades.";
  return [...rejectionCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${count}× ${reason}`)
    .join("; ");
}

export interface ApplicationAttentionResult {
  applicationId: string;
  providerState: "applied" | "not_applied" | "unknown" | "user_confirmed_not_applied";
  status: string;
  changed: boolean;
  message: string;
}

interface AttentionApplicationRow {
  id: string;
  status: string;
  applied_at: string | null;
  verified_at: string | null;
  automation_run_id: string | null;
  report_month: string;
  raw_json: string | null;
}

async function getAttentionApplication(
  db: D1Database,
  applicationId: string,
): Promise<AttentionApplicationRow | null> {
  return db
    .prepare(
      `SELECT a.id, a.status, a.applied_at, a.verified_at,
              a.automation_run_id, a.report_month, j.raw_json
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       WHERE a.id = ?
       LIMIT 1`,
    )
    .bind(applicationId)
    .first<AttentionApplicationRow>();
}

export async function recheckApplicationAttention(
  env: AutomationEnv,
  applicationId: string,
): Promise<ApplicationAttentionResult | null> {
  const row = await getAttentionApplication(env.DB, applicationId);
  if (!row) return null;
  if (row.status !== "needs_user_action") {
    return {
      applicationId,
      providerState: "unknown",
      status: row.status,
      changed: false,
      message: "Ansökan behöver inte längre användaråtgärd.",
    };
  }

  let job: JobCandidate;
  try {
    job = JSON.parse(row.raw_json ?? "") as JobCandidate;
  } catch {
    await recordApplicationDiagnostic(
      env.DB,
      applicationId,
      "RECHECK_DATA_INVALID",
      "Stored job payload could not be parsed for user-attention recheck.",
    );
    return {
      applicationId,
      providerState: "unknown",
      status: "needs_user_action",
      changed: false,
      message: "Jobbdatan kunde inte läsas för en ny kontroll.",
    };
  }

  if (job.provider !== "studentconsulting") {
    return {
      applicationId,
      providerState: "unknown",
      status: "needs_user_action",
      changed: false,
      message: "Automatisk omkontroll stöds bara för StudentConsulting.",
    };
  }

  return withStudentConsultingProvider(env, async (provider) => {
    const auth = await provider.authenticate();
    if (auth.status !== "authenticated") {
      return {
        applicationId,
        providerState: "unknown",
        status: "needs_user_action",
        changed: false,
        message:
          auth.status === "failed"
            ? `${auth.code}: ${auth.message}`
            : "StudentConsulting kunde inte autentiseras för omkontroll.",
      };
    }

    const providerState = await provider.inspectApplicationStatus(job);
    if (providerState === "not_applied") {
      if (shouldDelayNotAppliedReclassification(row.applied_at)) {
        return {
          applicationId,
          providerState,
          status: "needs_user_action",
          changed: false,
          message:
            "StudentConsulting visar ännu inte ansökan som skickad. Vänta några minuter och kontrollera igen innan säkerhetsspärren släpps.",
        };
      }

      const changed = await reclassifyApplicationNotSubmitted(env.DB, applicationId);
      if (changed) {
        await recordApplicationDiagnostic(
          env.DB,
          applicationId,
          "APPLICATION_NOT_APPLIED",
          "Authenticated StudentConsulting status confirmed that the exact Jobb-ID is not applied; the safety hold was released.",
        );
      }
      return {
        applicationId,
        providerState,
        status: changed ? "failed" : "needs_user_action",
        changed,
        message: changed
          ? "StudentConsulting bekräftade att ansökan inte skickades. Den räknas inte och spärren är släppt."
          : "Ansökans status ändrades samtidigt; ladda om och kontrollera igen.",
      };
    }

    if (providerState !== "applied") {
      return {
        applicationId,
        providerState: "unknown",
        status: "needs_user_action",
        changed: false,
        message:
          "StudentConsulting kunde fortfarande inte bekräfta Jobb-ID:t i Ansökningar. Ingen slot räknas som godkänd.",
      };
    }

    const verifiedAt = new Date().toISOString();
    const changed = await verifyApplicationFromAttention(env.DB, applicationId, verifiedAt);
    if (!changed) {
      return {
        applicationId,
        providerState,
        status: "needs_user_action",
        changed: false,
        message: "Ansökans status ändrades samtidigt; ladda om och kontrollera igen.",
      };
    }

    const attemptNo = await nextAttemptNumber(env.DB, applicationId);
    const attemptId = await startAttempt(env.DB, applicationId, attemptNo);
    await finishAttempt(env.DB, attemptId, "verified");
    await reconcileMonthlyApplicationSlotState(env.DB, applicationId, "verified");

    const verifiedCount = await countVerifiedApplications(env.DB, row.report_month);
    if (row.automation_run_id) {
      await updateRun(env.DB, row.automation_run_id, { verifiedCount });
    }
    if (verifiedCount >= MONTHLY_APPLICATION_TARGET) {
      const monthlyApplications = await loadVerifiedReportApplications(env.DB, row.report_month);
      const monthlyExport = await ensureMonthlyActivityExport(
        env.DB,
        row.report_month,
        monthlyApplications,
      );
      if (monthlyExport?.created) {
        await emailNewExport(env, monthlyExport.row, row.automation_run_id);
      }
    }

    await persistVerificationEvidence(
      env,
      row.automation_run_id ?? "attention-recheck",
      applicationId,
      row.report_month,
      job,
      row.applied_at ?? verifiedAt,
      verifiedAt,
    );

    return {
      applicationId,
      providerState,
      status: "verified",
      changed: true,
      message: "StudentConsulting bekräftade Jobb-ID:t. Ansökan är nu verifierad och räknas.",
    };
  });
}

export async function confirmApplicationNotSubmitted(
  env: AutomationEnv,
  applicationId: string,
): Promise<ApplicationAttentionResult | null> {
  const row = await getAttentionApplication(env.DB, applicationId);
  if (!row) return null;
  if (row.status !== "needs_user_action") {
    return {
      applicationId,
      providerState: "user_confirmed_not_applied",
      status: row.status,
      changed: false,
      message: "Ansökan behöver inte längre användaråtgärd.",
    };
  }

  const changed = await reclassifyApplicationNotSubmitted(env.DB, applicationId);
  if (changed) {
    await recordApplicationDiagnostic(
      env.DB,
      applicationId,
      "USER_CONFIRMED_NOT_APPLIED",
      "The authenticated dashboard user confirmed that this uncertain StudentConsulting application was not submitted; the safety hold was released.",
    );
  }

  return {
    applicationId,
    providerState: "user_confirmed_not_applied",
    status: changed ? "failed" : "needs_user_action",
    changed,
    message: changed
      ? "Markerad som inte inskickad. Den räknas inte och spärren är släppt."
      : "Ansökans status kunde inte ändras. Ladda om och kontrollera aktuell status.",
  };
}

async function reconcilePendingApplications(
  env: AutomationEnv,
  provider: StudentConsultingProvider,
  applicationMonth: string,
  runId: string,
): Promise<number> {
  const pending = await env.DB.prepare(
    `SELECT a.id, a.applied_at, j.raw_json
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       JOIN monthly_application_slots s ON s.application_id = a.id
       WHERE a.report_month = ?
         AND a.status IN ('applying','submitted','needs_user_action')
         AND s.state IN ('submitted','uncertain')
       ORDER BY COALESCE(a.applied_at, a.created_at), a.id`,
  )
    .bind(applicationMonth)
    .all<{ id: string; applied_at: string | null; raw_json: string | null }>();

  for (const row of pending.results) {
    let job: JobCandidate;
    try {
      job = JSON.parse(row.raw_json ?? "") as JobCandidate;
    } catch {
      await recordApplicationDiagnostic(
        env.DB,
        row.id,
        "RECONCILIATION_DATA_INVALID",
        "Stored job payload could not be parsed for verification.",
      );
      continue;
    }

    if (job.provider !== "studentconsulting") continue;

    const applicationState = await provider.inspectApplicationStatus(job);
    if (applicationState === "not_applied") {
      if (shouldDelayNotAppliedReclassification(row.applied_at)) {
        continue;
      }

      const reclassified = await reclassifyApplicationNotSubmitted(env.DB, row.id);
      if (reclassified) {
        await recordApplicationDiagnostic(
          env.DB,
          row.id,
          "APPLICATION_NOT_APPLIED",
          "Authenticated StudentConsulting status confirmed that the exact Jobb-ID is not applied; the uncertain quota slot was released.",
        );
      }
      continue;
    }
    if (applicationState !== "applied") continue;

    const verifiedAt = new Date().toISOString();
    const attemptNo = await nextAttemptNumber(env.DB, row.id);
    const attemptId = await startAttempt(env.DB, row.id, attemptNo);
    await finishAttempt(env.DB, attemptId, "verified");
    await reconcileMonthlyApplicationSlotState(env.DB, row.id, "verified");
    await setApplicationStatus(env.DB, row.id, "verified", { verifiedAt });

    await persistVerificationEvidence(
      env,
      runId,
      row.id,
      applicationMonth,
      job,
      row.applied_at ?? verifiedAt,
      verifiedAt,
    );
  }

  return countVerifiedApplications(env.DB, applicationMonth);
}

async function persistVerificationEvidence(
  env: AutomationEnv,
  runId: string,
  applicationId: string,
  applicationMonth: string,
  job: JobCandidate,
  appliedAt: string,
  verifiedAt: string,
): Promise<void> {
  try {
    const objectKey = `applications/${applicationMonth}/${job.externalId}.json`;
    await env.EVIDENCE.put(
      objectKey,
      JSON.stringify({
        job,
        appliedAt,
        verifiedAt,
        verification: "StudentConsulting authenticated exact Jobb-ID verification",
      }),
      { httpMetadata: { contentType: "application/json" } },
    );
    await addEvidence(env.DB, {
      id: `evidence:${applicationId}`,
      applicationId,
      kind: "studentconsulting-verification",
      objectKey,
    });
  } catch (error) {
    await recordApplicationDiagnostic(
      env.DB,
      applicationId,
      "EVIDENCE_WRITE_FAILED",
      error instanceof Error ? error.message : String(error),
    );
    await updateRun(env.DB, runId, {
      lastError:
        "An application was verified, but its evidence object could not be persisted. Verification remains valid.",
    });
  }
}

async function recordApplicationDiagnostic(
  db: D1Database,
  applicationId: string,
  code: string,
  message: string,
): Promise<void> {
  const attemptNo = await nextAttemptNumber(db, applicationId);
  const attemptId = await startAttempt(db, applicationId, attemptNo);
  await finishAttempt(db, attemptId, "failed", code, message);
}
