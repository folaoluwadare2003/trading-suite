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
// the last scan went (handy for checking the timer is working), and &format=when
// for a plain-English "when did it last scan" line in Lagos time.

import { getStore } from "@netlify/blobs";

function lagos(ms) {
  return new Date(ms).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'medium', hour12: true }) + ' (Lagos time)';
}

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
    const shown = status ? { ...status, atLagos: lagos(status.at) } : { message: 'No scan has run yet' };
    return new Response(JSON.stringify(shown, null, 2), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  if (format === 'when') {
    const status = await store.get('status', { type: 'json' });
    const latest = await store.get('latest', { type: 'json' });
    const lines = [];
    if (latest) {
      const mins = Math.round((Date.now() - latest.generatedAt) / 60000);
      lines.push(`Latest saved scan finished: ${lagos(latest.generatedAt)} - ${mins} min ago`);
      lines.push(`Qualifying picks in it: ${latest.picks.length}`);
    } else {
      lines.push('No scan has been saved yet.');
    }
    if (status) lines.push(`Last scan attempt: ${lagos(status.at)} - ${status.ok ? 'OK' : 'PROBLEM'} - ${status.message}`);
    return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
  }

  const data = await store.get('latest', { type: 'json' });
  if (!data) {
    return new Response('NODATA', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
  }

  if (format === 'json') {
    return new Response(JSON.stringify({ generatedAtLagos: lagos(data.generatedAt), ...data }, null, 2), {
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
