import type { BrowserWorker } from "@cloudflare/playwright";
import { MONTHLY_APPLICATION_TARGET } from "../../../packages/core/src/types";
import { activityExportFileName, loadActivityExport } from "./activity-export";
import {
  authenticatedIdentity,
  authorizeDashboardRequest,
  dashboardAuthMode,
  type DashboardAuthEnv,
} from "./auth";
import { type AutomationWorkflowParams, JobAutomationWorkflow } from "./automation-workflow";
import { getDashboardData, getRunDetail } from "./dashboard-data";
import { isDashboardAsset, serveDashboardAsset } from "./dashboard-assets";
import { emailActivityExport, type EmailBinding } from "./notifier";
import { ACCESS_LOGOUT_PATH } from "./access-auth";
import { passwordAuthRoute } from "./password-auth";
import { renderAuthStyles, renderErrorPage } from "./auth-ui";
import { readinessResponse } from "./readiness";
import { requireSameOriginMutation } from "./request-security";
import {
  confirmApplicationNotSubmitted,
  recheckApplicationAttention,
  type AutomationEnv,
} from "./runner";
import {
  resolveRuntimeConfiguration,
  saveRuntimeConfiguration,
  type RuntimeConfigurationUpdate,
} from "./runtime-config";
import {
  claimRunStart,
  countVerifiedApplications,
  deleteRunRecords,
  failOrphanedRunningRuns,
  getRun,
  scheduledRunId,
  updateRun,
  type AutomationRunRow,
} from "./storage";
import { currentMonthKey, isApplicationAutomationWindow, isScheduledSafetyWindow } from "./time";

export { JobAutomationWorkflow };

