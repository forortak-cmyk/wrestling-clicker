export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const APP_URL = 'https://t.me/Wrestler_clicker_bot/app';

  const update = req.body;
  const message = update.message;

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

  res.status(200).send('OK');
}
