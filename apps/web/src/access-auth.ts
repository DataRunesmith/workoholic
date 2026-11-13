// Cloudflare Access is the only dashboard authentication path. Access sits in
// front of the dashboard; the Worker still verifies the signed assertion so a
// request that bypasses Access (or a misconfigured policy) is never trusted.

const ASSERTION_HEADER = "cf-access-jwt-assertion";
const CERT_CACHE_MS = 15 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const FETCH_TIMEOUT_MS = 8_000;
const FORCED_REFRESH_COOLDOWN_MS = 30_000;
const TEAM_DOMAIN_PATTERN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;
const AUD_PATTERN = /^[a-f0-9]{64}$/;

export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

export interface AccessAuthEnv {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}

export interface AccessIdentity {
  email: string;
  sub: string;
}

interface AccessJwk extends JsonWebKey {
  kid?: string;
}

interface CertCache {
  url: string;
  expires: number;
  keys: AccessJwk[];
}

let certCache: CertCache | null = null;
let lastForcedRefresh: { url: string; at: number } | null = null;

export function accessAuthConfigurationState(env: AccessAuthEnv): "ready" | "misconfigured" {
  const team = env.CF_ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const aud = env.CF_ACCESS_AUD?.trim() ?? "";
  return TEAM_DOMAIN_PATTERN.test(team) && AUD_PATTERN.test(aud) ? "ready" : "misconfigured";
}

export async function authenticatedAccessIdentity(
  request: Request,
  env: AccessAuthEnv,
  now = Date.now(),
): Promise<AccessIdentity | null> {
  if (accessAuthConfigurationState(env) !== "ready") return null;
  const team = env.CF_ACCESS_TEAM_DOMAIN!.trim();
  const aud = env.CF_ACCESS_AUD!.trim();

  const token = request.headers.get(ASSERTION_HEADER);
  if (!token || token.length > 8_192) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header: { alg?: unknown; kid?: unknown };
  let payload: {
    iss?: unknown;
    aud?: unknown;
    exp?: unknown;
    nbf?: unknown;
    iat?: unknown;
    email?: unknown;
    sub?: unknown;
  };
  try {
    header = JSON.parse(decodeText(parts[0]));
    payload = JSON.parse(decodeText(parts[1]));
  } catch {
    return null;
  }

  if (
    !header ||
    typeof header !== "object" ||
    Array.isArray(header) ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }

  const nowSeconds = Math.floor(now / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    !header.kid ||
    header.kid.length > 256 ||
    payload.iss !== `https://${team}` ||
    !Array.isArray(audiences) ||
    audiences.length > 10 ||
    !audiences.includes(aud) ||
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp + CLOCK_SKEW_SECONDS <= nowSeconds ||
    typeof payload.iat !== "number" ||
    !Number.isSafeInteger(payload.iat) ||
    payload.iat - CLOCK_SKEW_SECONDS > nowSeconds ||
    payload.exp <= payload.iat ||
    (payload.nbf !== undefined &&
      (typeof payload.nbf !== "number" ||
        !Number.isSafeInteger(payload.nbf) ||
        payload.nbf - CLOCK_SKEW_SECONDS > nowSeconds)) ||
    typeof payload.email !== "string" ||
    !payload.email ||
    payload.email.length > 320 ||
    /[\u0000-\u001f\u007f]/.test(payload.email) ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    payload.sub.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(payload.sub)
  ) {
    return null;
  }

  let keys = await accessSigningKeys(team, now);
  let jwk = keys?.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) {
    keys = await accessSigningKeys(team, now, true);
    jwk = keys?.find((key) => key.kid === header.kid && key.kty === "RSA");
  }
  if (!jwk) return null;

  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      decodeBase64url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    return valid ? { email: payload.email.toLowerCase(), sub: payload.sub } : null;
  } catch {
    return null;
  }
}

async function accessSigningKeys(team: string, now: number, forceRefresh = false): Promise<AccessJwk[] | null> {
  const url = `https://${team}/cdn-cgi/access/certs`;
  if (!forceRefresh && certCache?.url === url && certCache.expires > now) return certCache.keys;
  if (
    forceRefresh &&
    lastForcedRefresh?.url === url &&
    now - lastForcedRefresh.at < FORCED_REFRESH_COOLDOWN_MS
  ) {
    return certCache?.url === url ? certCache.keys : null;
  }
  if (forceRefresh) lastForcedRefresh = { url, at: now };
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json<{ keys?: unknown }>();
    if (!Array.isArray(data.keys)) return null;
    certCache = { url, expires: now + CERT_CACHE_MS, keys: data.keys as AccessJwk[] };
    return certCache.keys;
  } catch {
    return null;
  }
}

export function resetAccessCertCacheForTests(): void {
  certCache = null;
  lastForcedRefresh = null;
}

function decodeText(value: string): string {
  return new TextDecoder().decode(decodeBase64url(value));
}

function decodeBase64url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
