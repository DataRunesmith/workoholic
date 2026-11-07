var dashboard = null,
  pollTimer = null,
  configDirty = false,
  overviewSignature = "",
  reportCalendarMonth = "",
  reportCalendarSelectedDay = "";
var themes = new Set(["legacy", "forest", "blackout"]),
  defaultTheme = "legacy",
  themeStorageKey = "__THEME_KEY_PREFIX__.theme",
  themeCookieName = "__THEME_KEY_PREFIX___theme";
function savedTheme() {
  var c = document.cookie.split("; ").find(function (x) {
    return x.indexOf(themeCookieName + "=") === 0;
  });
  var v = c ? c.split("=")[1] : "";
  if (themes.has(v)) return v;
  try {
    v = localStorage.getItem(themeStorageKey) || "";
  } catch (_) {}
  return themes.has(v) ? v : "";
}
function persistTheme(theme) {
  try {
    localStorage.setItem(themeStorageKey, theme);
  } catch (_) {}
  // A shared parent domain (set at deploy) lets sibling sites share the theme.
  var sharedDomain = "__THEME_COOKIE_DOMAIN__";
  var shared =
    sharedDomain &&
    sharedDomain.indexOf("__") !== 0 &&
    (location.hostname === sharedDomain || location.hostname.endsWith("." + sharedDomain));
  var domain = shared ? "; Domain=." + sharedDomain : "";
  var secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    themeCookieName + "=" + theme + "; Max-Age=31536000; Path=/; SameSite=Lax" + domain + secure;
}
function applyTheme(value, save) {
  var theme = themes.has(value) ? value : defaultTheme;
  document.documentElement.dataset.theme = theme;
  var select = document.getElementById("theme-select");
  if (select) select.value = theme;
  var meta = document.querySelector("meta[name=theme-color]");
  if (meta)
    meta.content = theme === "legacy" ? "#04070e" : theme === "forest" ? "#080b09" : "#000000";
  if (save) persistTheme(theme);
  return theme;
}
function initTheme() {
  var saved = savedTheme();
  applyTheme(saved || document.documentElement.dataset.theme || defaultTheme, Boolean(saved));
  var select = document.getElementById("theme-select");
  if (select)
    select.onchange = function () {
      applyTheme(select.value, true);
    };
}
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function badge(s) {
  var cls = ["verified", "completed", "submitted", "captured", "saved", "sent", "free"].includes(s)
    ? "ok"
    : ["failed", "errored"].includes(s)
      ? "bad"
      : "warn";
  return '<span class="status ' + cls + '">' + esc(s) + "</span>";
}
function when(v) {
  if (!v) return "";
  var d = new Date(v);
  return Number.isNaN(d.valueOf())
    ? esc(v)
    : esc(new Intl.DateTimeFormat("sv-SE", { dateStyle: "medium", timeStyle: "short" }).format(d));
}
async function api(path, options) {
  var r = await fetch(path, options);
  if (!r.ok) {
    var text = await r.text(),
      message = text;
    try {
      message = JSON.parse(text).error || text;
    } catch (_) {}
    throw new Error(message);
  }
  return r.json();
}
function tab(name) {
  if (!["overview", "applications", "runs", "report", "system"].includes(name)) name = "overview";
  document.querySelectorAll("[data-panel]").forEach(function (p) {
    p.hidden = p.dataset.panel !== name;
  });
  document.querySelectorAll("[data-tab]").forEach(function (a) {
    a.setAttribute("aria-current", a.dataset.tab === name ? "page" : "false");
  });
}
function sourceLabel(s) {
  return (
    { deployment: "Deployment", dashboard: "Dashboard", mixed: "Blandat", missing: "Saknas" }[s] ||
    s ||
    "Saknas"
  );
}
function checkRow(label, ok, source) {
  return (
    '<div class="notice"><span>' +
    esc(label) +
    '<br><span class="source">' +
    esc(sourceLabel(source)) +
    '</span></span><strong class="' +
    (ok ? "ok" : "bad") +
    '">' +
    (ok ? "OK" : "Saknas") +
    "</strong></div>"
  );
}
function exportActions(x) {
  var month = encodeURIComponent(x.report_month);
  return (
    '<a class="button" href="/api/reports/' +
    month +
    '/export.txt" download="' +
    esc(x.file_name) +
    '">Ladda ner .txt</a><button type="button" class="secondary exportEmail" data-month="' +
    esc(x.report_month) +
    '"' +
    (dashboard && dashboard.configuration.exportEmail ? "" : " disabled") +
    '>Skicka med e-post</button><span class="muted exportEmailResult" data-month="' +
    esc(x.report_month) +
    '"></span>'
  );
}
function exportPanel(d) {
  var current = (d.activityExports || []).find(function (x) {
    return x.report_month === d.applicationMonth;
  });
  var rows = (d.activityExports || [])
    .map(function (x) {
      return (
        '<div class="notice"><span><strong>' +
        esc(x.file_name) +
        '</strong><br><span class="source">' +
        esc(calendarMonthLabel(x.report_month)) +
        " · " +
        esc(x.item_count) +
        ' jobb</span></span><span class="toolbar">' +
        exportActions(x) +
        "</span></div>"
      );
    })
    .join("");
  var head = current
    ? '<p class="ok">Månadens fil är klar.</p>'
    : '<p class="muted">Filen för ' +
      esc(d.applicationMonth) +
      " skapas när " +
      esc(d.target) +
      " ansökningar är verifierade (" +
      esc(d.verified) +
      "/" +
      esc(d.target) +
      ").</p>";
  var mail = d.configuration.exportEmail
    ? '<p class="config-note">Nya filer skickas automatiskt till ' +
      esc(d.configuration.notifyEmailTo) +
      (d.configuration.notifyEmailMode === "separate"
        ? " (ett mail per mottagare)."
        : " (ett gemensamt mail).") +
      "</p>"
    : '<p class="config-note">Lägg till mottagare under <a href="#system">System</a> för att få filen med e-post.</p>';
  return (
    '<div class="card"><p class="eyebrow">Jobbansökningar</p><h2>Månadsfiler (.txt)</h2>' +
    head +
    (rows || '<div class="empty">Inga månadsfiler ännu.</div>') +
    mail +
    "</div>"
  );
}
function setupExportEmail() {
  document.querySelectorAll(".exportEmail").forEach(function (b) {
    b.onclick = async function () {
      var month = b.dataset.month,
        out = document.querySelector('.exportEmailResult[data-month="' + month + '"]');
      b.disabled = true;
      if (out) out.textContent = "Skickar…";
      try {
        var r = await api("/api/reports/" + encodeURIComponent(month) + "/email", {
          method: "POST",
        });
        if (out)
          out.textContent =
            "Skickat till " + r.sent + (r.failed ? ", " + r.failed + " misslyckades." : ".");
      } catch (e) {
        if (out) out.textContent = "Kunde inte skicka: " + e.message;
      } finally {
        b.disabled = false;
      }
    };
  });
}
function renderOverview(d) {
  var signature = JSON.stringify({
    applicationMonth: d.applicationMonth,
    verified: d.verified,
    target: d.target,
    quotaUsed: d.quotaUsed,
    quotaSlots: d.quotaSlots,
    activityExports: d.activityExports,
    attention: d.attention,
    automaticMode: d.automaticMode,
    applicationWindowOpen: d.applicationWindowOpen,
    manualConfiguration: {
      studentConsultingCredentials: d.configuration.studentConsultingCredentials,
      studentConsultingAutoSubmit: d.configuration.studentConsultingAutoSubmit,
      exportEmail: d.configuration.exportEmail,
      notifyEmailTo: d.configuration.notifyEmailTo,
      notifyEmailMode: d.configuration.notifyEmailMode,
    },
  });
  if (signature === overviewSignature) {
    setupManual(d);
    return;
  }
  overviewSignature = signature;
  var attention =
    d.attention.uncertainSlots +
    d.attention.failedRuns +
    d.attention.failedNotifications +
    (d.attention.orphanedRuns || 0) +
    (d.attention.activeRun ? 1 : 0);
  var slots = d.quotaSlots
    .map(function (s) {
      return (
        '<div class="slot ' +
        esc(s.state) +
        '"><strong>' +
        esc(s.slot_no) +
        "</strong>" +
        badge(s.state) +
        '<div class="mono">' +
        esc(s.application_id || "ledig") +
        "</div></div>"
      );
    })
    .join("");
  var unresolved = d.attention.uncertainSlots
    ? '<div class="card attention-note"><p class="eyebrow">Åtgärd krävs</p><h2>' +
      esc(d.attention.uncertainSlots) +
      " osäkra ansökningar</h2><p>De räknas inte bland de " +
      esc(d.target) +
      ' godkända ansökningarna. Av säkerhetsskäl skickas inga nya ansökningar förrän de har kontrollerats eller markerats som inte inskickade.</p><a class="button" href="#applications">Hantera ansökningar</a></div>'
    : "";
  var html =
    '<div class="grid"><div class="card"><p class="eyebrow">' +
    esc(d.applicationMonth) +
    '</p><h2>Månadsmål</h2><div class="big">' +
    esc(d.verified) +
    "/" +
    esc(d.target) +
    '</div><progress max="' +
    d.target +
    '" value="' +
    d.verified +
    '"></progress><p class="muted">' +
    esc(d.quotaUsed) +
    "/" +
    esc(d.target) +
    ' verifierade ansökningar</p></div><div class="card"><p class="eyebrow">Operativt</p><h2>Behöver uppmärksamhet</h2><div class="big ' +
    (attention ? "warn" : "ok") +
    '">' +
    esc(attention) +
    '</div><p class="muted">Aktiva blockers och osäkra tillstånd</p></div></div>' +
    exportPanel(d) +
    unresolved +
    '<div class="grid"><div class="card"><h2>Godkända ansökningar</h2><p class="config-note">Endast verifierade StudentConsulting-ansökningar fyller de här ' +
    esc(d.target) +
    ' platserna.</p><div class="slots">' +
    slots +
    '</div></div><div class="card"><h2>Aktiva signaler</h2>' +
    signalRows(d) +
    "</div></div>" +
    '<div class="grid"><div class="card"><h2>Manuell körning</h2><p>Cloudflare Access-skyddad, same-origin skyddad pipeline. Tillåten den 1:a–14:e.</p><div class="toolbar"><button id="manual" disabled>Kör nu</button><span id="manualResult" class="muted"></span></div></div><div class="card"><h2>Automatiskt säkerhetsläge</h2><div class="status ok">Aktivt</div><p>' +
    esc(d.automaticMode.schedule) +
    "</p></div></div>";
  document.querySelector("[data-panel=overview]").innerHTML = html;
  setupExportEmail();
  setupManual(d);
}
function signalRows(d) {
  var rows = [];
  if (d.attention.activeRun) rows.push(["Aktiv körning", badge(d.attention.activeRun.status)]);
  if (d.attention.orphanedRuns)
    rows.push([
      "Övergivna körningar",
      '<strong class="warn">' + d.attention.orphanedRuns + "</strong>",
    ]);
  if (d.attention.uncertainSlots)
    rows.push([
      "Osäkra ansökningar",
      '<strong class="warn">' + d.attention.uncertainSlots + "</strong>",
    ]);
  if (d.attention.failedRuns)
    rows.push([
      "Senaste ansökningskörningen misslyckades",
      '<strong class="bad">' + d.attention.failedRuns + "</strong>",
    ]);
  if (d.attention.failedNotifications)
    rows.push([
      "Misslyckade e-postutskick 30 dagar",
      '<strong class="bad">' + d.attention.failedNotifications + "</strong>",
    ]);
  return rows.length
    ? rows
        .map(function (r) {
          return '<div class="notice"><span>' + r[0] + "</span>" + r[1] + "</div>";
        })
        .join("")
    : '<div class="empty">Inga kända blockers.</div>';
}
function renderApplications(d) {
  var html =
    '<div class="card"><h2>Ansökningar</h2><p class="config-note"><code>needs_user_action</code> betyder att ett skickförsök kan ha gjorts men ännu inte har kunnat verifieras säkert. Använd Kontrollera igen, eller markera som ej inskickad om du har kontrollerat StudentConsulting själv.</p><div class="filters"><input id="appSearch" type="search" placeholder="Sök jobb, arbetsgivare, Jobb-ID"><select id="appStatus"><option value="">Alla statusar</option><option>verified</option><option>submitted</option><option>applying</option><option>queued</option><option>needs_user_action</option><option>failed</option></select></div><div class="table-wrap applications-table"><table><thead><tr><th>Status</th><th>Jobb</th><th>Ort</th><th>Datum</th><th>Run</th><th>Evidens</th><th>Fel</th><th>Åtgärd</th></tr></thead><tbody id="appRows"></tbody></table></div><div id="appCards" class="app-cards"></div></div>';
  document.querySelector("[data-panel=applications]").innerHTML = html;
  function rows() {
    var q = document.getElementById("appSearch").value.toLowerCase(),
      s = document.getElementById("appStatus").value;
    var items = d.applications.filter(function (a) {
      return (
        (!s || a.status === s) &&
        (!q || [a.title, a.employer, a.external_id, a.location].join(" ").toLowerCase().includes(q))
      );
    });
    document.getElementById("appRows").innerHTML = items.length
      ? items.map(appRow).join("")
      : '<tr><td colspan="8" class="empty">Inga träffar.</td></tr>';
    document.getElementById("appCards").innerHTML = items.length
      ? items.map(appCard).join("")
      : '<div class="empty">Inga träffar.</div>';
    setupApplicationActions();
  }
  document.getElementById("appSearch").oninput = rows;
  document.getElementById("appStatus").onchange = rows;
  rows();
}
function applicationIssue(a) {
  if (a.status === "needs_user_action" && a.error_code === "APPLICATION_UNKNOWN")
    return (
      "Skickförsöket gjordes, men StudentConsulting kunde inte bekräfta Jobb-ID " +
      a.external_id +
      " i Ansökningar. Den räknas därför inte som godkänd."
    );
  return [a.error_code, a.error_message].filter(Boolean).join(" ");
}
function applicationActions(a) {
  if (a.status !== "needs_user_action") return "";
  return (
    '<div class="app-actions"><button class="secondary appRecheck" type="button" data-id="' +
    esc(a.id) +
    '">Kontrollera igen</button><button class="danger appNotSubmitted" type="button" data-id="' +
    esc(a.id) +
    '" data-job-id="' +
    esc(a.external_id) +
    '">Markera ej inskickad</button><span class="app-action-result muted" data-result-id="' +
    esc(a.id) +
    '"></span></div>'
  );
}
function appRow(a) {
  return (
    "<tr><td>" +
    badge(a.status) +
    '</td><td><a href="' +
    esc(a.source_url) +
    '" target="_blank" rel="noopener noreferrer">' +
    esc(a.title) +
    '</a><br><span class="muted">' +
    esc(a.employer || "") +
    "</span><br><code>" +
    esc(a.external_id) +
    "</code></td><td>" +
    esc(a.location || a.country_code || "") +
    "</td><td>" +
    when(a.verified_at || a.applied_at || a.created_at) +
    "</td><td><code>" +
    esc(a.automation_run_id || "") +
    "</code></td><td>" +
    esc(a.evidence_count || 0) +
    '</td><td class="error">' +
    esc(applicationIssue(a)) +
    "</td><td>" +
    applicationActions(a) +
    "</td></tr>"
  );
}
function appCard(a) {
  var issue = applicationIssue(a);
  return (
    '<article class="application-card ' +
    (a.status === "needs_user_action" ? "needs-user-action" : "") +
    '">' +
    badge(a.status) +
    '<h3><a href="' +
    esc(a.source_url) +
    '" target="_blank" rel="noopener noreferrer">' +
    esc(a.title) +
    '</a></h3><div class="muted">' +
    esc(a.employer || "") +
    '</div><div class="app-meta"><span><small>Jobb-ID</small><code>' +
    esc(a.external_id) +
    "</code></span><span><small>Ort</small>" +
    esc(a.location || a.country_code || "") +
    "</span><span><small>Datum</small>" +
    when(a.verified_at || a.applied_at || a.created_at) +
    "</span><span><small>Evidens</small>" +
    esc(a.evidence_count || 0) +
    "</span></div>" +
    (issue ? '<p class="error">' + esc(issue) + "</p>" : "") +
    applicationActions(a) +
    "</article>"
  );
}
function setupApplicationActions() {
  document.querySelectorAll(".appRecheck").forEach(function (b) {
    b.onclick = function () {
      resolveApplicationAttention(b.dataset.id, "recheck", b.dataset.jobId || "");
    };
  });
  document.querySelectorAll(".appNotSubmitted").forEach(function (b) {
    b.onclick = function () {
      resolveApplicationAttention(b.dataset.id, "not-submitted", b.dataset.jobId || "");
    };
  });
}
function setApplicationActionState(id, message, busy) {
  document.querySelectorAll(".appRecheck,.appNotSubmitted").forEach(function (b) {
    if (b.dataset.id === id) b.disabled = busy;
  });
  document.querySelectorAll(".app-action-result").forEach(function (out) {
    if (out.dataset.resultId === id) out.textContent = message || "";
  });
}
async function resolveApplicationAttention(id, action, jobId) {
  if (
    action === "not-submitted" &&
    !confirm(
      "Bekräfta att Jobb-ID " +
        jobId +
        " inte skickades. Den osäkra spärren släpps och ansökan räknas inte.",
    )
  )
    return;
  setApplicationActionState(
    id,
    action === "recheck" ? "Kontrollerar StudentConsulting…" : "Uppdaterar…",
    true,
  );
  try {
    var r = await api("/api/applications/" + encodeURIComponent(id) + "/" + action, {
      method: "POST",
    });
    setApplicationActionState(id, r.message || "Klart.", false);
    if (r.changed) setTimeout(load, 450);
  } catch (e) {
    setApplicationActionState(id, "Kunde inte uppdatera: " + e.message, false);
  }
}
function runState(r) {
  return r.orphaned ? "orphaned" : r.status;
}
function runError(r) {
  return (
    r.last_error ||
    r.probe_error ||
    (r.orphaned
      ? "WORKFLOW_ORPHANED: workflow-koppling saknas och ingen ansökningsaktivitet observerades."
      : "")
  );
}
function runMessageClass() {
  return "error";
}
function runRow(r) {
  return (
    "<tr><td>" +
    when(r.started_at) +
    "</td><td>" +
    esc(r.mode) +
    "</td><td>" +
    badge(runState(r)) +
    "</td><td>" +
    esc(r.application_month) +
    "</td><td>" +
    esc(r.verified_count) +
    "/" +
    esc(r.target_count) +
    "</td><td>" +
    (r.probe_status ? badge(r.probe_status) : "") +
    '</td><td class="' +
    runMessageClass(r) +
    '">' +
    esc(runError(r)) +
    '</td><td><button class="secondary runDetail" data-id="' +
    esc(r.id) +
    '">Detaljer</button></td></tr>'
  );
}
function runCard(r) {
  var error = runError(r);
  return (
    '<article class="run-card"><div class="run-head"><span>' +
    badge(runState(r)) +
    '</span><span class="muted">' +
    when(r.started_at) +
    '</span></div><div class="run-meta"><span><small>Läge</small>' +
    esc(r.mode) +
    "</span><span><small>Månad</small>" +
    esc(r.application_month) +
    "</span><span><small>Verifierade</small>" +
    esc(r.verified_count) +
    "/" +
    esc(r.target_count) +
    "</span><span><small>Probe</small>" +
    (r.probe_status ? badge(r.probe_status) : '<span class="muted">—</span>') +
    "</span></div>" +
    (error ? '<p class="' + runMessageClass(r) + '">' + esc(error) + "</p>" : "") +
    '<button class="secondary runDetail" data-id="' +
    esc(r.id) +
    '">Detaljer</button></article>'
  );
}
function renderRuns(d) {
  var rows = d.runs.map(runRow).join(""),
    cards = d.runs.map(runCard).join("");
  document.querySelector("[data-panel=runs]").innerHTML =
    '<div class="card"><h2>Senaste körningar</h2><div class="table-wrap runs-table"><table><thead><tr><th>Start</th><th>Läge</th><th>Status</th><th>Månad</th><th>Verifierade</th><th>Probe</th><th>Notering</th><th></th></tr></thead><tbody>' +
    rows +
    '</tbody></table></div><div class="run-cards">' +
    (cards || '<div class="empty">Inga körningar.</div>') +
    "</div></div>";
  document.querySelectorAll(".runDetail").forEach(function (b) {
    b.onclick = function () {
      openRun(b.dataset.id);
    };
  });
}
function calendarDateKey(v) {
  if (!v) return "";
  var d = new Date(v);
  if (Number.isNaN(d.valueOf())) return String(v).slice(0, 10);
  var parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Stockholm",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d),
    out = {};
  parts.forEach(function (p) {
    out[p.type] = p.value;
  });
  return out.year + "-" + out.month + "-" + out.day;
}
function calendarMonthLabel(month) {
  var p = String(month).split("-"),
    d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, 1));
  return new Intl.DateTimeFormat("sv-SE", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}
