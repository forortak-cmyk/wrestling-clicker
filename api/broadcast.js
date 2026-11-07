const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bgrvgzgqtryudztngkqm.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const { verifyTelegramInitData } = require('../lib/telegram-auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Broadcast API is running');
  }

  if (!BOT_TOKEN || !SUPABASE_SERVICE_ROLE_KEY || !ADMIN_ID) {
    console.error('Missing BOT_TOKEN, SUPABASE_SERVICE_ROLE_KEY or ADMIN_TELEGRAM_ID env vars');
    return res.status(500).json({ ok: false, error: 'Server misconfigured' });
  }

  const { initData, text, afterTelegramId } = req.body || {};
  const tgUser = verifyTelegramInitData(initData, BOT_TOKEN);

  // Только твой Telegram ID может запустить рассылку — все остальные получают отказ
  if (!tgUser || String(tgUser.id) !== String(ADMIN_ID)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const message = typeof text === 'string' ? text.trim() : '';
  const cursor = Number(afterTelegramId || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return res.status(400).json({ ok: false, error: 'Invalid cursor' });
  if (!message) {
    return res.status(400).json({ ok: false, error: 'Empty message' });
  }
  if (message.length > 4000) {
    return res.status(400).json({ ok: false, error: 'Message too long' });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: users, error } = await db.from('users').select('telegram_id')
      .gt('telegram_id', cursor).order('telegram_id', { ascending: true }).limit(100);
    if (error) throw error;

    let sent = 0;
    let failed = 0;

    // Отправляем по очереди с небольшой паузой, чтобы не упереться
    // в лимиты Telegram (около 30 сообщений в секунду на бота)
    const deadline = Date.now() + 45000;
    let processed = 0;
    let nextCursor = cursor;
    for (const u of users) {
      if (Date.now() > deadline) break;
      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: u.telegram_id, text: message }),
          signal: AbortSignal.timeout(5000)
        });
        const tgData = await tgRes.json();
        if (tgData.ok) sent++; else failed++;
      } catch (e) {
        failed++;
      }
      processed++;
      nextCursor = u.telegram_id;
      await new Promise(r => setTimeout(r, 35));
    }

    return res.status(200).json({ ok: true, sent, failed, total: processed, nextCursor: processed < users.length || users.length === 100 ? nextCursor : null });
  } catch (e) {
    console.error('Broadcast API error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
