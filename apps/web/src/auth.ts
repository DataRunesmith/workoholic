import { renderErrorPage } from "./auth-ui";
import {
  accessAuthConfigurationState,
  authenticatedAccessIdentity,
  type AccessAuthEnv,
  type AccessIdentity,
} from "./access-auth";
import {
  passwordAuthConfigured,
  passwordIdentity,
  passwordModeRequested,
  type PasswordAuthEnv,
} from "./password-auth";

export type DashboardAuthEnv = AccessAuthEnv & PasswordAuthEnv;

export type DashboardAuthMode = "access" | "password" | "misconfigured";

export function dashboardAuthMode(env: DashboardAuthEnv): DashboardAuthMode {
  if (passwordModeRequested(env)) return passwordAuthConfigured(env) ? "password" : "misconfigured";
  return accessAuthConfigurationState(env) === "ready" ? "access" : "misconfigured";
}

export function dashboardAuthConfigured(env: DashboardAuthEnv): boolean {
  return dashboardAuthMode(env) !== "misconfigured";
}

/** The signed-in user: the Access identity, or the single password-mode admin. */
export function authenticatedIdentity(
  request: Request,
  env: DashboardAuthEnv,
): Promise<AccessIdentity | null> {
  return dashboardAuthMode(env) === "password"
    ? passwordIdentity(request, env)
    : authenticatedAccessIdentity(request, env);
}

export async function authorizeDashboardRequest(
  request: Request,
  env: DashboardAuthEnv,
): Promise<Response | null> {
  const acceptsHtml = request.headers.get("accept")?.includes("text/html") ?? false;

  const mode = dashboardAuthMode(env);
  if (mode === "misconfigured") {
    if (request.method === "GET" && acceptsHtml) {
      return renderErrorPage({
        status: 503,
        eyebrow: "Säker inloggning",
        title: "Autentisering är inte redo",
        message: passwordModeRequested(env)
          ? "AUTH_MODE=password kräver ADMIN_PASSWORD (minst 8 tecken). Tjänsten är låst tills det är satt."
          : "Cloudflare Access-konfigurationen (CF_ACCESS_TEAM_DOMAIN och CF_ACCESS_AUD) är inte komplett. Tjänsten är låst tills den är verifierad.",
        code: "auth_unavailable",
      });
    }
    return Response.json(
      { error: "dashboard authentication is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  if (await authenticatedIdentity(request, env)) return null;

  if (mode === "password") {
    if (request.method === "GET" && acceptsHtml) {
      return new Response(null, {
        status: 303,
        headers: { location: "/auth/login", "cache-control": "no-store" },
      });
    }
    return Response.json(
      { error: "authentication required" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  // Cloudflare Access redirects unauthenticated browsers before they reach the
  // Worker, so a missing or invalid assertion here means Access was bypassed.
  if (request.method === "GET" && acceptsHtml) {
    return renderErrorPage({
      status: 403,
      eyebrow: "Säker inloggning",
      title: "Åtkomst nekad",
      message:
        "Begäran saknar en giltig Cloudflare Access-identitet. Öppna sidan igen för att logga in via Cloudflare Access.",
      code: "access_required",
    });
  }
  return Response.json(
    { error: "authentication required" },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}
