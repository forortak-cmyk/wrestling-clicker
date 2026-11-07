const crypto = require('crypto');
const { validatePayment } = require('../lib/payment-payload');
const { getCurrentSeason } = require('./battlepass-config');
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
  const APP_URL = 'https://t.me/Wrestler_clicker_bot/app';
  const ADMIN_APP_URL = 'https://wrestling-clicker.vercel.app/admin.html';

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!BOT_TOKEN || !secret) return res.status(503).send('Webhook is not configured');
  const provided = req.headers?.['x-telegram-bot-api-secret-token'];
  if (typeof provided !== 'string' || Buffer.byteLength(provided) !== Buffer.byteLength(secret) ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret))) {
    return res.status(401).send('Unauthorized');
  }
  const update = req.body || {};
  const message = update.message;

  // Обязательное подтверждение перед списанием Stars — без этого Telegram
  // не проведёт платёж. У нас нет ограниченных по количеству товаров,
  // поэтому проверяем владельца, валюту, сумму и сезон перед подтверждением.
  if (update.pre_checkout_query) {
    const pcq = update.pre_checkout_query;
    const valid = validatePayment(pcq.invoice_payload, pcq.from?.id, pcq.currency, pcq.total_amount, BOT_TOKEN);
    const currentSeason = getCurrentSeason(Date.now()).seasonNumber;
    const accepted = !!valid && (valid.t !== 'pass' || valid.s === undefined || valid.s === currentSeason);
    try {
      const answer = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_checkout_query_id: pcq.id, ok: accepted, ...(!accepted ? { error_message: 'Invalid or expired invoice. Please create a new invoice.' } : {}) })
      });
      if (!(await answer.json()).ok) return res.status(502).send('Telegram rejected checkout response');
    } catch (e) {
      console.error('answerPreCheckoutQuery failed:', e);
      return res.status(502).send('Checkout response failed');
    }
    return res.status(200).send('OK');
  }

  // Оплата прошла — зачисляем то, что купили (Premium Pass или пакет монет)
  if (message && message.successful_payment) {
    const sp = message.successful_payment;
    const chatId = message.chat.id;

    const parsed = validatePayment(sp.invoice_payload, message.from?.id, sp.currency, sp.total_amount, BOT_TOKEN);
    if (!parsed || typeof sp.telegram_payment_charge_id !== 'string' || !sp.telegram_payment_charge_id) {
      return res.status(400).send('Invalid payment');
    }
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) return res.status(503).send('Payment storage is not configured');
    try {
      const { createClient } = require('@supabase/supabase-js');
      const db = createClient(process.env.SUPABASE_URL || 'https://bgrvgzgqtryudztngkqm.supabase.co', key);
      const { data, error } = await db.rpc('credit_telegram_payment', {
        p_charge_id: sp.telegram_payment_charge_id, p_telegram_id: parsed.u,
        p_product: parsed.t, p_coins: parsed.c, p_stars: sp.total_amount,
        p_season: getCurrentSeason(Date.now()).seasonNumber
      });
      if (error) throw error;
      if (data.credited) {
        const text = parsed.t === 'pass'
          ? '🎖 Պրեմիում անցագիրը ակտիվացված է։'
          : `💰 Ստացել եք ${parsed.c.toLocaleString('ru-RU')} մետաղադրամ: Շնորհակալությու՛ն գնման համար!`;
        // Receipt is committed first; Telegram retries cannot credit the payment twice.
        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text })
          });
        } catch (e) { console.error('Payment receipt notification failed'); }
      }
    } catch (e) {
      console.error('Failed to process payment:', e.code || 'unknown');
      return res.status(500).send('Payment processing failed; retry');
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
