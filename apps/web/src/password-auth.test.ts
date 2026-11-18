import { describe, expect, it } from "vitest";
import { authorizeDashboardRequest, dashboardAuthMode } from "./auth";
import { passwordAuthRoute, passwordIdentity } from "./password-auth";

function fakeDb(initialAttempts = 0, initialWindow = 0) {
  let attempts = initialAttempts;
  let windowStartedAt = initialWindow;
  const revoked = new Set<string>();
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args;
          return statement;
        },
        async first() {
          if (sql.includes("FROM dashboard_revoked_sessions")) {
            return revoked.has(String(values[0])) ? { revoked: 1 } : null;
          }
          if (!sql.includes("RETURNING attempts")) return null;
          const now = Number(values[1]);
          const resetBefore = Number(values[2]);
          if (windowStartedAt <= resetBefore) {
            attempts = 1;
            windowStartedAt = now;
          } else {
            attempts += 1;
          }
          return { attempts };
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO dashboard_revoked_sessions")) {
            revoked.add(String(values[0]));
          }
          if (sql.includes("DELETE FROM dashboard_login_attempts WHERE bucket_key")) {
            attempts = 0;
            windowStartedAt = 0;
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, attempts: () => attempts, revoked };
}

const rateLimit = fakeDb();
const env = {
  AUTH_MODE: "password",
  ADMIN_PASSWORD: "correct horse battery",
  DB: rateLimit.db,
};
const at = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (init.method && !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase()) && !headers.has("origin")) {
    headers.set("origin", "http://localhost:8787");
  }
  return new Request(`http://localhost:8787${path}`, { ...init, headers });
};
const login = (password: string) =>
  passwordAuthRoute(
    at("/auth/login", { method: "POST", body: new URLSearchParams({ password }) }),
    env,
  );