export interface Env extends AutomationEnv, DashboardAuthEnv {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  BROWSER: BrowserWorker;
  ASSETS: Fetcher;
  EMAIL?: EmailBinding;
  JOB_AUTOMATION: Workflow<AutomationWorkflowParams>;
  STUDENTCONSULTING_EMAIL?: string;
  STUDENTCONSULTING_PASSWORD?: string;
  STUDENTCONSULTING_AUTOSUBMIT?: string;
  JOB_INCLUDE_TERMS?: string;
  JOB_EXCLUDE_TERMS?: string;
  JOB_ALLOWED_LOCATIONS?: string;
  JOB_ALLOWED_COUNTRIES?: string;
  NOTIFY_EMAIL_TO?: string;
  NOTIFY_EMAIL_FROM?: string;
  NOTIFY_EMAIL_MODE?: string;
  PUBLIC_BASE_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok" });
    }

    if (request.method === "GET" && url.pathname === "/api/ready") {
      return readinessResponse(env.DB, env);
    }

    if (request.method === "GET" && url.pathname === "/assets/auth.css") {
      return renderAuthStyles();
    }

    // Sign-in happens in Cloudflare Access in front of the Worker, so /login has
    // no page of its own.
    if (request.method === "GET" && url.pathname === "/login") {
      return redirectTo("/");
    }

    if (dashboardAuthMode(env) === "password") {
      const authRoute = await passwordAuthRoute(request, env);
      if (authRoute) return authRoute;
    }

    const authFailure = await authorizeDashboardRequest(request, env);
    if (authFailure) return authFailure;

    const mutationFailure = requireSameOriginMutation(request);
    if (mutationFailure) return mutationFailure;

    if (request.method === "POST" && url.pathname === "/auth/logout") {
      return redirectTo(ACCESS_LOGOUT_PATH);
    }

    if (isDashboardAsset(request, url)) {
      return serveDashboardAsset(request, env.ASSETS);
    }

    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      try {
        const runtime = await resolveRuntimeConfiguration(env);
        return Response.json(await getDashboardData(env.DB, runtime.view), {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return jsonError(error, 500);
      }
    }

    const activityExportMatch = url.pathname.match(/^\/api\/reports\/(\d{4}-\d{2})\/export\.txt$/);
    if (request.method === "GET" && activityExportMatch) {
      const monthlyExport = await loadActivityExport(env.DB, activityExportMatch[1]);
      if (!monthlyExport) {
        return new Response("Månadsfilen är inte klar ännu.", {
          status: 404,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }

      return new Response(monthlyExport.content_text, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${activityExportFileName(monthlyExport)}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    const exportEmailMatch = url.pathname.match(/^\/api\/reports\/(\d{4}-\d{2})\/email$/);
    if (request.method === "POST" && exportEmailMatch) {
      try {
        const monthlyExport = await loadActivityExport(env.DB, exportEmailMatch[1]);
        if (!monthlyExport) {
          return Response.json({ error: "Månadsfilen är inte klar ännu." }, { status: 404 });
        }
        const runtime = await resolveRuntimeConfiguration(env);
        const deliveries = await emailActivityExport(runtime.env, monthlyExport, null);
        const failed = deliveries.filter((x) => x.status === "failed");
        return Response.json(
          { deliveries, sent: deliveries.length - failed.length, failed: failed.length },
          { status: failed.length === deliveries.length ? 502 : 200 },
        );
      } catch (error) {
        return jsonError(error, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/configuration") {
      const body = await request.json<RuntimeConfigurationUpdate>().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return Response.json(
          { error: "Ogiltig konfigurationsdata." },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }

      try {
        const identity = await authenticatedIdentity(request, env);
        if (!identity) {
          return Response.json(
            { error: "authentication required" },
            { status: 401, headers: { "cache-control": "no-store" } },
          );
        }
        await saveRuntimeConfiguration(env, body, identity.email);
        const runtime = await resolveRuntimeConfiguration(env);
        return Response.json(
          { configuration: runtime.view },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        return jsonError(error, 400);
      }
    }

    const applicationRecheckMatch = url.pathname.match(/^\/api\/applications\/([^/]+)\/recheck$/);
    if (request.method === "POST" && applicationRecheckMatch) {
      try {
        const applicationId = decodeURIComponent(applicationRecheckMatch[1]);
        const runtime = await resolveRuntimeConfiguration(env);
        const result = await recheckApplicationAttention(runtime.env, applicationId);
        if (!result) {
          return Response.json({ error: "Application not found" }, { status: 404 });
        }
        return Response.json(result, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return jsonError(error, 500);
      }
    }

    const applicationNotSubmittedMatch = url.pathname.match(
      /^\/api\/applications\/([^/]+)\/not-submitted$/,
    );
    if (request.method === "POST" && applicationNotSubmittedMatch) {
      try {
        const applicationId = decodeURIComponent(applicationNotSubmittedMatch[1]);
        const runtime = await resolveRuntimeConfiguration(env);
        const result = await confirmApplicationNotSubmitted(runtime.env, applicationId);
        if (!result) {
          return Response.json({ error: "Application not found" }, { status: 404 });
        }
        return Response.json(result, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        return jsonError(error, 500);
      }
    }

    const runDetailMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (request.method === "GET" && runDetailMatch) {
      try {
        const runId = decodeURIComponent(runDetailMatch[1]);
        const detail = await getRunDetail(env.DB, runId);
        if (!detail) return Response.json({ error: "Run not found" }, { status: 404 });
        return Response.json(detail);
      } catch (error) {
        return jsonError(error, 500);
      }
    }

    const stopRunMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
    if (request.method === "POST" && stopRunMatch) {
      const runId = decodeURIComponent(stopRunMatch[1]);
      const run = await getRun(env.DB, runId);
      if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
      if (run.status !== "running") {
        return Response.json({ error: "Only active runs can be stopped." }, { status: 409 });
      }

      if (run.workflow_instance_id) {
        const instance = await env.JOB_AUTOMATION.get(run.workflow_instance_id);
        const workflowStatus = await instance.status();
        if (
          ["queued", "running", "paused", "waiting", "waitingForPause", "rollingBack"].includes(
            workflowStatus.status,
          )
        ) {
          try {
            await instance.terminate();
          } catch (error) {
            return jsonError(error, 502);
          }
        }
      }

      await updateRun(env.DB, runId, {
        status: "failed",
        lastError: "RUN_STOPPED_BY_USER: körningen stoppades manuellt.",
        completedAt: new Date().toISOString(),
      });
      return Response.json({ runId, status: "failed", stopped: true });
    }

    const deleteRunMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (request.method === "DELETE" && deleteRunMatch) {
      const runId = decodeURIComponent(deleteRunMatch[1]);
      const detail = await getRunDetail(env.DB, runId);
      if (!detail) return Response.json({ error: "Run not found" }, { status: 404 });
      if (detail.run.status === "running") {
        return Response.json({ error: "Stop the run before deleting it." }, { status: 409 });
      }
      if (detail.applications.length > 0) {
        return Response.json(
          { error: "Runs with application history cannot be deleted." },
          { status: 409 },
        );
      }

      const workflowInstanceId =
        typeof detail.run.workflow_instance_id === "string"
          ? detail.run.workflow_instance_id
          : null;
      if (workflowInstanceId) {
        try {
          const instance = await env.JOB_AUTOMATION.get(workflowInstanceId);
          await instance.delete();
        } catch (error) {
          return jsonError(error, 502);
        }
      }

      await deleteRunRecords(env.DB, runId);
      return Response.json({ runId, deleted: true });
    }

    if (request.method === "POST" && url.pathname === "/api/runs/manual") {
      const now = new Date();
      if (!isApplicationAutomationWindow(now)) {
        return Response.json(
          {
            error:
              "Manuell jobbsökning är endast aktiverad den 1:a–14:e varje månad (Europe/Stockholm).",
          },
          { status: 409 },
        );
      }

      const applicationMonth = currentMonthKey(now);
      const verifiedCount = await countVerifiedApplications(env.DB, applicationMonth);
      if (verifiedCount >= MONTHLY_APPLICATION_TARGET) {
        return Response.json(
          { error: "Månadsmålet är redan uppnått. Månadsfilen finns i översikten." },
          { status: 409 },
        );
      }
      const runtime = await resolveRuntimeConfiguration(env);
      if (!runtime.view.studentConsultingCredentials || !runtime.view.studentConsultingAutoSubmit) {
        return Response.json(
          { error: "StudentConsulting-konto och autosubmit måste vara konfigurerade." },
          { status: 409 },
        );
      }
      await failOrphanedRunningRuns(env.DB);

      const runId = `manual:${applicationMonth}:${crypto.randomUUID()}`;
      const claimed = await claimRunStart(env.DB, {
        id: runId,
        mode: "manual",
        applicationMonth,
        targetCount: MONTHLY_APPLICATION_TARGET,
      });
      if (!claimed) {
        return Response.json(
          { error: "En automation körs redan. Vänta tills den är klar innan en ny startas." },
          { status: 409 },
        );
      }

      let instance: Awaited<ReturnType<Env["JOB_AUTOMATION"]["create"]>>;
      try {
        instance = await env.JOB_AUTOMATION.create({
          id: `manual-${crypto.randomUUID()}`,
          params: {
            mode: "manual",
            runId,
            triggeredAt: now.toISOString(),
          },
        });
      } catch (error) {
        await updateRun(env.DB, runId, {
          status: "failed",
          lastError: `WORKFLOW_START_FAILED: ${errorMessage(error)}`,
          completedAt: new Date().toISOString(),
        });
        return jsonError(error, 502);
      }

      try {
        await updateRun(env.DB, runId, {
          workflowInstanceId: instance.id,
        });
      } catch (error) {
        console.error("Workflow started before D1 link could be persisted", {
          runId,
          workflowInstanceId: instance.id,
          error: errorMessage(error),
        });
      }

      return Response.json(
        { runId, workflowInstanceId: instance.id, status: "queued" },
        { status: 202 },
      );
    }

    if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
      return renderErrorPage({
        status: 404,
        eyebrow: "Jobb",
        title: "Sidan finns inte",
        message:
          "Adressen leder inte till någon sida i Jobb. Gå tillbaka till dashboarden eller logga in på nytt.",
        code: "not_found",
        primaryHref: "/",
        primaryLabel: "Till dashboarden",
        secondaryHref: "/login",
        secondaryLabel: "Till inloggningen",
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const triggeredAt = new Date(controller.scheduledTime);
    if (!isScheduledSafetyWindow(triggeredAt)) return;

    const applicationMonth = currentMonthKey(triggeredAt);
    await failOrphanedRunningRuns(env.DB);

    const runId = scheduledRunId(applicationMonth);
    const claimed = await claimRunStart(env.DB, {
      id: runId,
      mode: "scheduled",
      applicationMonth,
      targetCount: MONTHLY_APPLICATION_TARGET,
    });
    if (!claimed) return;

    const suffix = triggeredAt
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 12);
    let instance: Awaited<ReturnType<Env["JOB_AUTOMATION"]["create"]>>;
    try {
      instance = await env.JOB_AUTOMATION.create({
        id: `scheduled-${applicationMonth}-${suffix}`,
        params: {
          mode: "scheduled",
          runId,
          triggeredAt: triggeredAt.toISOString(),
        },
      });
    } catch (error) {
      await updateRun(env.DB, runId, {
        status: "failed",
        lastError: `WORKFLOW_START_FAILED: ${errorMessage(error)}`,
        completedAt: new Date().toISOString(),
      });
      throw error;
    }

    try {
      await updateRun(env.DB, runId, {
        workflowInstanceId: instance.id,
      });
    } catch (error) {
      console.error("Scheduled Workflow started before D1 link could be persisted", {
        runId,
        workflowInstanceId: instance.id,
        error: errorMessage(error),
      });
    }
  },
} satisfies ExportedHandler<Env>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redirectTo(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function jsonError(error: unknown, status: number): Response {
  return Response.json({ error: errorMessage(error) }, { status });
}
