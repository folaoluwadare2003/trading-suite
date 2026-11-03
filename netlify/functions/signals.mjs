// netlify/functions/signals.mjs
//
// What the MT5 bot calls:   https://YOUR-SITE.netlify.app/api/signals?token=YOUR_SIGNALS_TOKEN
//
// Returns the latest scan as plain text (easy for MT5 to read):
//     GENERATED=<unix seconds>
//     COUNT=<number of picks>
//     EURUSD,BUY,90
//     GBPJPY,SELL,80
// Picks are already ranked best-first. Add &format=json to see everything
// (including every pair's score) in a browser, and &format=status to see how
// the last scan went (handy for checking the timer is working).

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const secret = process.env.SIGNALS_TOKEN || '';
  if (!secret || url.searchParams.get('token') !== secret) {
    return new Response('forbidden', { status: 403 });
  }

  const store = getStore('forexsim');
  const format = url.searchParams.get('format') || 'text';

  if (format === 'status') {
    const status = await store.get('status', { type: 'json' });
    return new Response(JSON.stringify(status || { message: 'No scan has run yet' }, null, 2), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  const data = await store.get('latest', { type: 'json' });
  if (!data) {
    return new Response('NODATA', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
  }

  if (format === 'json') {
    return new Response(JSON.stringify(data, null, 2), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  const lines = [
    `GENERATED=${Math.floor(data.generatedAt / 1000)}`,
    `COUNT=${data.picks.length}`,
    ...data.picks.map(p => `${p.sym},${p.side},${p.score}`)
  ];
  return new Response(lines.join('\n'), {
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }
  });
};

export const config = {
  path: "/api/signals"
};
