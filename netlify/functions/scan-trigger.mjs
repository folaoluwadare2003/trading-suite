// netlify/functions/scan-trigger.mjs
//
// The timer. Netlify's scheduled functions only get ~30 seconds, far too short
// for a full warm-up, so this tiny function just kicks off scan-background.mjs
// (which is allowed up to 15 minutes) and returns.
//
// SCHEDULE is in UTC. Lagos is UTC+1 all year (no daylight saving), so:
//     Lagos time  =  UTC + 1 hour
//
// Current setting: a scan every 3 hours, EVERY day, 10 minutes before each of the
// bot's trade times (16:00, 19:00, 22:00, 01:00, 04:00, 07:00, 10:00, 13:00 Lagos).
// A scan takes about 3 minutes, so it is finished well before the trade time:
//
//     Scan at (Lagos)   15:50 18:50 21:50 00:50 03:50 06:50 09:50 12:50
//     Same in UTC       14:50 17:50 20:50 23:50 02:50 05:50 08:50 11:50
//
// To change the times, edit the hours in the cron line below ("minute hours * * *")
// and keep each scan about 10 minutes before the matching time in the bot's
// TradeTimes setting. The bot itself ignores weekends and the Friday-evening
// cutoff, so scans on those days are simply not used.

export default async () => {
  const base = process.env.SITE_URL || process.env.URL || 'https://wondrous-belekoy-2c7375.netlify.app';
  const secret = process.env.SIGNALS_TOKEN || '';
  try {
    const res = await fetch(`${base}/.netlify/functions/scan-background`, {
      method: 'POST',
      headers: { 'x-scan-secret': secret }
    });
    console.log(`scan-background triggered -> HTTP ${res.status}`);
  } catch (e) {
    console.error('Could not trigger scan-background:', e.message);
  }
  return new Response('ok');
};

export const config = {
  schedule: "50 2,5,8,11,14,17,20,23 * * *"
};