function activityCalendarMonths(d) {
  var values = new Set([d.applicationMonth]);
  (d.activityCalendar || []).forEach(function (x) {
    if (x.report_month) values.add(x.report_month);
  });
  (d.activityExports || []).forEach(function (x) {
    if (x.report_month) values.add(x.report_month);
  });
  return Array.from(values).sort();
}
function renderActivityCalendar(d) {
  var months = activityCalendarMonths(d);
  if (!reportCalendarMonth || months.indexOf(reportCalendarMonth) < 0)
    reportCalendarMonth = d.applicationMonth;
  var month = reportCalendarMonth,
    idx = months.indexOf(month),
    parts = month.split("-"),
    year = Number(parts[0]),
    monthNo = Number(parts[1]),
    daysInMonth = new Date(Date.UTC(year, monthNo, 0)).getUTCDate(),
    firstWeekday = (new Date(Date.UTC(year, monthNo - 1, 1)).getUTCDay() + 6) % 7,
    counts = {};
  (d.activityCalendar || [])
    .filter(function (x) {
      return x.report_month === month;
    })
    .forEach(function (x) {
      var key = calendarDateKey(x.applied_at);
      counts[key] = (counts[key] || 0) + 1;
    });
  var exportRow =
      (d.activityExports || []).find(function (x) {
        return x.report_month === month;
      }) || null,
    readyDay = exportRow ? calendarDateKey(exportRow.ready_at) : "",
    cells = "";
  for (var blank = 0; blank < firstWeekday; blank += 1)
    cells += '<div class="calendar-blank" aria-hidden="true"></div>';
  for (var day = 1; day <= daysInMonth; day += 1) {
    var key = month + "-" + String(day).padStart(2, "0"),
      count = counts[key] || 0,
      ready = key === readyDay,
      selected = key === reportCalendarSelectedDay,
      classes =
        "calendar-day" +
        (count ? " has-applications" : "") +
        (ready ? " download-ready" : "") +
        (selected ? " selected" : "");
    if (count || ready) {
      cells +=
        '<button type="button" class="' +
        classes +
        '" data-calendar-day="' +
        esc(key) +
        '" aria-label="' +
        esc(key) +
        (count ? " · " + count + " jobbsökningar" : "") +
        (ready ? " · månadsfil klar" : "") +
        '"><span class="calendar-number">' +
        day +
        "</span>" +
        (count
          ? '<span class="calendar-count">' + count + " sökt" + (count === 1 ? "" : "a") + "</span>"
          : "") +
        (ready ? '<span class="calendar-download-marker">TXT klar</span>' : "") +
        "</button>";
    } else {
      cells +=
        '<div class="' + classes + '"><span class="calendar-number">' + day + "</span></div>";
    }
  }
  var selection = "";
  if (reportCalendarSelectedDay) {
    var selectedCount = counts[reportCalendarSelectedDay] || 0;
    if (reportCalendarSelectedDay === readyDay && exportRow) {
      selection =
        '<div class="calendar-selection"><p><strong>' +
        esc(reportCalendarSelectedDay) +
        "</strong> · " +
        esc(exportRow.file_name) +
        " är klar med " +
        esc(exportRow.item_count) +
        ' jobb.</p><div class="toolbar">' +
        exportActions(exportRow) +
        "</div></div>";
    } else if (selectedCount) {
      selection =
        '<div class="calendar-selection"><p><strong>' +
        esc(reportCalendarSelectedDay) +
        "</strong> · " +
        esc(selectedCount) +
        ' verifierade jobbsökningar den dagen.</p><p class="muted">Nedladdningsknappen visas på dagen då månadsfilen blev klar.</p></div>';
    }
  }
  return (
    '<div class="card activity-calendar"><div class="calendar-head"><button type="button" class="secondary calendar-nav" data-calendar-month="' +
    esc(months[idx - 1] || "") +
    '" ' +
    (idx <= 0 ? "disabled" : "") +
    ' aria-label="Föregående månad">←</button><h3>' +
    esc(calendarMonthLabel(month)) +
    '</h3><button type="button" class="secondary calendar-nav" data-calendar-month="' +
    esc(months[idx + 1] || "") +
    '" ' +
    (idx >= months.length - 1 ? "disabled" : "") +
    ' aria-label="Nästa månad">→</button></div><div class="calendar-legend"><span><i class="calendar-dot application"></i>Jobbsökning</span><span><i class="calendar-dot download"></i>.txt klar för nedladdning</span></div><div class="calendar-weekdays" aria-hidden="true"><span>Mån</span><span>Tis</span><span>Ons</span><span>Tor</span><span>Fre</span><span>Lör</span><span>Sön</span></div><div class="calendar-grid">' +
    cells +
    "</div>" +
    selection +
    "</div>"
  );
}
function setupActivityCalendar(d) {
  document.querySelectorAll("[data-calendar-month]").forEach(function (b) {
    b.onclick = function () {
      if (!b.dataset.calendarMonth) return;
      reportCalendarMonth = b.dataset.calendarMonth;
      reportCalendarSelectedDay = "";
      renderReport(d);
    };
  });
  document.querySelectorAll("[data-calendar-day]").forEach(function (b) {
    b.onclick = function () {
      reportCalendarSelectedDay = b.dataset.calendarDay || "";
      renderReport(d);
    };
  });
}
function renderReport(d) {
  document.querySelector("[data-panel=report]").innerHTML =
    exportPanel(d) +
    '<div class="card"><h2>Om filen</h2><p>En .txt skapas automatiskt när ' +
    esc(d.target) +
    " verifierade ansökningar finns för månaden. Den heter efter dagen den tionde ansökan verifierades och innehåller jobb-ID, jobbtyp, stad och omfattning för varje jobb.</p></div>" +
    renderActivityCalendar(d);
  setupActivityCalendar(d);
  setupExportEmail();
}

