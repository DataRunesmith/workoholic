import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { executeAutomation, type AutomationEnv } from "./runner";
import { withStudentConsultingProvider } from "./providers";
import { backfillStudentConsultingMonth } from "./historical-backfill";
import { resolveRuntimeConfiguration, type RuntimeConfigEnv } from "./runtime-config";
import { updateRun } from "./storage";

type AutomationWorkflowEnv = AutomationEnv & RuntimeConfigEnv;

export interface AutomationWorkflowParams {
  mode?: "manual" | "scheduled";
  runId?: string;
  triggeredAt?: string;
  probeStudentConsultingHistory?: boolean;
  backfillStudentConsultingMonth?: string;
}

export class JobAutomationWorkflow extends WorkflowEntrypoint<
  AutomationWorkflowEnv,
  AutomationWorkflowParams
> {
  async run(event: WorkflowEvent<AutomationWorkflowParams>, step: WorkflowStep) {
    const trigger = await step.do("resolve trigger", async () => ({
      mode: event.payload?.mode ?? "scheduled",
      runId: event.payload?.runId,
      triggeredAt: event.payload?.triggeredAt ?? event.timestamp.toISOString(),
      probeStudentConsultingHistory: event.payload?.probeStudentConsultingHistory === true,
      backfillStudentConsultingMonth: event.payload?.backfillStudentConsultingMonth,
    }));

    if (trigger.backfillStudentConsultingMonth) {
      return step.do(
        "backfill StudentConsulting application history",
        { retries: { limit: 0, delay: "1 second" }, timeout: "15 minutes" },
        async () => {
          const runtime = await resolveRuntimeConfiguration(this.env);
          return backfillStudentConsultingMonth(
            runtime.env,
            trigger.backfillStudentConsultingMonth!,
          );
        },
      );
    }

    if (trigger.probeStudentConsultingHistory) {
      return step.do(
        "probe StudentConsulting application history",
        { retries: { limit: 0, delay: "1 second" }, timeout: "10 minutes" },
        async () => {
          const runtime = await resolveRuntimeConfiguration(this.env);
          const reference = await this.env.DB.prepare(
            `SELECT j.external_id
               FROM applications a
               JOIN jobs j ON j.id = a.job_id
               WHERE a.status = 'verified' AND j.provider = 'studentconsulting'
               ORDER BY COALESCE(a.verified_at, a.applied_at, a.created_at) DESC
               LIMIT 1`,
          ).first<{ external_id: string }>();
          if (!reference?.external_id) {
            throw new Error("STUDENTCONSULTING_HISTORY_REFERENCE_MISSING");
          }
          return withStudentConsultingProvider(runtime.env, async (provider) => {
            const auth = await provider.authenticate();
            if (auth.status !== "authenticated") {
              throw new Error(
                `STUDENTCONSULTING_HISTORY_AUTH_FAILED: ${
                  "message" in auth && auth.message ? auth.message : auth.status
                }`,
              );
            }
            return provider.probeApplicationHistory(reference.external_id);
          });
        },
      );
    }

    let result: Awaited<ReturnType<typeof executeAutomation>>;
    try {
      if (trigger.runId) {
        await step.do("link workflow instance at start", async () => {
          await updateRun(this.env.DB, trigger.runId!, {
            workflowInstanceId: event.instanceId,
          });
        });
      }

      result = await step.do(
        "execute application automation",
        {
          retries: { limit: 0, delay: "1 second" },
          timeout: "30 minutes",
        },
        async () => {
          const runtime = await resolveRuntimeConfiguration(this.env);
          return executeAutomation(runtime.env, {
            mode: trigger.mode,
            runId: trigger.runId,
          });
        },
      );
    } catch (error) {
      if (trigger.runId) {
        try {
          await step.do("record workflow failure", async () => {
            await updateRun(this.env.DB, trigger.runId!, {
              status: "failed",
              workflowInstanceId: event.instanceId,
              lastError: workflowErrorMessage(error),
              completedAt: new Date().toISOString(),
            });
          });
        } catch (recordError) {
          console.error("Failed to persist workflow failure", {
            runId: trigger.runId,
            workflowInstanceId: event.instanceId,
            error: workflowErrorMessage(recordError),
          });
        }
      }
      throw error;
    }

    if (result.status === "skipped" && trigger.runId) {
      await step.do("finalize skipped workflow", async () => {
        await updateRun(this.env.DB, trigger.runId!, {
          status: "failed",
          workflowInstanceId: event.instanceId,
          verifiedCount: result.verifiedCount,
          lastError: `WORKFLOW_SKIPPED: ${result.message ?? "run window closed before execution"}`,
          completedAt: new Date().toISOString(),
        });
      });
    }

    if (result.status === "failed") {
      throw new Error(result.message ?? "Job automation failed.");
    }

    return result;
  }
}

function workflowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
