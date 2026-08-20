const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bgrvgzgqtryudztngkqm.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs = [];
  for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  const authDate = parseInt(params.get('auth_date'), 10);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > 86400) return null;

  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Broadcast API is running');
  }

  if (!BOT_TOKEN || !SUPABASE_SERVICE_ROLE_KEY || !ADMIN_ID) {
    console.error('Missing BOT_TOKEN, SUPABASE_SERVICE_ROLE_KEY or ADMIN_TELEGRAM_ID env vars');
    return res.status(500).json({ ok: false, error: 'Server misconfigured' });
  }

  const { initData, text } = req.body || {};
  const tgUser = verifyTelegramInitData(initData, BOT_TOKEN);

  // Только твой Telegram ID может запустить рассылку — все остальные получают отказ
  if (!tgUser || String(tgUser.id) !== String(ADMIN_ID)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const message = (text || '').trim();
  if (!message) {
    return res.status(400).json({ ok: false, error: 'Empty message' });
  }
  if (message.length > 4000) {
    return res.status(400).json({ ok: false, error: 'Message too long' });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: users, error } = await db.from('users').select('telegram_id');
    if (error) throw error;

    let sent = 0;
    let failed = 0;

    // Отправляем по очереди с небольшой паузой, чтобы не упереться
    // в лимиты Telegram (около 30 сообщений в секунду на бота)
    for (const u of users) {
      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: u.telegram_id, text: message })
        });
        const tgData = await tgRes.json();
        if (tgData.ok) sent++; else failed++;
      } catch (e) {
        failed++;
      }
      await new Promise(r => setTimeout(r, 35));
    }

    return res.status(200).json({ ok: true, sent, failed, total: users.length });
  } catch (e) {
    console.error('Broadcast API error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