function renderSystem(d) {
  var c = d.configuration;
  var checks =
    checkRow(
      "StudentConsulting-konto",
      c.studentConsultingCredentials,
      c.studentConsultingCredentialsSource,
    ) +
    checkRow("Autosubmit", c.studentConsultingAutoSubmit, c.studentConsultingAutoSubmitSource) +
    '<div class="notice"><span>Jobbkälla<br><span class="source">StudentConsulting-profil</span></span><strong class="ok">Matcha jobb</strong></div>' +
    '<div class="notice"><span>Extra lämplighetsfilter<br><span class="source">' +
    esc(c.suitabilityPolicy ? sourceLabel(c.suitabilityPolicySource) : "Valfritt") +
    '</span></span><strong class="ok">' +
    (c.suitabilityPolicy ? "Aktivt" : "Valfritt") +
    "</strong></div>" +
    checkRow("E-postutskick av månadsfilen", c.exportEmail, c.exportEmailSource);
  var storageWarning = !c.managedConfigurationStorageReady
    ? '<div class="card callout"><h2>Konfigurationslagret är inte initierat</h2><p>D1-migration <code>0006_runtime_configuration.sql</code> måste appliceras av en auktoriserad Cloudflare-identitet innan konfigurationen kan sparas. Dashboarden och automationen fortsätter fail-closed under tiden.</p></div>'
    : "";
  var recovery = c.managedConfigurationUnreadable
    ? '<div class="card callout"><h2>Konfigurationen behöver sparas om</h2><p>Den tidigare dashboard-konfigurationen kan inte dekrypteras, till exempel efter en OAuth-hemlighetsrotation. Fyll i nödvändiga värden nedan och spara för att ersätta den.</p></div>'
    : "";
  var n = d.notifications.length
    ? d.notifications
        .map(function (x) {
          return (
            "<tr><td>" +
            when(x.created_at) +
            "</td><td>" +
            esc(x.kind) +
            "</td><td>" +
            esc(x.channel) +
            "</td><td>" +
            badge(x.status) +
            "</td><td><code>" +
            esc(x.automation_run_id) +
            '</code></td><td class="error">' +
            esc(x.error_message || "") +
            "</td></tr>"
          );
        })
        .join("")
    : '<tr><td colspan="6" class="empty">Inga notifieringar sparade.</td></tr>';
  var credentialPlaceholder = c.studentConsultingCredentials
    ? "Konfigurerat – fyll båda fälten för att ersätta"
    : "Krävs för StudentConsulting";
  var form =
    '<form id="runtimeConfigForm"><div class="config-section"><h2>StudentConsulting</h2><div class="form-grid"><label class="field"><span>E-post</span><input id="cfgStudentEmail" type="email" autocomplete="username" placeholder="' +
    esc(credentialPlaceholder) +
    '"></label><label class="field"><span>Lösenord</span><input id="cfgStudentPassword" type="password" autocomplete="current-password" placeholder="' +
    esc(credentialPlaceholder) +
    '"></label></div><label class="check-row"><input id="cfgAutoSubmit" type="checkbox" ' +
    (c.studentConsultingAutoSubmit ? "checked" : "") +
    '><span>Tillåt autosubmit när alla lämplighets- och quota-kontroller är godkända</span></label></div><div class="config-section"><h2>Extra lämplighetsfilter (valfritt)</h2><p class="config-note">Jobb hämtas från din inloggade StudentConsulting-vy <strong>Matcha jobb</strong>. Fälten nedan begränsar urvalet ytterligare men behövs inte för autosubmit.</p><div class="form-grid"><label class="field"><span>Måste innehålla (valfritt)</span><textarea id="cfgInclude" placeholder="supporttekniker,it-support,helpdesk">' +
    esc(c.jobIncludeTerms) +
    '</textarea></label><label class="field"><span>Får inte innehålla</span><textarea id="cfgExclude" placeholder="chef,senior">' +
    esc(c.jobExcludeTerms) +
    '</textarea></label><label class="field"><span>Tillåtna orter</span><input id="cfgLocations" value="' +
    esc(c.jobAllowedLocations) +
    '" placeholder="Stockholm,Uppsala"></label><label class="field"><span>Tillåtna länder</span><input id="cfgCountries" value="' +
    esc(c.jobAllowedCountries) +
    '" placeholder="SE"></label></div></div><div class="config-section"><h2>E-postutskick av månadsfilen</h2><p class="config-note">När månadens .txt blir klar skickas den till mottagarna nedan. Du kan också skicka den igen från översikten.</p><div class="form-grid"><label class="field"><span>Mottagare (en eller flera, separerade med komma)</span><textarea id="cfgNotifyTo" placeholder="du@example.com, annan@example.com">' +
    esc(c.notifyEmailTo) +
    '</textarea></label><label class="field"><span>Avsändare</span><input id="cfgNotifyFrom" type="email" value="' +
    esc(c.notifyEmailFrom) +
    '" placeholder="jobb@example.com"></label></div><label class="check-row"><input type="radio" name="cfgNotifyMode" value="group" ' +
    (c.notifyEmailMode !== "separate" ? "checked" : "") +
    '><span>Ett gemensamt mail till alla mottagare</span></label><label class="check-row"><input type="radio" name="cfgNotifyMode" value="separate" ' +
    (c.notifyEmailMode === "separate" ? "checked" : "") +
    '><span>Ett mail per mottagare (de ser inte varandra)</span></label></div><p class="config-note">StudentConsulting-lösenordet lagras krypterat och returneras aldrig till webbläsaren efter sparning. Värden som redan är satta i deployment har företräde.</p><div class="config-actions"><button id="saveConfig" type="submit">Spara konfiguration</button><span id="configResult" class="muted"></span></div></form>';
  document.querySelector("[data-panel=system]").innerHTML =
    '<div class="grid"><div class="card"><h2>Runtime-konfiguration</h2>' +
    checks +
    '</div><div class="card"><h2>Automation</h2><p>' +
    esc(d.automaticMode.applicationWindow) +
    "</p><p>" +
    esc(d.automaticMode.schedule) +
    '</p><p class="muted">' +
    (c.updatedAt
      ? "Dashboardkonfiguration uppdaterad " + when(c.updatedAt)
      : "Ingen dashboardkonfiguration sparad ännu.") +
    "</p></div></div>" +
    storageWarning +
    recovery +
    '<div class="card">' +
    form +
    '</div><div class="card"><h2>Notifieringshistorik</h2><div class="table-wrap"><table><thead><tr><th>Tid</th><th>Typ</th><th>Kanal</th><th>Status</th><th>Körning</th><th>Fel</th></tr></thead><tbody>' +
    n +
    "</tbody></table></div></div>";
  setupConfigForm(c);
}
function setupConfigForm(c) {
  var f = document.getElementById("runtimeConfigForm");
  if (!f) return;
  if (!c.managedConfigurationStorageReady) {
    f.querySelectorAll("input,textarea,button").forEach(function (el) {
      el.disabled = true;
    });
    var blocked = document.getElementById("configResult");
    if (blocked)
      blocked.textContent = "D1-migration 0006 måste appliceras innan konfiguration kan sparas.";
    return;
  }
  f.oninput = function () {
    configDirty = true;
  };
  f.onchange = function () {
    configDirty = true;
  };
  f.onsubmit = async function (e) {
    e.preventDefault();
    var out = document.getElementById("configResult"),
      button = document.getElementById("saveConfig");
    var email = document.getElementById("cfgStudentEmail").value.trim(),
      password = document.getElementById("cfgStudentPassword").value;
    if (Boolean(email) !== Boolean(password)) {
      out.textContent = "Fyll både StudentConsulting e-post och lösenord, eller lämna båda tomma.";
      out.className = "bad";
      return;
    }
    var payload = {
      studentConsultingAutoSubmit: document.getElementById("cfgAutoSubmit").checked,
      jobIncludeTerms: document.getElementById("cfgInclude").value,
      jobExcludeTerms: document.getElementById("cfgExclude").value,
      jobAllowedLocations: document.getElementById("cfgLocations").value,
      jobAllowedCountries: document.getElementById("cfgCountries").value,
      notifyEmailTo: document.getElementById("cfgNotifyTo").value,
      notifyEmailFrom: document.getElementById("cfgNotifyFrom").value,
      notifyEmailMode:
        (f.querySelector("input[name=cfgNotifyMode]:checked") || {}).value || "group",
    };
    if (email && password) payload.studentConsulting = { email: email, password: password };
    button.disabled = true;
    out.className = "muted";
    out.textContent = "Sparar…";
    try {
      await api("/api/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      configDirty = false;
      out.className = "ok";
      out.textContent = "Sparat.";
      setTimeout(load, 250);
    } catch (error) {
      out.className = "bad";
      out.textContent = "Kunde inte spara: " + error.message;
    } finally {
      button.disabled = false;
    }
  };
}
async function openRun(id) {
  var dlg = document.getElementById("runDialog"),
    body = document.getElementById("runBody");
  body.innerHTML = '<div class="empty">Laddar…</div>';
  dlg.showModal();
  try {
    var d = await api("/api/runs/" + encodeURIComponent(id));
    document.getElementById("runTitle").textContent = id;
    var apps =
      d.applications
        .map(function (a) {
          return (
            '<div class="notice"><span>' +
            esc(a.title) +
            " <code>" +
            esc(a.external_id) +
            "</code></span>" +
            badge(a.status) +
            "</div>"
          );
        })
        .join("") || '<div class="empty">Inga ansökningar.</div>';
    var attempts = d.attempts
      .map(function (a) {
        return (
          "<tr><td>" +
          esc(a.attempt_no) +
          "</td><td><code>" +
          esc(a.application_id) +
          "</code></td><td>" +
          badge(a.status) +
          "</td><td>" +
          when(a.started_at) +
          '</td><td class="error">' +
          esc(a.error_code || "") +
          " " +
          esc(a.error_message || "") +
          "</td></tr>"
        );
      })
      .join("");
    var attemptCards = d.attempts
      .map(function (a) {
        var error = [a.error_code, a.error_message].filter(Boolean).join(" ");
        return (
          '<article class="attempt-card"><div class="run-head">' +
          badge(a.status) +
          '<span class="muted">' +
          when(a.started_at) +
          '</span></div><div class="run-meta"><span><small>Försök</small>' +
          esc(a.attempt_no) +
          "</span><span><small>Ansökan</small><code>" +
          esc(a.application_id) +
          "</code></span></div>" +
          (error ? '<p class="error">' + esc(error) + "</p>" : "") +
          "</article>"
        );
      })
      .join("");
    var evidence =
      d.evidence
        .map(function (e) {
          return (
            '<div class="notice"><span><strong>' +
            esc(e.kind) +
            "</strong><br><code>" +
            esc(e.object_key) +
            '</code><br><span class="muted">sha256: ' +
            esc(e.sha256 || "inte lagrad") +
            "</span></span><span>" +
            when(e.created_at) +
            "</span></div>"
          );
        })
        .join("") || '<div class="empty">Ingen evidensmetadata.</div>';
    var active = d.run.status === "running",
      canDelete = !active && d.applications.length === 0,
      controls =
        '<div class="toolbar">' +
        (active ? '<button id="stopRun" class="secondary">Stoppa körning</button>' : "") +
        (canDelete ? '<button id="deleteRun" class="secondary">Radera körning</button>' : "") +
        '<span id="runActionResult" class="muted"></span></div>';
    body.innerHTML =
      '<div class="card"><h2>Run</h2>' +
      badge(runState(d.run)) +
      '<p class="mono">' +
      esc(d.run.workflow_instance_id || "") +
      '</p><p class="' +
      runMessageClass(d.run) +
      '">' +
      esc(d.run.last_error || "") +
      "</p>" +
      controls +
      '</div><div class="card"><h2>Ansökningar</h2>' +
      apps +
      '</div><div class="card"><h2>Försök</h2><div class="table-wrap attempts-table"><table><tbody>' +
      attempts +
      '</tbody></table></div><div class="attempt-cards">' +
      (attemptCards || '<div class="empty">Inga försök.</div>') +
      '</div></div><div class="card"><h2>Evidensmetadata</h2>' +
      evidence +
      "</div>";
    var stop = document.getElementById("stopRun");
    if (stop)
      stop.onclick = function () {
        runAction(id, "stop");
      };
    var del = document.getElementById("deleteRun");
    if (del)
      del.onclick = function () {
        runAction(id, "delete");
      };
  } catch (e) {
    body.innerHTML = '<div class="card bad">' + esc(e.message) + "</div>";
  }
}
async function runAction(id, action) {
  var out = document.getElementById("runActionResult"),
    verb = action === "stop" ? "stoppa" : "radera";
  if (!confirm("Vill du " + verb + " den här körningen?")) return;
  if (out) out.textContent = action === "stop" ? "Stoppar…" : "Raderar…";
  try {
    await api("/api/runs/" + encodeURIComponent(id) + (action === "stop" ? "/stop" : ""), {
      method: action === "stop" ? "POST" : "DELETE",
    });
    document.getElementById("runDialog").close();
    await load();
  } catch (e) {
    if (out) out.textContent = e.message;
  }
}
function setupManual(d) {
  var b = document.getElementById("manual"),
    out = document.getElementById("manualResult");
  if (!b || !out) return;
  var c = d.configuration,
    activeRun = d.attention.activeRun,
    targetReached = d.verified >= d.target,
    applicationReady = c.studentConsultingCredentials && c.studentConsultingAutoSubmit;
  b.disabled = !(d.applicationWindowOpen && !activeRun && !targetReached && applicationReady);
  if (activeRun) {
    out.textContent = "En körning pågår.";
    return;
  }
  if (targetReached) {
    out.textContent = d.target + "/" + d.target + " ansökningar är klara. Månadsfilen finns ovan.";
    return;
  }
  if (!d.applicationWindowOpen) {
    out.textContent = "Körningsfönstret är stängt.";
    return;
  }
  if (!applicationReady) {
    out.textContent = "Slutför StudentConsulting-konfigurationen först.";
    return;
  }
  b.onclick = async function () {
    b.disabled = true;
    out.textContent = " Startar…";
    try {
      var r = await api("/api/runs/manual", { method: "POST" });
      out.textContent = " Startad: " + r.runId;
    } catch (e) {
      out.textContent = " " + e.message;
    } finally {
      setTimeout(load, 250);
    }
  };
}
async function load() {
  try {
    var d = await api("/api/dashboard");
    dashboard = d;
    document.getElementById("freshness").textContent = "Uppdaterad " + when(d.generatedAt);
    renderOverview(d);
    renderApplications(d);
    renderRuns(d);
    renderReport(d);
    if (!configDirty) renderSystem(d);
    tab((location.hash || "#overview").slice(1));
  } catch (e) {
    overviewSignature = "";
    document.querySelector("[data-panel=overview]").innerHTML =
      '<div class="card bad">' + esc(e.message) + "</div>";
  }
  schedulePoll();
}
// Auto-refresh only while a run is active and the tab is visible; each refresh costs ~20 D1 queries.
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (
    document.visibilityState === "visible" &&
    dashboard &&
    dashboard.attention &&
    dashboard.attention.activeRun
  )
    pollTimer = setTimeout(load, 10000);
}
initTheme();
document.querySelectorAll("[data-tab]").forEach(function (a) {
  a.onclick = function (e) {
    e.preventDefault();
    location.hash = a.dataset.tab;
    tab(a.dataset.tab);
  };
});
window.onhashchange = function () {
  tab((location.hash || "#overview").slice(1));
};
document.getElementById("closeRun").onclick = function () {
  document.getElementById("runDialog").close();
};
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") load();
  else {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
});
load();
