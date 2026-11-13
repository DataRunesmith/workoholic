import { describe, expect, it } from "vitest";
import { authorizeDashboardRequest, dashboardAuthMode } from "./auth";
import { passwordAuthRoute, passwordIdentity } from "./password-auth";

function fakeDb(initialAttempts = 0, initialWindow = 0) {
  let attempts = initialAttempts;
  let windowStartedAt = initialWindow;
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args;
          return statement;
        },
        async first() {
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
  return { db, attempts: () => attempts };
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
      at("/auth/login", { method: "POST", body: new URLSearchParams({ password: "wrong" }) }),
      { ...env, DB: blocked.db },
    );
    expect(await response?.text()).toContain("För många inloggningsförsök");
    expect(blocked.attempts()).toBe(11);
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
