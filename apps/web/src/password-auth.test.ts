import { describe, expect, it } from "vitest";
import { authorizeDashboardRequest, dashboardAuthMode } from "./auth";
import { passwordAuthRoute, passwordIdentity } from "./password-auth";

const env = { AUTH_MODE: "password", ADMIN_PASSWORD: "correct horse battery" };
const at = (path: string, init?: RequestInit) => new Request(`http://localhost:8787${path}`, init);
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
    const otherPassword = { ...env, ADMIN_PASSWORD: "another long password" };
    expect(await passwordIdentity(at("/", { headers: { cookie } }), otherPassword)).toBe(null);
  });

  it("logs out by clearing the cookie", async () => {
    const out = await passwordAuthRoute(at("/cdn-cgi/access/logout"), env);
    expect(out?.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
