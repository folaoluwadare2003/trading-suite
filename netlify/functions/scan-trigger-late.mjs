// netlify/functions/scan-trigger-late.mjs
//
// RETIRED. The extra 15:35 timer is no longer needed: scan-trigger.mjs now handles every
// scan time. This file has no schedule, so it does nothing. (It only exists so it can be
// replaced in the same upload as scan-trigger.mjs; you can delete it later.)

export default async () => new Response('retired');
