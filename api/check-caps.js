const { createClient } = require('@supabase/supabase-js');
const { BUSINESSES, MAX_OFFLINE_ACCRUAL_MS } = require('./business-utils');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bgrvgzgqtryudztngkqm.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = 'https://t.me/Wrestler_clicker_bot/app';

// Вызывается внешним планировщиком (например cron-job.org) каждые 15-20 минут.
// Проверяет всех игроков, у кого забит 3-часовой лимит пассивного дохода и кому
// ещё не отправляли уведомление за этот цикл, и шлёт им сообщение в Telegram.
module.exports = async function handler(req, res) {
  // Защита: без правильного секрета в URL никто чужой не сможет дёргать эту ручку
  const providedSecret = (req.query && req.query.key) || req.headers['x-cron-secret'];
  if (!CRON_SECRET || providedSecret !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!BOT_TOKEN || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing BOT_TOKEN or SUPABASE_SERVICE_ROLE_KEY env vars');
    return res.status(500).json({ ok: false, error: 'Server misconfigured' });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = Date.now();

  try {
    const { data: users, error } = await db.from('users')
      .select('telegram_id, businesses, last_business_collect, cap_notified')
      .eq('cap_notified', false);
    if (error) throw error;

    let notified = 0;

    for (const u of (users || [])) {
      const owned = Array.isArray(u.businesses) ? u.businesses : [];
      if (owned.length === 0) continue;

      const incomePerHour = owned.reduce((sum, id) => {
        const biz = BUSINESSES.find(b => b.id === id);
        return sum + (biz ? biz.incomePerHour : 0);
      }, 0);
      if (incomePerHour <= 0) continue;

      const lastCollect = Number(u.last_business_collect) || now;
      const elapsed = now - lastCollect;

      if (elapsed >= MAX_OFFLINE_ACCRUAL_MS) {
        const text =
          `🔔 Ուշադրություն, Չեմպիո՛ն:\n\n` +
          `Քո բիզնեսների գանձարանը լիքն է՝ 3 ժամվա սահմանաչափին հասել ես 💰\n` +
          `Առանց քեզ վաստակն այլևս չի ավելանում — մի՛ ուշացիր, հավաքի՛ր մետաղադրամներդ, մինչև մրցակիցներդ քեզնից առաջ են անցնում ըմբշամարտի թատերաբեմում 🥊`;

        try {
          const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: u.telegram_id,
              text,
              reply_markup: {
                inline_keyboard: [[{ text: '🎮 Բացել հավելվածը', url: APP_URL }]]
              }
            })
          });
          const tgData = await tgRes.json();
          if (tgData.ok) {
            notified++;
            await db.from('users').update({ cap_notified: true }).eq('telegram_id', u.telegram_id);
          }
        } catch (e) {
          console.error('Failed to notify user about cap:', u.telegram_id, e);
        }

        await new Promise(r => setTimeout(r, 35)); // не упереться в лимиты Telegram
      }
    }

    return res.status(200).json({ ok: true, checked: (users || []).length, notified });
  } catch (e) {
    console.error('check-caps API error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
