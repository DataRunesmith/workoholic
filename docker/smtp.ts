// Container-only: an EmailBinding that sends over SMTP (cloudflare:sockets),
// so the monthly .txt can be e-mailed without Cloudflare Email Service.
// Supports STARTTLS (587) and direct TLS (465) with AUTH LOGIN.
import { connect } from "cloudflare:sockets";
import type { EmailBinding } from "../apps/web/src/notifier";

export interface SmtpEnv {
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
}

type Reply = { code: number; text: string };

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}?=`;
}

function base64Lines(text: string): string {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function address(value: string): string {
  const match = value.match(/<([^>]+)>/);
  const bare = (match ? match[1] : value).trim();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(bare)) throw new Error(`Ogiltig adress: ${value}`);
  return bare;
}

export function smtpBinding(env: SmtpEnv): EmailBinding {
  const host = env.SMTP_HOST!;
  const port = Number(env.SMTP_PORT || 587);
  return {
    async send(message) {
      const recipients = (Array.isArray(message.to) ? message.to : [message.to]).map(address);
      const boundary = `jobb-${crypto.randomUUID()}`;
      const parts = [
        `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(message.text ?? "")}`,
        ...(message.attachments ?? []).map(
          (file) =>
            `--${boundary}\r\nContent-Type: ${file.type}; name="${file.filename}"\r\nContent-Disposition: attachment; filename="${file.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${file.content.replace(/.{1,76}/g, "$&\r\n").trimEnd()}`,
        ),
      ];
      const messageId = `<${crypto.randomUUID()}@${address(message.from).split("@")[1]}>`;
      const data = [
        `From: ${message.from}`,
        `To: ${recipients.join(", ")}`,
        `Subject: ${encodeHeader(message.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: ${messageId}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        ...parts,
        `--${boundary}--`,
      ].join("\r\n");

      let socket = connect(
        { hostname: host, port },
        { secureTransport: port === 465 ? "on" : "starttls", allowHalfOpen: false },
      );
      let writer = socket.writable.getWriter();
      let reader = socket.readable.getReader();
      let buffer = "";
      const decoder = new TextDecoder();
      const read = async (): Promise<Reply> => {
        for (;;) {
          const lines = buffer.split("\r\n");
          const done = lines.findIndex(
            (line, index) => index < lines.length - 1 && /^\d{3} /.test(line),
          );
          if (done >= 0) {
            buffer = lines.slice(done + 1).join("\r\n");
            return {
              code: Number(lines[done].slice(0, 3)),
              text: lines.slice(0, done + 1).join("\n"),
            };
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error("SMTP-servern stängde anslutningen.");
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      };
      const write = (line: string) => writer.write(new TextEncoder().encode(`${line}\r\n`));
      const expect = async (code: number, what: string) => {
        const reply = await read();
        if (reply.code !== code) throw new Error(`SMTP ${what}: ${reply.text}`);
      };

      try {
        await expect(220, "anslutning");
        await write("EHLO localhost");
        await expect(250, "EHLO");
        if (port !== 465) {
          await write("STARTTLS");
          await expect(220, "STARTTLS");
          // Flush any incomplete UTF-8 and reject all plaintext read ahead of TLS.
          const pending = decoder.decode();
          if (buffer || pending) throw new Error("SMTP STARTTLS: oväntade data före TLS.");
          writer.releaseLock();
          reader.releaseLock();
          socket = socket.startTls();
          writer = socket.writable.getWriter();
          reader = socket.readable.getReader();
          await write("EHLO localhost");
          await expect(250, "EHLO");
        }
        if (env.SMTP_USER) {
          await write("AUTH LOGIN");
          await expect(334, "AUTH");
          await write(btoa(env.SMTP_USER));
          await expect(334, "AUTH användare");
          await write(btoa(env.SMTP_PASSWORD ?? ""));
          await expect(235, "inloggning");
        }
        await write(`MAIL FROM:<${address(message.from)}>`);
        await expect(250, "MAIL FROM");
        for (const to of recipients) {
          await write(`RCPT TO:<${to}>`);
          await expect(250, `RCPT TO ${to}`);
        }
        await write("DATA");
        await expect(354, "DATA");
        await write(`${data.replace(/\r\n\./g, "\r\n..")}\r\n.`);
        await expect(250, "meddelandet");
        await write("QUIT");
        return { messageId };
      } finally {
        await socket.close().catch(() => undefined);
      }
    },
  };
}
