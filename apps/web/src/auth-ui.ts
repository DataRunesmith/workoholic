type Theme = "legacy" | "forest" | "blackout";

export interface ErrorPageOptions {
  status: number;
  eyebrow?: string;
  title: string;
  message: string;
  code?: string;
  referenceId?: string;
  primaryHref?: string;
  primaryLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}

export function renderErrorPage(options: ErrorPageOptions): Response {
  const primary =
    options.primaryHref && options.primaryLabel
      ? `<a class="primary-action" href="${escapeHtml(options.primaryHref)}"><span class="action-mark" aria-hidden="true">↻</span><span>${escapeHtml(options.primaryLabel)}</span></a>`
      : "";
  const secondary =
    options.secondaryHref && options.secondaryLabel
      ? `<a class="secondary-action" href="${escapeHtml(options.secondaryHref)}">${escapeHtml(options.secondaryLabel)}</a>`
      : "";

  const metadata = [
    options.code ? `Kod: ${escapeHtml(options.code)}` : "",
    options.referenceId ? `Referens: ${escapeHtml(options.referenceId)}` : "",
  ].filter(Boolean);

  const html = pageShell({
    title: options.title,
    body: `
      <section class="error-layout">
        <div class="error-mark" aria-hidden="true"><span>!</span></div>
        <p class="eyebrow">${escapeHtml(options.eyebrow ?? "Jobb")}</p>
        <h1>${escapeHtml(options.title)}</h1>
        <p class="lead">${escapeHtml(options.message)}</p>
        <div class="actions error-actions">${primary}${secondary}</div>
        ${metadata.length ? `<p class="error-meta">${metadata.join(" · ")}</p>` : ""}
      </section>
    `,
  });

  return htmlResponse(html, options.status);
}

