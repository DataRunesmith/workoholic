// `wrangler dev` does not fire cron triggers by itself. This calls the
// Worker's scheduled handler at 09:00 UTC every day, like the production cron
// "0 9 10-13 * *"; the Worker itself only acts on the 10th–13th.
const port = process.env.PORT || "8787";
const url = `http://127.0.0.1:${port}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("0 9 10-13 * *")}`;

function msUntilNextRun(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

async function tick() {
  try {
    const response = await fetch(url);
    console.log(`[scheduler] scheduled run triggered: HTTP ${response.status}`);
  } catch (error) {
    console.error(`[scheduler] could not reach the Worker: ${error.message}`);
  }
  setTimeout(tick, msUntilNextRun());
}

setTimeout(tick, msUntilNextRun());
console.log(`[scheduler] next run in ${Math.round(msUntilNextRun() / 60000)} min`);
