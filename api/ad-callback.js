const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Configure this URL only on the ad network's server-to-server reward notification.
// The secret is never returned to the game client.
module.exports = async function handler(req, res) {
  const secret = process.env.AD_CALLBACK_SECRET;
  const supplied = req.headers?.['x-ad-callback-secret'] || req.query?.key;
  if (!secret || typeof supplied !== 'string' || Buffer.byteLength(secret) !== Buffer.byteLength(supplied) ||
      !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))) {
    return res.status(401).json({ ok: false });
  }
  const input = req.method === 'POST' ? req.body || {} : req.query || {};
  if (input.event !== 'reward' || !/^[a-f0-9-]{36}$/i.test(input.sessionId || '') ||
      typeof input.eventId !== 'string' || !input.eventId || input.eventId.length > 200) {
    return res.status(400).json({ ok: false, error: 'Invalid reward receipt' });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ ok: false });
  const db = createClient(process.env.SUPABASE_URL || 'https://bgrvgzgqtryudztngkqm.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await db.from('ad_reward_sessions')
    .update({ verified: true, provider_event_id: input.eventId })
    .eq('id', input.sessionId).is('claimed_at', null)
    .gt('created_at', new Date(Date.now() - 15 * 60000).toISOString()).select('id');
  if (error) return res.status(500).json({ ok: false });
  return res.status(200).json({ ok: true, verified: data.length > 0 });
};
