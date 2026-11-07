const { createPaymentPayload } = require('../lib/payment-payload');
const { PREMIUM_PASS_PRICE_STARS, COIN_PACKAGES, QUICK_COIN_PACKAGES } = require('./battlepass-config');

const BOT_TOKEN = process.env.BOT_TOKEN;

// Та же проверка подлинности, что и в остальных эндпоинтах — сервер не доверяет
// клиенту, кто он такой, без подписи Telegram
const { verifyTelegramInitData } = require('../lib/telegram-auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Payments API is running');
  }

  if (!BOT_TOKEN) {
    console.error('Missing BOT_TOKEN env var');
    return res.status(500).json({ ok: false, error: 'Server misconfigured' });
  }

  const { initData, type, packageId } = req.body || {};
  const tgUser = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!tgUser || !tgUser.id) {
    return res.status(401).json({ ok: false, error: 'Invalid Telegram signature' });
  }

  let title, description, payload, amountStars;

  if (type === 'premium_pass') {
    title = '🎖 Պրեմիում անցագիր';
    description = 'Բացում է Մարտական անցագրի պրեմիում գիծը այս սեզոնի բոլոր մակարդակների համար';
    payload = createPaymentPayload('pass', tgUser.id, null, BOT_TOKEN);
    amountStars = PREMIUM_PASS_PRICE_STARS;
  } else if (type === 'coins') {
    const pack = [...COIN_PACKAGES, ...QUICK_COIN_PACKAGES].find(p => p.id === packageId);
    if (!pack) return res.status(400).json({ ok: false, error: 'Unknown package' });

    title = `💰 ${pack.coins.toLocaleString('ru-RU')} մետաղադրամ`;
    description = `${pack.coins.toLocaleString('ru-RU')} 💰 ուղղակիորեն ձեր հաշվին`;
    payload = createPaymentPayload('coins', tgUser.id, pack, BOT_TOKEN);
    amountStars = pack.stars;
  } else {
    return res.status(400).json({ ok: false, error: 'Unknown type' });
  }

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description,
        payload,
        provider_token: '', // для Telegram Stars токен провайдера не нужен
        currency: 'XTR',
        prices: [{ label: title, amount: amountStars }]
      })
    });
    const tgData = await tgRes.json();

    if (!tgData.ok) {
      console.error('createInvoiceLink failed:', tgData);
      return res.status(500).json({ ok: false, error: 'Telegram API error' });
    }

    return res.status(200).json({ ok: true, invoiceUrl: tgData.result });
  } catch (e) {
    console.error('Payments API error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