export function renderLoginPage(
  message = "",
  status = message ? 401 : 200,
  headers: Record<string, string> = {},
): Response {
  const html = pageShell({
    title: "Logga in",
    body: `
      <section class="error-layout">
        <p class="eyebrow">Jobb</p>
        <h1>Logga in</h1>
        <form class="actions" method="post" action="/auth/login">
          <input type="password" name="password" autocomplete="current-password" aria-label="Lösenord" placeholder="Lösenord" required autofocus>
          <button class="primary-action" type="submit">Logga in</button>
        </form>
        ${message ? `<p class="lead" role="alert">${escapeHtml(message)}</p>` : ""}
      </section>
    `,
  });
  const response = htmlResponse(html, status);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export function renderAuthStyles(): Response {
  return new Response(AUTH_CSS, {
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function pageShell(options: { title: string; body: string; theme?: Theme }): string {
  const theme = options.theme ?? "legacy";
  const themeColor = theme === "legacy" ? "#04070e" : theme === "forest" ? "#080b09" : "#000000";
  return `<!doctype html>
<html lang="sv" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="${themeColor}">
<title>${escapeHtml(options.title)} · Workoholic · __SITE_FAMILY__</title>
<link rel="stylesheet" href="/assets/auth.css">
</head>
<body>
<main class="page-shell">
${options.body}
</main>
<footer class="site-footer"><span>__SITE_FAMILY__</span><span>Identity protected by Cloudflare Access</span></footer>
</body>
</html>`;
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

const AUTH_CSS = `
:root{
  color-scheme:dark;
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --bg:#04070e;
  --bg-soft:#050912;
  --panel:#09101e;
  --panel-2:#0d182c;
  --line:rgba(137,167,207,.18);
  --line-strong:rgba(137,167,207,.34);
  --muted:#91a8c6;
  --muted-2:#6f88a7;
  --text:#f5f3ee;
  --accent:#7dd3fc;
  --accent-2:#a7f3d0;
  --danger:#fda4af;
  --control:#f5f8fc;
  --control-text:#08111c;
  --shadow:0 28px 80px rgba(0,0,0,.38);
  background:var(--bg);
  color:var(--text)
}
:root[data-theme="forest"]{
  --bg:#080b09;--bg-soft:#0c100d;--panel:#111713;--panel-2:#171f19;
  --line:#263129;--line-strong:#3b493e;--muted:#a6b1aa;--muted-2:#718077;
  --text:#f3f5f1;--control:#f3f5f1;--control-text:#101612
}
:root[data-theme="blackout"]{
  --bg:#000;--bg-soft:#030303;--panel:#070707;--panel-2:#0d0d0d;
  --line:#1a1a1a;--line-strong:#333;--muted:#b5b5b5;--muted-2:#777;
  --text:#f6f6f3;--control:#f6f6f3;--control-text:#090909
}
*{box-sizing:border-box}
html{min-height:100%;background:var(--bg)}
body{
  min-height:100vh;
  margin:0;
  padding:max(24px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));
  background:
    radial-gradient(circle at 16% 8%,color-mix(in srgb,var(--accent) 16%,transparent),transparent 34rem),
    radial-gradient(circle at 82% 18%,color-mix(in srgb,var(--accent-2) 10%,transparent),transparent 28rem),
    linear-gradient(180deg,var(--bg-soft) 0%,var(--bg) 72%);
}
body:before{
  content:"";
  position:fixed;
  inset:0;
  pointer-events:none;
  opacity:.16;
  background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);
  background-size:42px 42px;
  mask-image:linear-gradient(to bottom,#000,transparent 72%);
}
:root[data-theme="legacy"] body{
  background:
    radial-gradient(circle at 14% 8%,rgba(36,231,232,.11),transparent 27rem),
    radial-gradient(circle at 86% 18%,rgba(213,29,203,.10),transparent 30rem),
    radial-gradient(circle at 50% 100%,rgba(45,155,255,.08),transparent 35rem),
    linear-gradient(180deg,#050912 0%,#03060c 100%);
}
:root[data-theme="legacy"] body:before{
  opacity:.18;
  mask-image:linear-gradient(to bottom,#000,transparent 82%);
}
.page-shell{
  width:min(1120px,100%);
  min-height:calc(100vh - 150px);
  margin:0 auto;
  display:grid;
  align-items:center;
}
.auth-layout{
  display:grid;
  grid-template-columns:minmax(0,1.15fr) minmax(360px,.85fr);
  gap:clamp(36px,7vw,96px);
  align-items:center;
  padding:44px 0;
}
.brand-lockup{display:flex;align-items:baseline;gap:10px;margin-bottom:44px}
.brand-kicker{font-size:.78rem;font-weight:850;letter-spacing:.22em;color:var(--accent)}
.brand-product{font-size:.92rem;font-weight:750;color:var(--text)}
.status-pill{
  display:inline-flex;
  align-items:center;
  gap:9px;
  border:1px solid var(--line);
  background:color-mix(in srgb,var(--panel) 72%,transparent);
  border-radius:999px;
  padding:8px 12px;
  color:var(--text);
  font-size:.78rem;
  font-weight:700;
  margin-bottom:20px
}
.status-dot{width:7px;height:7px;border-radius:50%;background:var(--accent-2);box-shadow:0 0 0 4px rgba(167,243,208,.08)}
h1{font-size:clamp(3rem,7vw,5.8rem);line-height:.94;letter-spacing:-.055em;margin:0;max-width:740px}
.lead{font-size:clamp(1rem,2vw,1.22rem);line-height:1.65;color:var(--muted);max-width:620px;margin:24px 0 0}
.trust-row{display:flex;flex-wrap:wrap;gap:9px;color:var(--muted-2);font-size:.78rem;font-weight:650;margin-top:32px}
.auth-card{
  min-height:430px;
  display:flex;
  flex-direction:column;
  justify-content:space-between;
  gap:28px;
  padding:clamp(24px,4vw,38px);
  border:1px solid var(--line);
  border-radius:24px;
  background:linear-gradient(180deg,color-mix(in srgb,var(--panel) 96%,transparent),color-mix(in srgb,var(--panel-2) 94%,transparent));
  box-shadow:var(--shadow);
  backdrop-filter:blur(20px)
}
.eyebrow{margin:0 0 10px;font-size:.72rem;text-transform:uppercase;letter-spacing:.18em;font-weight:850;color:var(--accent)}
h2{font-size:clamp(1.65rem,4vw,2.3rem);line-height:1.08;letter-spacing:-.035em;margin:0}
.card-copy{color:var(--muted);line-height:1.6;margin:14px 0 0}
.actions{display:flex;flex-direction:column;gap:12px}
.primary-action,.secondary-action{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:12px;
  min-height:54px;
  border-radius:13px;
  text-decoration:none;
  font-weight:820;
  transition:transform .15s ease,border-color .15s ease,background .15s ease
}
.primary-action{background:var(--control);color:var(--control-text);border:1px solid var(--control)}
.primary-action:hover{transform:translateY(-1px);background:var(--text)}
.primary-action:focus-visible,.secondary-action:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.secondary-action{background:transparent;color:var(--text);border:1px solid var(--line-strong)}
.secondary-action:hover{border-color:var(--line-strong);background:var(--panel-2)}
.action-mark{
  width:28px;height:28px;border-radius:8px;display:grid;place-items:center;
  background:var(--panel-2);color:var(--text);font-size:.9rem
}
.support-copy{font-size:.82rem;color:var(--muted-2);margin:0;text-align:center}
.security-note{
  display:flex;gap:12px;align-items:flex-start;
  border-top:1px solid var(--line);padding-top:18px;color:var(--muted-2)
}
.security-note p{margin:0;font-size:.76rem;line-height:1.55}
.security-note strong{color:var(--text)}
.shield{color:var(--accent-2);font-size:.72rem;margin-top:3px}
.inline-alert{
  display:flex;flex-direction:column;gap:5px;
  border:1px solid rgba(253,164,175,.25);
  background:rgba(127,29,29,.14);
  border-radius:12px;padding:13px 14px;color:#fecdd3;font-size:.86rem;line-height:1.45
}
.error-layout{
  width:min(720px,100%);
  margin:0 auto;
  padding:56px 0;
  text-align:center
}
.error-mark{
  width:76px;height:76px;margin:0 auto 28px;border-radius:22px;
  display:grid;place-items:center;
  border:1px solid rgba(253,164,175,.25);
  background:linear-gradient(180deg,rgba(127,29,29,.22),rgba(69,10,10,.12));
  box-shadow:0 20px 50px rgba(0,0,0,.22)
}
.error-mark span{font-size:2rem;font-weight:900;color:var(--danger)}
.error-layout h1{font-size:clamp(2.6rem,7vw,4.8rem);margin-inline:auto}
.error-layout .lead{margin:22px auto 0;max-width:640px}
.error-actions{max-width:360px;margin:32px auto 0}
.error-meta{margin:28px 0 0;color:var(--muted-2);font:600 .72rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.site-footer{
  width:min(1120px,100%);
  margin:0 auto;
  padding-top:24px;
  border-top:1px solid rgba(255,255,255,.06);
  display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;
  color:var(--muted-2);font-size:.72rem;font-weight:650
}
@media(max-width:820px){
  body{padding-left:18px;padding-right:18px}
  .page-shell{min-height:auto}
  .auth-layout{grid-template-columns:1fr;gap:34px;padding:24px 0 38px}
  .brand-lockup{margin-bottom:30px}
  h1{font-size:clamp(3rem,15vw,4.8rem)}
  .intro .lead{font-size:1rem;margin-top:18px}
  .trust-row{margin-top:22px}
  .auth-card{min-height:0;border-radius:20px;padding:24px}
  .site-footer{margin-top:26px}
}
@media(max-width:480px){
  body{padding-top:max(18px,env(safe-area-inset-top))}
  .auth-layout{padding-top:18px}
  h1{font-size:clamp(2.85rem,16vw,4.1rem)}
  .brand-kicker{font-size:.68rem}
  .brand-product{font-size:.8rem}
  .auth-card{padding:22px 18px}
  .site-footer{padding-bottom:8px}
}
@media(prefers-reduced-motion:reduce){
  *,*:before,*:after{scroll-behavior:auto!important;transition:none!important}
}
`;
