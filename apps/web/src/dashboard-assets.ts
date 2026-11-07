// The dashboard is static files in public/, served through the ASSETS binding.
// The Worker runs first (run_worker_first) so Access is verified before any of
// them is returned, and the security headers are added here.

const DASHBOARD_PATHS = new Set(["/", "/assets/dashboard.css", "/assets/dashboard.js"]);

const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function isDashboardAsset(request: Request, url: URL): boolean {
  return request.method === "GET" && DASHBOARD_PATHS.has(url.pathname);
}

export async function serveDashboardAsset(request: Request, assets: Fetcher): Promise<Response> {
  const response = await assets.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  if (new URL(request.url).pathname === "/") {
    headers.set("content-security-policy", DASHBOARD_CSP);
    headers.set("referrer-policy", "no-referrer");
  }
  return new Response(response.body, { status: response.status, headers });
}
