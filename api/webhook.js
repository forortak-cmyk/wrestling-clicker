module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
  const APP_URL = 'https://t.me/Wrestler_clicker_bot/app';
  const ADMIN_APP_URL = 'https://wrestling-clicker.vercel.app/admin.html';

  const update = req.body;
  const message = update.message;

  // Обязательное подтверждение перед списанием Stars — без этого Telegram
  // не проведёт платёж. У нас нет ограниченных по количеству товаров,
  // поэтому подтверждаем всегда.
  if (update.pre_checkout_query) {
    const pcq = update.pre_checkout_query;
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_checkout_query_id: pcq.id, ok: true })
      });
    } catch (e) {
      console.error('answerPreCheckoutQuery failed:', e);
    }
    return res.status(200).send('OK');
  }

  // Оплата прошла — зачисляем то, что купили (Premium Pass или пакет монет)
  if (message && message.successful_payment) {
    const sp = message.successful_payment;
    const chatId = message.chat.id;

    let parsed = null;
    try { parsed = JSON.parse(sp.invoice_payload); } catch { parsed = null; }

    if (parsed && parsed.u) {
      const { createClient } = require('@supabase/supabase-js');
      const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bgrvgzgqtryudztngkqm.supabase.co';
      const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (SUPABASE_SERVICE_ROLE_KEY) {
        const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

        try {
          if (parsed.t === 'pass') {
            await db.from('users').update({ bp_premium: true }).eq('telegram_id', parsed.u);
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text: '🎖 Պրեմիում անցագիրը ակտիվացված է։ Բոլոր բարձրակարգ մրցանակները հասանելի են ձեզ այս սեզոնի ընթացքում 💪'
              })
            });
          } else if (parsed.t === 'coins') {
            const { COIN_PACKAGES, QUICK_COIN_PACKAGES } = require('./battlepass-config');
            const pack = [...COIN_PACKAGES, ...QUICK_COIN_PACKAGES].find(p => p.id === parsed.p);
            if (pack) {
              const { data: u } = await db.from('users')
                .select('balance, total_earned').eq('telegram_id', parsed.u).maybeSingle();
              if (u) {
                await db.from('users').update({
                  balance: (u.balance || 0) + pack.coins,
                  total_earned: (u.total_earned || 0) + pack.coins
                }).eq('telegram_id', parsed.u);

                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: chatId,
                    text: `💰 Ստացել եք ${pack.coins.toLocaleString('ru-RU')} մետաղադրամ: Շնորհակալությու՛ն գնման համար!`
                  })
                });
              }
            }
          }
        } catch (e) {
          console.error('Failed to process successful_payment:', e);
        }
      } else {
        console.error('Missing SUPABASE_SERVICE_ROLE_KEY — cannot credit payment', parsed);
      }
    }

    return res.status(200).send('OK');
  }

  if (message && message.text === '/start') {
    const chatId = message.chat.id;

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Привет! Жми кнопку, чтобы открыть приложение 👇',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎮 Открыть приложение', url: APP_URL }]
          ]
        }
      })
    });
  }

  if (message && message.text === '/admin') {
    const chatId = message.chat.id;
    const senderId = message.from && message.from.id;

    // Отвечаем только владельцу бота — все остальные не получат никакого ответа
    if (ADMIN_ID && String(senderId) === String(ADMIN_ID)) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '🔐 Админ-панель',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 Открыть статистику', web_app: { url: ADMIN_APP_URL } }]
            ]
          }
        })
      });
    }
  }

  res.status(200).send('OK');
};
