// Self-hosted alternative to Cloudflare Access: AUTH_MODE=password protects the
// dashboard with ADMIN_PASSWORD and an HMAC-signed session cookie.
import { renderLoginPage } from "./auth-ui";
import { requireSameOriginMutation, requestBodyExceedsLimit } from "./request-security";
import type { AccessIdentity } from "./access-auth";

export interface PasswordAuthEnv {
  AUTH_MODE?: string;
  ADMIN_PASSWORD?: string;
  DB?: D1Database;
}

const SESSION_COOKIE = "jobb_session";
const SESSION_SECONDS = 12 * 60 * 60;
const MIN_PASSWORD_LENGTH = 16;
const MAX_LOGIN_BODY_BYTES = 8 * 1024;
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const encoder = new TextEncoder();

export const PASSWORD_IDENTITY: AccessIdentity = { email: "admin", sub: "password" };

export async function passwordLoginRateLimitReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_login_attempts'",
      )
      .first<{ name: string }>();
    return row?.name === "dashboard_login_attempts";
  } catch {
    return false;
  }
}

export function passwordModeRequested(env: PasswordAuthEnv): boolean {
  return env.AUTH_MODE === "password";
}

export function passwordAuthConfigured(env: PasswordAuthEnv): boolean {
  return passwordModeRequested(env) && (env.ADMIN_PASSWORD ?? "").length >= MIN_PASSWORD_LENGTH;
}

async function sessionMac(password: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return btoa(String.fromCharCode(...mac))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function sessionCookie(request: Request): string {
  let found: string | null = null;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== SESSION_COOKIE) continue;
    if (found !== null) return "";
    found = value.join("=");
  }
  return found ?? "";
}

export async function passwordIdentity(
  request: Request,
  env: PasswordAuthEnv,
  now = Date.now(),
): Promise<AccessIdentity | null> {
  if (!passwordAuthConfigured(env)) return null;
  const [expiry, mac, extra] = sessionCookie(request).split(".");
  if (
    extra !== undefined ||
    !/^\d{10}$/.test(expiry ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(mac ?? "")
  ) {
    return null;
  }
  const expirySeconds = Number(expiry);
  if (
    !Number.isSafeInteger(expirySeconds) ||
    expirySeconds * 1000 <= now ||
    expirySeconds * 1000 > now + SESSION_SECONDS * 1000
  ) {
    return null;
  }
  return timingSafeEqual(await sessionMac(env.ADMIN_PASSWORD!, expiry), mac)
    ? PASSWORD_IDENTITY
    : null;
}

function cookieAttributes(request: Request, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}


async function loginAttemptKey(request: Request): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(`workoholic-password-login:${ip}`)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function reserveLoginAttempt(request: Request, env: PasswordAuthEnv): Promise<string | null> {
  const db = env.DB;
  if (!db) throw new Error("Password login rate-limit storage is unavailable");
  const key = await loginAttemptKey(request);
  const now = Date.now();
  const row = await db.prepare(
    `INSERT INTO dashboard_login_attempts (bucket_key, attempts, window_started_at)
     VALUES (?, 1, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET
       attempts = CASE
         WHEN dashboard_login_attempts.window_started_at <= ? THEN 1
         ELSE dashboard_login_attempts.attempts + 1
       END,
       window_started_at = CASE
         WHEN dashboard_login_attempts.window_started_at <= ? THEN excluded.window_started_at
         ELSE dashboard_login_attempts.window_started_at
       END
     RETURNING attempts`,
  )
    .bind(key, now, now - LOGIN_WINDOW_MS, now - LOGIN_WINDOW_MS)
    .first<{ attempts: number }>();
  await db.prepare("DELETE FROM dashboard_login_attempts WHERE window_started_at < ?")
    .bind(now - 24 * 60 * 60 * 1000)
    .run()
    .catch(() => undefined);
  return Number(row?.attempts ?? MAX_LOGIN_ATTEMPTS + 1) <= MAX_LOGIN_ATTEMPTS ? key : null;
}

/** Login and logout routes for password mode; null for every other request. */
export async function passwordAuthRoute(
  request: Request,
  env: PasswordAuthEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (
    (pathname === "/auth/login" && request.method === "POST") ||
    pathname === "/auth/logout" ||
    pathname === "/cdn-cgi/access/logout"
  ) {
    const originFailure = requireSameOriginMutation(request);
    if (originFailure) return originFailure;
  }
  if (pathname === "/auth/login" && request.method === "GET") return renderLoginPage();
  if (pathname === "/auth/login" && request.method === "POST") {
    if (await requestBodyExceedsLimit(request, MAX_LOGIN_BODY_BYTES))
      return new Response("För stor begäran", { status: 413, headers: { "cache-control": "no-store" } });

    let attemptKey: string | null;
    try {
      attemptKey = await reserveLoginAttempt(request, env);
    } catch {
      return renderLoginPage("Inloggningsskyddet är tillfälligt otillgängligt. Försök igen senare.");
    }
    if (!attemptKey)
      return renderLoginPage("För många inloggningsförsök. Vänta 15 minuter och försök igen.");

    const form = await request.formData().catch(() => null);
    const given = String(form?.get("password") ?? "");
    if (!passwordAuthConfigured(env) || !timingSafeEqual(given, env.ADMIN_PASSWORD!)) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return renderLoginPage(
        passwordAuthConfigured(env) ? "Fel lösenord." : "ADMIN_PASSWORD saknas eller är för kort.",
      );
    }

    try {
      await env.DB!.prepare("DELETE FROM dashboard_login_attempts WHERE bucket_key = ?")
        .bind(attemptKey)
        .run();
    } catch (error) {
      console.error("Could not clear password login attempts", error);
    }

    const expiry = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
    const value = `${expiry}.${await sessionMac(env.ADMIN_PASSWORD!, expiry)}`;
    return new Response(null, {
      status: 303,
      headers: {
        location: "/",
        "set-cookie": `${SESSION_COOKIE}=${value}; ${cookieAttributes(request, SESSION_SECONDS)}`,
        "cache-control": "no-store",
      },
    });
  }
  if (request.method === "POST" && (pathname === "/auth/logout" || pathname === "/cdn-cgi/access/logout")) {
    return new Response(null, {
      status: 303,
      headers: {
        location: "/auth/login",
        "set-cookie": `${SESSION_COOKIE}=; ${cookieAttributes(request, 0)}`,
        "cache-control": "no-store",
      },
    });
  }
  return null;
}
