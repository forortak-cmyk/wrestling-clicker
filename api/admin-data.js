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
    return res.status(200).send('Admin API is running');
  }

  if (!BOT_TOKEN || !SUPABASE_SERVICE_ROLE_KEY || !ADMIN_ID) {
    console.error('Missing BOT_TOKEN, SUPABASE_SERVICE_ROLE_KEY or ADMIN_TELEGRAM_ID env vars');
    return res.status(500).json({ ok: false, error: 'Server misconfigured' });
  }

  const { initData } = req.body || {};
  const tgUser = verifyTelegramInitData(initData, BOT_TOKEN);

  // Только твой Telegram ID получает доступ к данным — все остальные получают отказ
  if (!tgUser || String(tgUser.id) !== String(ADMIN_ID)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: users, error } = await db.from('users').select('*');
    if (error) throw error;

    let totalBalance = 0;
    let totalEarned = 0;
    let totalVouchers = 0;
    const perSponsor = {};
    const voucherLog = [];

    for (const u of users) {
      totalBalance += u.balance || 0;
      totalEarned += u.total_earned || 0;
      const vouchers = Array.isArray(u.vouchers) ? u.vouchers : [];
      totalVouchers += vouchers.length;

      for (const v of vouchers) {
        perSponsor[v.sponsor] = (perSponsor[v.sponsor] || 0) + 1;
        voucherLog.push({
          username: u.username || 'Խաղացող',
          telegram_id: u.telegram_id,
          sponsor: v.sponsor,
          prize: v.prize,
          code: v.code,
          date: v.date
        });
      }
    }

    voucherLog.sort((a, b) => new Date(b.date) - new Date(a.date));

    return res.status(200).json({
      ok: true,
      stats: {
        totalUsers: users.length,
        totalBalance,
        totalEarned,
        totalVouchers,
        perSponsor
      },
      vouchers: voucherLog
    });
  } catch (e) {
    console.error('Admin API error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
