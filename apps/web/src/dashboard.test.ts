import { describe, expect, it } from "vitest";
import dashboardHtml from "../public/index.html?raw";
import dashboardCss from "../public/assets/dashboard.css?raw";
import dashboardJs from "../public/assets/dashboard.js?raw";
import { isDashboardAsset, serveDashboardAsset } from "./dashboard-assets";
import {
  buildVerifiedQuotaSlots,
  isOperationallyFailedDashboardRun,
  isOrphanedDashboardRun,
} from "./dashboard-data";

describe("dashboard run state", () => {
  const now = Date.parse("2026-10-01T15:45:00Z");

  it("treats old running rows without workflow linkage or applications as orphaned", () => {
    expect(
      isOrphanedDashboardRun(
        {
          status: "running",
          workflow_instance_id: null,
          application_count: 0,
          updated_at: "2026-10-01 15:34:43",
        },
        now,
      ),
    ).toBe(true);
  });

  it("counts only the latest unresolved application failure as operational", () => {
    expect(
      isOperationallyFailedDashboardRun(
        {
          status: "failed",
          application_month: "2026-10",
          verified_count: 9,
          target_count: 10,
        },
        "2026-10",
      ),
    ).toBe(true);
    expect(
      isOperationallyFailedDashboardRun(
        {
          status: "failed",
          application_month: "2026-10",
          verified_count: 10,
          target_count: 10,
        },
        "2026-10",
      ),
    ).toBe(false);
    expect(
      isOperationallyFailedDashboardRun(
        {
          status: "failed",
          application_month: "2026-09",
          verified_count: 0,
          target_count: 10,
        },
        "2026-10",
      ),
    ).toBe(false);
  });

  it("keeps linked, recent or application-bearing runs active", () => {
    expect(
      isOrphanedDashboardRun(
        {
          status: "running",
          workflow_instance_id: "manual-instance",
          application_count: 0,
          updated_at: "2026-10-01 15:30:00",
        },
        now,
      ),
    ).toBe(false);
    expect(
      isOrphanedDashboardRun(
        {
          status: "running",
          workflow_instance_id: null,
          application_count: 0,
          updated_at: "2026-10-01 15:44:00",
        },
        now,
      ),
    ).toBe(false);
    expect(
      isOrphanedDashboardRun(
        {
          status: "running",
          workflow_instance_id: null,
          application_count: 1,
          updated_at: "2026-10-01 15:30:00",
        },
        now,
      ),
    ).toBe(false);
  });
});

describe("dashboard application quota", () => {
  it("fills visible monthly slots only with verified applications", () => {
    expect(
      buildVerifiedQuotaSlots(
        [
          {
            application_id: "application:studentconsulting:87567",
            updated_at: "2026-10-02T13:03:40.204Z",
          },
        ],
        3,
      ),
    ).toEqual([
      {
        slot_no: 1,
        application_id: "application:studentconsulting:87567",
        state: "verified",
        updated_at: "2026-10-02T13:03:40.204Z",
      },
      {
        slot_no: 2,
        application_id: null,
        state: "free",
        updated_at: null,
      },
      {
        slot_no: 3,
        application_id: null,
        state: "free",
        updated_at: null,
      },
    ]);
  });
});

// Compare code independent of formatting: drop whitespace and unify quotes.
const compact = (text: string) => text.replace(/\s+/g, "").replace(/'/g, '"');

describe("dashboard assets", () => {
  const html = dashboardHtml;
  const css = dashboardCss;
  const js = dashboardJs;

  it("renders operational navigation without embedding credential names", () => {
    for (const tab of ["overview", "applications", "runs", "report", "system"]) {
      expect(html).toContain(`data-tab="${tab}"`);
    }
    expect(html).toContain("/assets/dashboard.css");
    expect(html).toContain("/assets/dashboard.js");
    expect(html).toContain('<html lang="sv" data-theme="legacy">');
    expect(compact(html)).toMatch(
      /<optionvalue="legacy">Legacy<\/option>.*<optionvalue="forest">__SITE_FAMILY__<\/option>/s,
    );
    expect(html).not.toContain("DASHBOARD_PASSWORD");
    expect(html).not.toContain("STUDENTCONSULTING_PASSWORD");
    expect(html.toLowerCase()).not.toContain("turnstile");
    expect(html).not.toContain("challenges.cloudflare.com");
  });

  it("exposes logout through the Access logout route", () => {
    expect(html).toContain('action="/auth/logout"');
    expect(html).toContain("Logga ut");
  });

  it("styles every view and theme", () => {
    for (const selector of [
      ".slots",
      ':root[data-theme="forest"]',
      ':root[data-theme="blackout"]',
      ".app-cards",
      ".run-cards",
      ".attempt-cards",
      ".activity-calendar",
      ".calendar-day.download-ready",
    ]) {
      expect(css).toContain(selector);
    }
    expect(compact(css)).toContain("--accent:#7dd3fc");
    expect(compact(css)).toContain(
      ".applications-table,.runs-table,.attempts-table{display:none;}",
    );
  });

  it("ships a parseable script covering the dashboard flows", () => {
    expect(() => new Function(js)).not.toThrow();
    for (const text of [
      "/api/dashboard",
      "/api/configuration",
      "Spara konfiguration",
      "/export.txt",
      "Ladda ner .txt",
      "Skicka med e-post",
      "/email",
      "cfgNotifyMode",
      "Ett mail per mottagare",
      "__THEME_KEY_PREFIX___theme",
      "__THEME_COOKIE_DOMAIN__",
      "Stoppa körning",
      "Radera körning",
      "Cloudflare Access-skyddad, same-origin skyddad pipeline",
      "Senaste ansökningskörningen misslyckades",
      "Markera ej inskickad",
      "/api/applications/",
      "not-submitted",
    ]) {
      expect(js).toContain(text);
    }
    expect(js).not.toContain("live.browser.run");
    expect(js).not.toContain("aktivitetsrapportera");
    expect(js).not.toContain("manual-submitted");
    expect(js.toLowerCase()).not.toContain("turnstile");
    expect(compact(js)).toContain('method:action==="stop"?"POST":"DELETE"');
  });

  it("auto-refreshes only during an active run with the tab visible", () => {
    expect(js).not.toContain("setInterval");
    expect(compact(js)).toContain(
      'document.visibilityState==="visible"&&dashboard&&dashboard.attention&&dashboard.attention.activeRun',
    );
  });
});

describe("dashboard asset serving", () => {
  const fakeAssets = {
    fetch: async (request: Request) =>
      new Response(new URL(request.url).pathname, { headers: { "content-type": "text/html" } }),
  } as unknown as Fetcher;

  it("matches only the dashboard paths for GET", () => {
    const at = (path: string, method = "GET") => {
      const request = new Request(`https://workoholic.example.com${path}`, { method });
      return isDashboardAsset(request, new URL(request.url));
    };
    expect(at("/")).toBe(true);
    expect(at("/assets/dashboard.js")).toBe(true);
    expect(at("/assets/dashboard.css")).toBe(true);
    expect(at("/", "POST")).toBe(false);
    expect(at("/api/dashboard")).toBe(false);
  });

  it("adds the security headers to the page and its assets", async () => {
    const page = await serveDashboardAsset(new Request("https://workoholic.example.com/"), fakeAssets);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const script = await serveDashboardAsset(
      new Request("https://workoholic.example.com/assets/dashboard.js"),
      fakeAssets,
    );
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await script.text()).toBe("/assets/dashboard.js");
  });
});
