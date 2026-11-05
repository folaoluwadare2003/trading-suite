// netlify/functions/scan-trigger.mjs
//
// The timer. Netlify runs this at :02 and :32 past every hour; it only starts a scan when
// the Lagos time matches one of the SCAN TIMES below (and the day is inside the trading
// week). Scans start just AFTER the hourly candle closes, so they see the finished candle.
// A scan takes about 3-7 minutes. The MT5 bot waits for each scan to finish and then trades
// straight away (its TradeTimes setting must list the same times).
//
//     Scan starts (Lagos)   00:02  04:02  07:02  09:32  12:02  15:02  18:02  21:02
//
// Trading week (Lagos time):  Monday: nothing before 04:00.   Friday: nothing from 18:00.
// Saturday and Sunday: nothing. (Must match the bot's MondayStartHour / FridayCutoffHour.)
//
// To change the scan times, edit SCAN_TIMES below. Keep the minutes as :02 or :32, because
// that is when Netlify calls this function (to use other minutes, change the cron line too).

const SCAN_TIMES = ['00:02', '04:02', '07:02', '09:32', '12:02', '15:02', '18:02', '21:02']; // Lagos
const MONDAY_START_HOUR = 4;    // Lagos
const FRIDAY_CUTOFF_HOUR = 18;  // Lagos
const LATE_TOLERANCE_MIN = 4;   // Netlify may call a minute or two late

function decide(now) {
  const lagos = new Date(now.getTime() + 3600 * 1000); // Lagos = UTC+1, no daylight saving
  const dow = lagos.getUTCDay();           // 0 = Sunday ... 6 = Saturday
  const hour = lagos.getUTCHours();
  const minOfDay = hour * 60 + lagos.getUTCMinutes();
  if (dow === 0 || dow === 6) return { scan: false, why: 'weekend' };
  if (dow === 1 && hour < MONDAY_START_HOUR) return { scan: false, why: 'before Monday start' };
  if (dow === 5 && hour >= FRIDAY_CUTOFF_HOUR) return { scan: false, why: 'after Friday cutoff' };
  for (const t of SCAN_TIMES) {
    const [h, m] = t.split(':').map(Number);
    const diff = minOfDay - (h * 60 + m);
    if (diff >= 0 && diff <= LATE_TOLERANCE_MIN) return { scan: true, why: `scan time ${t}` };
  }
  return { scan: false, why: 'not a scan time' };
}

export default async () => {
  const d = decide(new Date());
  if (!d.scan) return new Response('skipped: ' + d.why);

  const base = process.env.SITE_URL || process.env.URL || 'https://wondrous-belekoy-2c7375.netlify.app';
  const secret = process.env.SIGNALS_TOKEN || '';
  try {
    const res = await fetch(`${base}/.netlify/functions/scan-background`, {
      method: 'POST',
      headers: { 'x-scan-secret': secret }
    });
    console.log(`scan started (${d.why}) -> HTTP ${res.status}`);
  } catch (e) {
    console.error('Could not trigger scan-background:', e.message);
  }
  return new Response('ok');
};

export const config = {
  schedule: "2,32 * * * *"
};
