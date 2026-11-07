const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireSameOriginMutation(request: Request): Response | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (!origin) return forbidden();

  try {
    if (new URL(origin).origin !== requestUrl.origin) return forbidden();
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
