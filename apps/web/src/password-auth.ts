// Self-hosted alternative to Cloudflare Access: AUTH_MODE=password protects the
// dashboard with ADMIN_PASSWORD and an HMAC-signed session cookie
// "<expiry>.<mac>". Changing the password logs every session out.
import { renderLoginPage } from "./auth-ui";
import type { AccessIdentity } from "./access-auth";

export interface PasswordAuthEnv {
  AUTH_MODE?: string;
  ADMIN_PASSWORD?: string;
}

const SESSION_COOKIE = "jobb_session";
const SESSION_SECONDS = 30 * 24 * 3600;
const MIN_PASSWORD_LENGTH = 8;
const encoder = new TextEncoder();

export const PASSWORD_IDENTITY: AccessIdentity = { email: "admin", sub: "password" };

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
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
  return "";
}

export async function passwordIdentity(
  request: Request,
  env: PasswordAuthEnv,
  now = Date.now(),
): Promise<AccessIdentity | null> {
  if (!passwordAuthConfigured(env)) return null;
  const [expiry, mac] = sessionCookie(request).split(".");
  if (!expiry || !mac || Number(expiry) < now / 1000) return null;
  return timingSafeEqual(await sessionMac(env.ADMIN_PASSWORD!, expiry), mac)
    ? PASSWORD_IDENTITY
    : null;
}

function cookieAttributes(request: Request, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

/** Login and logout routes for password mode; null for every other request. */
export async function passwordAuthRoute(
  request: Request,
  env: PasswordAuthEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/auth/login" && request.method === "GET") return renderLoginPage();
  if (pathname === "/auth/login" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const given = String(form?.get("password") ?? "");
    if (!passwordAuthConfigured(env) || !timingSafeEqual(given, env.ADMIN_PASSWORD!)) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return renderLoginPage(
        passwordAuthConfigured(env) ? "Fel lösenord." : "ADMIN_PASSWORD saknas eller är för kort.",
      );
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
  if (pathname === "/auth/logout" || pathname === "/cdn-cgi/access/logout") {
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
