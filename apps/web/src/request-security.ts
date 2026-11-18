const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The public origin of the site. Behind a TLS-terminating proxy request.url is
 * plain http, so a mutation is also accepted from the configured PUBLIC_BASE_URL.
 */
export function publicOrigin(request: Request, publicBaseUrl?: string): string {
  if (publicBaseUrl) {
    try {
      return new URL(publicBaseUrl).origin;
    } catch {
      // A malformed value falls back to the request URL.
    }
  }
  return new URL(request.url).origin;
}

export function requireSameOriginMutation(request: Request, publicBaseUrl?: string): Response | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const requestOrigin = new URL(request.url).origin;
  const publicSiteOrigin = publicOrigin(request, publicBaseUrl);
  const origin = request.headers.get("origin");
  if (!origin) return forbidden();

  try {
    if (![requestOrigin, publicSiteOrigin].includes(new URL(origin).origin)) return forbidden();
  } catch {
    return forbidden();
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return forbidden();
  }

  return null;
}

function forbidden(): Response {
  return new Response("Cross-origin mutation rejected.", { status: 403 });
}

/** 413 when the body is over the limit, 400 when it cannot be read, otherwise null. */
export async function requestBodyRejection(request: Request, maxBytes: number): Promise<Response | null> {
  try {
    if (await requestBodyExceedsLimit(request, maxBytes)) {
      return Response.json({ error: "För stor begäran" }, { status: 413, headers: { "cache-control": "no-store" } });
    }
    return null;
  } catch {
    return Response.json({ error: "Begäran kunde inte läsas." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}

export async function requestBodyExceedsLimit(request: Request, maxBytes: number): Promise<boolean> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return true;
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > maxBytes) return true;
  }

  const body = request.clone().body;
  if (!body) return false;
  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      total += value.byteLength;
      if (total > maxBytes) {
        await Promise.allSettled([
          reader.cancel(),
          request.body?.cancel() ?? Promise.resolve(),
        ]);
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
