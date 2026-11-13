import { describe, expect, it, vi } from "vitest";
import type { ActivityReportExportRow } from "./activity-export";
import { invalidRecipients, parseRecipients, sendActivityExportEmail } from "./notifier";

const row: ActivityReportExportRow = {
  report_month: "2026-10",
  target_count: 10,
  item_count: 10,
  content_text: "Jobb-ID: 87567\nJobbtyp: Truckförare\nStad: Malmö\nOmfattning: Heltid\n",
  ready_at: "2026-10-12T08:00:00.000Z",
  created_at: "2026-10-12 08:00:00",
};

describe("monthly export e-mail", () => {
  it("parses comma, semicolon and newline separated recipients", () => {
    expect(parseRecipients(" a@x.example, b@x.example;\nc@x.example,a@x.example ")).toEqual([
      "a@x.example",
      "b@x.example",
      "c@x.example",
    ]);
    expect(invalidRecipients("a@x.example, inte-en-adress")).toEqual(["inte-en-adress"]);
  });

  it("sends one shared e-mail in group mode", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "1" });
    const deliveries = await sendActivityExportEmail(
      {
        EMAIL: { send },
        NOTIFY_EMAIL_FROM: "workoholic@x.example",
        NOTIFY_EMAIL_TO: "a@x.example, b@x.example",
      },
      row,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toEqual(["a@x.example", "b@x.example"]);
    expect(send.mock.calls[0][0].attachments[0].filename).toBe("jobbansokningar_2026-10-12.txt");
    expect(deliveries.map((x) => x.status)).toEqual(["sent", "sent"]);
  });

  it("encodes large UTF-8 attachments without spreading the whole report into arguments", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "large" });
    const content = "å".repeat(100_000);
    await sendActivityExportEmail(
      {
        EMAIL: { send },
        NOTIFY_EMAIL_FROM: "workoholic@x.example",
        NOTIFY_EMAIL_TO: "a@x.example",
      },
      { ...row, content_text: content },
    );
    const encoded = send.mock.calls[0][0].attachments[0].content as string;
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(content);
  });

  it("sends one e-mail per address in separate mode and reports each failure", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "1" })
      .mockRejectedValueOnce(new Error("E_RECIPIENT_NOT_ALLOWED"));
    const deliveries = await sendActivityExportEmail(
      {
        EMAIL: { send },
        NOTIFY_EMAIL_FROM: "workoholic@x.example",
        NOTIFY_EMAIL_TO: "a@x.example, b@x.example",
        NOTIFY_EMAIL_MODE: "separate",
      },
      row,
    );
    expect(send.mock.calls.map((call) => call[0].to)).toEqual(["a@x.example", "b@x.example"]);
    expect(deliveries).toEqual([
      { to: "a@x.example", status: "sent" },
      { to: "b@x.example", status: "failed", error: "E_RECIPIENT_NOT_ALLOWED" },
    ]);
  });
});
