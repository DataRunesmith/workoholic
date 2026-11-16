// Self-hosted alternative to Cloudflare Access: AUTH_MODE=password protects the
// dashboard with ADMIN_PASSWORD and an HMAC-signed session cookie.
import { renderLoginPage } from "./auth-ui";
import { publicOrigin, requireSameOriginMutation, requestBodyRejection } from "./request-security";
import type { AccessIdentity } from "./access-auth";

export interface PasswordAuthEnv {
  AUTH_MODE?: string;
  ADMIN_PASSWORD?: string;
  PUBLIC_BASE_URL?: string;
  DB?: D1Database;
}

const SESSION_COOKIE = "jobb_session";
const SESSION_SECONDS = 12 * 60 * 60;
const MIN_PASSWORD_LENGTH = 16;
const MAX_LOGIN_BODY_BYTES = 8 * 1024;
// Without a client IP (self-hosted) every client shares one bucket, so its limit
// is higher: a handful of bad requests must not lock the admin out.
const MAX_LOGIN_ATTEMPTS_PER_IP = 10;
const MAX_LOGIN_ATTEMPTS_SHARED = 100;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const encoder = new TextEncoder();

export const PASSWORD_IDENTITY: AccessIdentity = { email: "admin", sub: "password" };

export async function passwordLoginRateLimitReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS found FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('dashboard_login_attempts', 'dashboard_revoked_sessions')`,
      )
      .first<{ found: number }>();
    return Number(row?.found ?? 0) === 2;
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

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// The password is never the MAC key itself: a key is derived from it for this
// one purpose, so the cookie MAC is not an oracle for the password.
async function sessionMac(password: string, value: string): Promise<string> {
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign("HMAC", base, encoder.encode("workoholic-session-v2"));
  const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
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

interface VerifiedSession {
  id: string;
  expiresAtSeconds: number;
}

/** The session in the request's cookie when its signature and expiry are valid. */
async function verifiedSession(
  request: Request,
  env: PasswordAuthEnv,
  now: number,
): Promise<VerifiedSession | null> {
  if (!passwordAuthConfigured(env)) return null;
  const [expiry, id, mac, extra] = sessionCookie(request).split(".");
  if (
    extra !== undefined ||
    !/^\d{10}$/.test(expiry ?? "") ||
    !/^[A-Za-z0-9_-]{22}$/.test(id ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(mac ?? "")
  ) {
    return null;
  }
  const expiresAtSeconds = Number(expiry);
  if (
    expiresAtSeconds * 1000 <= now ||
    expiresAtSeconds * 1000 > now + SESSION_SECONDS * 1000
  ) {
    return null;
  }
  return timingSafeEqual(await sessionMac(env.ADMIN_PASSWORD!, `${expiry}.${id}`), mac!)
    ? { id: id!, expiresAtSeconds }
    : null;
}

export async function passwordIdentity(
  request: Request,
  env: PasswordAuthEnv,
  now = Date.now(),
): Promise<AccessIdentity | null> {
  const session = await verifiedSession(request, env, now);
  if (!session) return null;
  // A signed-out session stays rejected until it would have expired anyway.
  // If the revocation list cannot be read, the session is not trusted.
  try {
    const revoked = await env.DB!.prepare(
      "SELECT 1 AS revoked FROM dashboard_revoked_sessions WHERE session_id = ?",
    )
      .bind(session.id)
      .first<{ revoked: number }>();
    return revoked ? null : PASSWORD_IDENTITY;
  } catch {
    return null;
  }
}

function cookieAttributes(request: Request, env: PasswordAuthEnv, maxAge: number): string {
  const secure =
    new URL(request.url).protocol === "https:" || publicOrigin(request, env.PUBLIC_BASE_URL).startsWith("https:")
      ? "; Secure"
      : "";
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}


const bucketKey = async (name: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`workoholic-password-login:${name}`))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

async function countAttempt(db: D1Database, key: string, limit: number): Promise<boolean> {
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
  return Number(row?.attempts ?? limit + 1) <= limit;
}

/**
 * Every attempt counts against a global bucket, so a forged client-IP header
 * cannot buy unlimited tries; with an IP it also counts against that IP's own
 * bucket. Returns the key to clear after a successful login, or null if blocked.
 */
async function reserveLoginAttempt(request: Request, env: PasswordAuthEnv): Promise<string | null> {
  const db = env.DB;
  if (!db) throw new Error("Password login rate-limit storage is unavailable");
  const ip = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  const shared = await bucketKey("unknown");
  const sharedOk = await countAttempt(db, shared, MAX_LOGIN_ATTEMPTS_SHARED);
  const ipKey = ip ? await bucketKey(ip) : shared;
  const ipOk = ip ? await countAttempt(db, ipKey, MAX_LOGIN_ATTEMPTS_PER_IP) : true;
  await db.prepare("DELETE FROM dashboard_login_attempts WHERE window_started_at < ?")
    .bind(Date.now() - 24 * 60 * 60 * 1000)
    .run()
    .catch(() => undefined);
  return sharedOk && ipOk ? ipKey : null;
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
    const originFailure = requireSameOriginMutation(request, env.PUBLIC_BASE_URL);
    if (originFailure) return originFailure;
  }
  if (pathname === "/auth/login" && request.method === "GET") return renderLoginPage();
  if (pathname === "/auth/login" && request.method === "POST") {
    const bodyRejection = await requestBodyRejection(request, MAX_LOGIN_BODY_BYTES);
    if (bodyRejection) return bodyRejection;

    let attemptKey: string | null;
    try {
      attemptKey = await reserveLoginAttempt(request, env);
    } catch {
      return renderLoginPage("Inloggningsskyddet är tillfälligt otillgängligt. Försök igen senare.", 503);
    }
    if (!attemptKey)
      return renderLoginPage(
        "För många inloggningsförsök. Vänta 15 minuter och försök igen.",
        429,
        { "retry-after": String(LOGIN_WINDOW_MS / 1000) },
      );

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
    const id = base64Url(crypto.getRandomValues(new Uint8Array(16)));
    const value = `${expiry}.${id}.${await sessionMac(env.ADMIN_PASSWORD!, `${expiry}.${id}`)}`;
    return new Response(null, {
      status: 303,
      headers: {
        location: "/",
        "set-cookie": `${SESSION_COOKIE}=${value}; ${cookieAttributes(request, env, SESSION_SECONDS)}`,
        "cache-control": "no-store",
      },
    });
  }
  if (request.method === "POST" && (pathname === "/auth/logout" || pathname === "/cdn-cgi/access/logout")) {
    const session = await verifiedSession(request, env, Date.now());
    let revoked = true;
    if (session) {
      try {
        if (!env.DB) throw new Error("no database");
        await env.DB.prepare(
          "INSERT OR IGNORE INTO dashboard_revoked_sessions (session_id, expires_at) VALUES (?, ?)",
        )
          .bind(session.id, session.expiresAtSeconds)
          .run();
        await env.DB.prepare("DELETE FROM dashboard_revoked_sessions WHERE expires_at < ?")
          .bind(Math.floor(Date.now() / 1000))
          .run()
          .catch(() => undefined);
      } catch (error) {
        revoked = false;
        console.error("Could not record the signed-out session", error);
      }
    }
    if (!revoked) {
      return new Response("Utloggningen kunde inte slutföras. Försök igen.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "set-cookie": `${SESSION_COOKIE}=; ${cookieAttributes(request, env, 0)}` },
      });
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: "/auth/login",
        "set-cookie": `${SESSION_COOKIE}=; ${cookieAttributes(request, env, 0)}`,
        "cache-control": "no-store",
      },
    });
  }
  return null;
}
