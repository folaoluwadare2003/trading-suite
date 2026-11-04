// netlify/functions/scan-trigger-late.mjs
//
// Second timer, only for the 15:45 (3:45pm Lagos) trade time: it starts the same scan
// at 15:35 Lagos = 14:35 UTC (Lagos is UTC+1 all year). A scan takes about 3-7 minutes,
// so the data is under 10 minutes old when the bot trades at 15:45.
// (A separate file is needed because one timer cannot mix ":50" and ":35" minutes.)

export default async () => {
  const base = process.env.SITE_URL || process.env.URL || 'https://wondrous-belekoy-2c7375.netlify.app';
  const secret = process.env.SIGNALS_TOKEN || '';
  try {
    const res = await fetch(`${base}/.netlify/functions/scan-background`, {
      method: 'POST',
      headers: { 'x-scan-secret': secret }
    });
    console.log(`scan-background triggered (15:35 timer) -> HTTP ${res.status}`);
  } catch (e) {
    console.error('Could not trigger scan-background:', e.message);
  }
  return new Response('ok');
};

export const config = {
  schedule: "35 14 * * *"
};
