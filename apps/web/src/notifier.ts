import { activityExportFileName, type ActivityReportExportRow } from "./activity-export";
import { recordNotification } from "./storage";

export interface EmailBinding {
  send(message: {
    to: string | string[];
    from: string;
    subject: string;
    text?: string;
    attachments?: { content: string; filename: string; type: string; disposition: "attachment" }[];
  }): Promise<{ messageId: string }>;
}

export type EmailMode = "group" | "separate";

export interface NotificationEnv {
  EMAIL?: EmailBinding;
  NOTIFY_EMAIL_TO?: string;
  NOTIFY_EMAIL_FROM?: string;
  NOTIFY_EMAIL_MODE?: string;
}

export interface EmailDelivery {
  to: string;
  status: "sent" | "failed";
  error?: string;
}

const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Comma, semicolon or newline separated; duplicates dropped, order kept. */
export function parseRecipients(value: string | undefined): string[] {
  const seen = new Set<string>();
  for (const part of (value ?? "").split(/[,;\n]/)) {
    const address = part.trim();
    if (address) seen.add(address);
  }
  return [...seen];
}

export function invalidRecipients(value: string | undefined): string[] {
  return parseRecipients(value).filter((address) => !EMAIL_PATTERN.test(address));
}

export function emailMode(value: string | undefined): EmailMode {
  return value === "separate" ? "separate" : "group";
}

export function exportEmailConfigured(env: NotificationEnv): boolean {
  return Boolean(env.EMAIL && env.NOTIFY_EMAIL_FROM && parseRecipients(env.NOTIFY_EMAIL_TO).length);
}

/**
 * Sends the month's .txt to every recipient: one shared e-mail ("group") or
 * one e-mail per address ("separate"), so recipients don't see each other.
 */
export async function sendActivityExportEmail(
  env: NotificationEnv,
  row: ActivityReportExportRow,
): Promise<EmailDelivery[]> {
  const recipients = parseRecipients(env.NOTIFY_EMAIL_TO);
  if (!env.EMAIL || !env.NOTIFY_EMAIL_FROM || !recipients.length) {
    throw new Error("E-post är inte konfigurerad: ange avsändare och minst en mottagare.");
  }
  const email = env.EMAIL;
  const from = env.NOTIFY_EMAIL_FROM;
  const filename = activityExportFileName(row);
  const message = {
    from,
    subject: `Jobbansökningar ${row.report_month} (${row.item_count} st)`,
    text:
      `Här är månadens ${row.item_count} jobbansökningar från StudentConsulting med jobb-ID, jobbtyp, stad och omfattning.\n\n` +
      row.content_text,
    attachments: [
      {
        content: btoa(String.fromCharCode(...new TextEncoder().encode(row.content_text))),
        filename,
        type: "text/plain",
        disposition: "attachment" as const,
      },
    ],
  };

  const groups =
    emailMode(env.NOTIFY_EMAIL_MODE) === "separate" ? recipients.map((x) => [x]) : [recipients];
  const deliveries: EmailDelivery[] = [];
  for (const to of groups) {
    try {
      await email.send({ ...message, to: to.length === 1 ? to[0] : to });
      deliveries.push(...to.map((address) => ({ to: address, status: "sent" as const })));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deliveries.push(
        ...to.map((address) => ({ to: address, status: "failed" as const, error: reason })),
      );
    }
  }
  return deliveries;
}

/** Sends and logs one notification row per address, so the dashboard shows failures. */
export async function emailActivityExport(
  env: NotificationEnv & { DB: D1Database },
  row: ActivityReportExportRow,
  runId: string | null,
): Promise<EmailDelivery[]> {
  const deliveries = await sendActivityExportEmail(env, row);
  for (const delivery of deliveries) {
    await recordNotification(env.DB, {
      id: crypto.randomUUID(),
      runId,
      kind: "export_email",
      channel: "email",
      status: delivery.status,
      error: delivery.error ? `${delivery.to}: ${delivery.error}` : undefined,
    });
  }
  return deliveries;
}