describe("password mode", () => {
  it("is chosen by AUTH_MODE and needs a long enough password", () => {
    expect(dashboardAuthMode(env)).toBe("password");
    expect(dashboardAuthMode({ AUTH_MODE: "password", ADMIN_PASSWORD: "short" })).toBe(
      "misconfigured",
    );
    expect(dashboardAuthMode({})).toBe("misconfigured");
  });

  it("sends browsers to the login page and API calls a 401", async () => {
    const page = await authorizeDashboardRequest(
      at("/", { headers: { accept: "text/html" } }),
      env,
    );
    expect(page?.status).toBe(303);
    expect(page?.headers.get("location")).toBe("/auth/login");
    expect((await authorizeDashboardRequest(at("/api/dashboard"), env))?.status).toBe(401);
  });

  it("rejects a wrong password and signs in with the right one", async () => {
    expect((await login("wrong"))?.status).toBe(401);
    const ok = await login("correct horse battery");
    expect(ok?.status).toBe(303);
    const cookie = ok!.headers.get("set-cookie")!.split(";")[0];
    expect(await passwordIdentity(at("/", { headers: { cookie } }), env)).toMatchObject({
      email: "admin",
    });
    expect(
      await authorizeDashboardRequest(at("/api/dashboard", { headers: { cookie } }), env),
    ).toBe(null);
    expect(await passwordIdentity(at("/", { headers: { cookie: `${cookie}x` } }), env)).toBe(null);
    expect(
      await passwordIdentity(at("/", { headers: { cookie: `${cookie}; ${cookie}` } }), env),
    ).toBe(null);
    const otherPassword = { ...env, ADMIN_PASSWORD: "another long password" };
    expect(await passwordIdentity(at("/", { headers: { cookie } }), otherPassword)).toBe(null);
    expect(rateLimit.attempts()).toBe(0);
  });

  it("blocks a request when the IP bucket is already over its limit", async () => {
    const blocked = fakeDb(10, Date.now());
    const response = await passwordAuthRoute(
      at("/auth/login", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.7" },
        body: new URLSearchParams({ password: "wrong" }),
      }),
      { ...env, DB: blocked.db },
    );
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("900");
    expect(await response?.text()).toContain("För många inloggningsförsök");
    expect(blocked.attempts()).toBe(11);
  });

  it("uses a larger shared bucket when no client IP is known", async () => {
    const shared = fakeDb(10, Date.now());
    const response = await passwordAuthRoute(
      at("/auth/login", { method: "POST", body: new URLSearchParams({ password: "wrong" }) }),
      { ...env, DB: shared.db },
    );
    expect(response?.status).toBe(401);
    const full = fakeDb(100, Date.now());
    const blocked = await passwordAuthRoute(
      at("/auth/login", { method: "POST", body: new URLSearchParams({ password: "wrong" }) }),
      { ...env, DB: full.db },
    );
    expect(blocked?.status).toBe(429);
  });

  it("rejects a session after logout and fails closed if revocations cannot be read", async () => {
    const store = fakeDb();
    const e = { ...env, DB: store.db };
    const ok = await passwordAuthRoute(
      at("/auth/login", { method: "POST", body: new URLSearchParams({ password: env.ADMIN_PASSWORD }) }),
      e,
    );
    const cookie = ok!.headers.get("set-cookie")!.split(";")[0];
    expect(cookie).toMatch(/=\d{10}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(await passwordIdentity(at("/", { headers: { cookie } }), e)).not.toBe(null);
    const out = await passwordAuthRoute(at("/auth/logout", { method: "POST", headers: { cookie } }), e);
    expect(out?.status).toBeLessThan(400);
    expect(store.revoked.size).toBe(1);
    expect(await passwordIdentity(at("/", { headers: { cookie } }), e)).toBe(null);
    const again = await passwordAuthRoute(
      at("/auth/login", { method: "POST", body: new URLSearchParams({ password: env.ADMIN_PASSWORD }) }),
      e,
    );
    const cookie2 = again!.headers.get("set-cookie")!.split(";")[0];
    const failing = {
      prepare: (sql: string) =>
        sql.includes("dashboard_revoked_sessions") ? { bind: () => ({ run: async () => { throw new Error("down"); } }) } : store.db.prepare(sql),
    } as unknown as D1Database;
    const failed = await passwordAuthRoute(
      at("/auth/logout", { method: "POST", headers: { cookie: cookie2 } }),
      { ...env, DB: failing },
    );
    expect(failed?.status).toBe(503);
    expect(failed?.headers.get("set-cookie")).toBe(null);
    const broken = { prepare: () => { throw new Error("down"); } } as unknown as D1Database;
    expect(await passwordIdentity(at("/", { headers: { cookie } }), { ...env, DB: broken })).toBe(null);
  });

  it("answers 503 when the rate-limit storage is unavailable", async () => {
    const response = await passwordAuthRoute(
      at("/auth/login", { method: "POST", body: new URLSearchParams({ password: "wrong" }) }),
      { ...env, DB: undefined },
    );
    expect(response?.status).toBe(503);
  });

  it("answers 400 when the request body cannot be read", async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error("socket closed"));
      },
    });
    const response = await passwordAuthRoute(
      new Request("https://jobb.example/auth/login", {
        method: "POST",
        headers: { origin: "https://jobb.example" },
        body,
        duplex: "half",
      } as RequestInit),
      env,
    );
    expect(response?.status).toBe(400);
  });

  it("rejects oversized login bodies before parsing form data", async () => {
    const response = await passwordAuthRoute(
      at("/auth/login", {
        method: "POST",
        body: "x".repeat(9000),
      }),
      env,
    );
    expect(response?.status).toBe(413);
  });

  it("rejects cross-origin password login and logout mutations", async () => {
    const loginResponse = await passwordAuthRoute(
      at("/auth/login", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
        body: new URLSearchParams({ password: "correct horse battery" }),
      }),
      env,
    );
    expect(loginResponse?.status).toBe(403);

    const logoutResponse = await passwordAuthRoute(
      at("/auth/logout", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      }),
      env,
    );
    expect(logoutResponse?.status).toBe(403);
  });

  it("logs out by clearing the cookie", async () => {
    const out = await passwordAuthRoute(at("/cdn-cgi/access/logout", { method: "POST" }), env);
    expect(out?.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
