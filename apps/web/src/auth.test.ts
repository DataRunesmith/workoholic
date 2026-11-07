import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authorizeDashboardRequest, dashboardAuthConfigured, dashboardAuthMode } from "./auth";
import { authenticatedAccessIdentity, resetAccessCertCacheForTests } from "./access-auth";

const TEAM = "yourteam.cloudflareaccess.com";
const AUD = "a".repeat(64);
const ENV = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };
const KID = "test-kid";

let keyPair: CryptoKeyPair;
let publicJwk: JsonWebKey;

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAccessCertCacheForTests();
});

function stubCerts(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    return Response.json({ keys: [{ ...publicJwk, kid: KID }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signJwt(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: KID },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://${TEAM}`,
    aud: [AUD],
    email: "Operator@Example.com",
    sub: "user-1",
    iat: now,
    nbf: now,
    exp: now + 300,
    ...claims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

function request(token?: string, accept = "application/json"): Request {
  const headers = new Headers({ accept });
  if (token) headers.set("cf-access-jwt-assertion", token);
  return new Request("https://workoholic.example.com/api/dashboard", { headers });
}

describe("dashboard auth mode", () => {
  it("uses Cloudflare Access when team domain and AUD are set", () => {
    expect(dashboardAuthMode(ENV)).toBe("access");
    expect(dashboardAuthConfigured(ENV)).toBe(true);
  });

  it("fails closed when Access is not fully configured", () => {
    expect(dashboardAuthMode({})).toBe("misconfigured");
    expect(dashboardAuthMode({ CF_ACCESS_TEAM_DOMAIN: TEAM })).toBe("misconfigured");
    expect(
      dashboardAuthMode({ CF_ACCESS_TEAM_DOMAIN: "evil.example.com", CF_ACCESS_AUD: AUD }),
    ).toBe("misconfigured");
    expect(dashboardAuthConfigured({})).toBe(false);
  });

  it("does not recognize legacy GitHub or Basic Auth variables", () => {
    expect(
      dashboardAuthMode({
        GITHUB_OAUTH_CLIENT_ID: "github-client",
        GITHUB_OAUTH_CLIENT_SECRET: "secret",
        WORKOHOLIC_ALLOWED_GITHUB_IDS: "123",
        DASHBOARD_USERNAME: "operator",
      } as never),
    ).toBe("misconfigured");
  });
});

describe("Cloudflare Access assertion", () => {
  it("accepts a valid signed assertion and normalizes the email", async () => {
    stubCerts();
    const identity = await authenticatedAccessIdentity(request(await signJwt({})), ENV);
    expect(identity).toEqual({ email: "operator@example.com", sub: "user-1" });
  });

  it("caches the signing keys between requests", async () => {
    const fetchMock = stubCerts();
    await authenticatedAccessIdentity(request(await signJwt({})), ENV);
    await authenticatedAccessIdentity(request(await signJwt({})), ENV);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing header", undefined],
    ["wrong audience", { aud: ["b".repeat(64)] }],
    ["wrong issuer", { iss: "https://other.cloudflareaccess.com" }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ["not yet valid", { nbf: Math.floor(Date.now() / 1000) + 3600 }],
    ["missing email", { email: "" }],
  ])("rejects %s", async (_label, claims) => {
    stubCerts();
    const token = claims ? await signJwt(claims) : undefined;
    expect(await authenticatedAccessIdentity(request(token), ENV)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    stubCerts();
    const [header, , signature] = (await signJwt({})).split(".");
    const forged = b64url(
      JSON.stringify({
        iss: `https://${TEAM}`,
        aud: [AUD],
        email: "attacker@example.com",
        sub: "x",
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    );
    expect(
      await authenticatedAccessIdentity(request(`${header}.${forged}.${signature}`), ENV),
    ).toBeNull();
  });

  it("rejects an unknown key id and non-RS256 algorithms", async () => {
    stubCerts();
    expect(
      await authenticatedAccessIdentity(
        request(await signJwt({}, { alg: "RS256", kid: "other" })),
        ENV,
      ),
    ).toBeNull();
    expect(
      await authenticatedAccessIdentity(request(await signJwt({}, { alg: "none", kid: KID })), ENV),
    ).toBeNull();
  });

  it("fails closed when the certificate endpoint is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    expect(await authenticatedAccessIdentity(request(await signJwt({})), ENV)).toBeNull();
  });
});

describe("authorizeDashboardRequest", () => {
  it("lets a verified Access identity through", async () => {
    stubCerts();
    expect(await authorizeDashboardRequest(request(await signJwt({})), ENV)).toBeNull();
  });

  it("returns 401 JSON without an assertion", async () => {
    const response = await authorizeDashboardRequest(request(), ENV);
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ error: "authentication required" });
  });

  it("returns a 403 page for browsers without an assertion", async () => {
    const response = await authorizeDashboardRequest(request(undefined, "text/html"), ENV);
    expect(response?.status).toBe(403);
    expect(await response?.text()).toContain("Cloudflare Access");
  });

  it("returns 503 when Access is not configured", async () => {
    const response = await authorizeDashboardRequest(request(), {});
    expect(response?.status).toBe(503);
  });
});
