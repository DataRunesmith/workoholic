import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Use the real SMTP binding with scripted plaintext and TLS socket streams.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets") {
      return {
        url: "data:text/javascript,export const connect = (...args) => globalThis.smtpConnect(...args)",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { smtpBinding } = await import("../docker/smtp.ts");
const encoder = new TextEncoder();

function smtpSession({
  startTlsChunks = ["220 Ready to start TLS\r\n"],
  secureReplies,
  direct = false,
}) {
  const commands = [];
  const plainReplies = ["220 greeting\r\n", "250-localhost\r\n250 STARTTLS\r\n", ...startTlsChunks];
  const defaultReplies = [
    "250 EHLO\r\n",
    "334 username\r\n",
    "334 password\r\n",
    "235 authenticated\r\n",
    "250 sender\r\n",
    "250 recipient\r\n",
    "354 data\r\n",
    "250 accepted\r\n",
  ];
  const tlsReplies = secureReplies ?? defaultReplies;
  let upgrades = 0;
  let closed = 0;
  let plainReadsAtUpgrade;
  function socket(replies, isPlain) {
    let reads = 0;
    return {
      readable: {
        getReader: () => ({
          async read() {
            reads++;
            const value = replies.shift();
            return value === undefined
              ? { done: true }
              : { done: false, value: typeof value === "string" ? encoder.encode(value) : value };
          },
          releaseLock() {},
        }),
      },
      writable: {
        getWriter: () => ({
          async write(value) {
            commands.push(new TextDecoder().decode(value));
          },
          releaseLock() {},
        }),
      },
      startTls() {
        assert.equal(isPlain, true);
        upgrades++;
        plainReadsAtUpgrade = reads;
        return socket(tlsReplies, false);
      },
      async close() {
        closed++;
      },
    };
  }
  globalThis.smtpConnect = (_address, options) => {
    assert.equal(options.secureTransport, direct ? "on" : "starttls");
    return direct ? socket(["220 greeting\r\n", ...tlsReplies], false) : socket(plainReplies, true);
  };
  return {
    send: () =>
      smtpBinding({
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: direct ? "465" : "587",
        SMTP_USER: "user",
        SMTP_PASSWORD: "password",
      }).send({ from: "from@example.com", to: "to@example.com", subject: "Test", text: "body" }),
    commands,
    get upgrades() {
      return upgrades;
    },
    get closed() {
      return closed;
    },
    get plainReadsAtUpgrade() {
      return plainReadsAtUpgrade;
    },
  };
}

test("rejects forged plaintext replies after STARTTLS acceptance", async () => {
  const session = smtpSession({
    startTlsChunks: [
      "220 Ready\r\n250 EHLO\r\n334 username\r\n334 password\r\n235 authenticated\r\n250 sender\r\n250 recipient\r\n354 data\r\n250 accepted\r\n",
    ],
    secureReplies: [],
  });
  await assert.rejects(session.send(), /STARTTLS/);
  assert.equal(session.upgrades, 0);
  assert.equal(session.closed, 1);
  assert.deepEqual(session.commands, ["EHLO localhost\r\n", "STARTTLS\r\n"]);
});

test("rejects partial plaintext and incomplete UTF-8 at the STARTTLS boundary", async () => {
  for (const extra of [encoder.encode("250 forged"), Uint8Array.of(0xe2)]) {
    const prefix = encoder.encode("220 Ready\r\n");
    const session = smtpSession({ startTlsChunks: [new Uint8Array([...prefix, ...extra])] });
    await assert.rejects(session.send(), /STARTTLS/);
    assert.equal(session.upgrades, 0);
    assert.equal(session.closed, 1);
  }
});

test("waits for a complete fragmented STARTTLS reply and sends over TLS", async () => {
  const session = smtpSession({ startTlsChunks: ["220 Ready\r", "\n"] });
  const result = await session.send();
  assert.match(result.messageId, /^<.+@example\.com>$/);
  assert.equal(session.plainReadsAtUpgrade, 4);
  assert.equal(session.upgrades, 1);
  assert.equal(session.closed, 1);
  assert.equal(session.commands.at(-1), "QUIT\r\n");
});

test("requires the secure server to accept the message", async () => {
  const session = smtpSession({
    secureReplies: [
      "250 EHLO\r\n",
      "334 username\r\n",
      "334 password\r\n",
      "235 authenticated\r\n",
      "250 sender\r\n",
      "250 recipient\r\n",
      "354 data\r\n",
      "550 rejected\r\n",
    ],
  });
  await assert.rejects(session.send(), /SMTP meddelandet: 550 rejected/);
  assert.equal(session.upgrades, 1);
  assert.equal(session.closed, 1);
  assert.notEqual(session.commands.at(-1), "QUIT\r\n");
});

test("still sends through direct TLS", async () => {
  const session = smtpSession({ direct: true });
  await session.send();
  assert.equal(session.upgrades, 0);
  assert.equal(session.closed, 1);
  assert.equal(session.commands.at(-1), "QUIT\r\n");
});
