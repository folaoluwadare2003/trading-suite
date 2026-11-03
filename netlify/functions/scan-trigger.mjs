// netlify/functions/scan-trigger.mjs
//
// The timer. Netlify's scheduled functions only get ~30 seconds, far too short
// for a full warm-up, so this tiny function just kicks off scan-background.mjs
// (which is allowed up to 15 minutes) and returns.
//
// SCHEDULE is in UTC. Lagos is UTC+1 all year (no daylight saving), so:
//     Lagos time  =  UTC + 1 hour
//
// Default below: 17:30 and 20:30 UTC  =  6:30pm and 9:30pm Lagos, Monday-Friday,
// i.e. 30 minutes before the bot's default trade times of 7:00pm and 10:00pm.
// To change the times, edit the two hours in the cron line (minute hours * * days):
//     "30 17,20 * * 1-5"
// Example for 6:30pm, 9:30pm, 12:30am and 3:30am Lagos -> "30 17,20,23,2 * * *"
// (always keep each warm-up about 30 minutes before the matching trade time in
// the bot's TradeTimes setting).

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
  schedule: "30 17,20 * * 1-5"
};
