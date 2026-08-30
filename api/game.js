const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bgrvgzgqtryudztngkqm.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_POWER = 750;
const SHOP_ITEMS = {
  1: { powerAdd: 1, costMultiplier: 500 }
};
const REF_FLAT_BONUS = 10000;
const REF_PERCENT = 0.1;
const SPIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SPIN_PRIZES = [1000, 5000, 10000, 25000, 50000, 100000];
const MIN_CLICK_INTERVAL_MS = 150; // защита: реалистично не быстрее одного клика в 150мс
const REFERRER_BONUS = 5000;

// Курс вывода средств: сколько монет стоит 1 драм, и минимальная сумма заявки
const WITHDRAWAL_RATE_COINS = 250000000;
const WITHDRAWAL_RATE_AMD = 750;
const MIN_WITHDRAWAL_COINS = 250000000;

// Ежедневный бонус за вход: 7 дней подряд, растёт на 20,000 в день.
// Пропуск дня (>48ч без захода) обнуляет прогресс до 1-го дня.
const DAILY_BONUS_REWARDS = [10000, 30000, 50000, 70000, 90000, 110000, 130000];
const DAILY_BONUS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DAILY_BONUS_RESET_MS = 48 * 60 * 60 * 1000;

// Бонус за просмотр рекламы — не чаще раза в 30 секунд (защита от спама кнопкой,
// точная проверка реального просмотра рекламы недоступна на клиенте)
const AD_REWARD_COINS = 30000;
const AD_REWARD_COOLDOWN_MS = 30 * 1000;

// Бонус за подписку на Telegram-канал — выдаётся один раз, проверяется через Telegram API.
// Бот должен быть добавлен в канал администратором, иначе проверка не сработает.
const CHANNEL_USERNAME = '@wrestlerclicker';
const CHANNEL_BONUS_COINS = 300000;

// Бизнесы — пассивный доход в час. Каждый покупается один раз.
// Доход накапливается офлайн, но не больше 3 часов подряд — это жёсткое ограничение,
// проверяется здесь, на сервере, а не доверяется клиенту.
const BUSINESSES = [
  { id: 1, cost: 5000000, incomePerHour: 4000 },
  { id: 2, cost: 25000000, incomePerHour: 18000 },
  { id: 3, cost: 120000000, incomePerHour: 80000 },
  { id: 4, cost: 600000000, incomePerHour: 380000 },
  { id: 5, cost: 3000000000, incomePerHour: 1800000 },
  { id: 6, cost: 15000000000, incomePerHour: 8500000 },
  { id: 7, cost: 75000000000, incomePerHour: 40000000 }
];
const MAX_OFFLINE_ACCRUAL_MS = 3 * 60 * 60 * 1000; // жёсткий лимит — максимум 3 часа

// Считает, сколько монет накопили бизнесы с момента последнего сбора,
// но не больше чем за 3 часа — даже если игрок отсутствовал намного дольше
function calculateBusinessIncome(user, now) {
  const owned = Array.isArray(user.businesses) ? user.businesses : [];
  const incomePerHour = owned.reduce((sum, id) => {
    const biz = BUSINESSES.find(b => b.id === id);
    return sum + (biz ? biz.incomePerHour : 0);
  }, 0);

  const lastCollect = Number(user.last_business_collect) || now;
  const elapsedMs = Math.min(Math.max(0, now - lastCollect), MAX_OFFLINE_ACCRUAL_MS);
  const earned = Math.floor(incomePerHour * (elapsedMs / (60 * 60 * 1000)));

  return { earned, incomePerHour };
}

// Проверяем, что запрос действительно пришёл из Telegram и не подделан
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
  if (!authDate || now - authDate > 86400) return null; // старше суток — отклоняем

  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

// Отправляет тебе уведомление в Telegram в реальном времени.
// Полный номер карты передаётся ТОЛЬКО здесь, в личном сообщении тебе — в базе не хранится.
async function notifyAdminAboutWithdrawal(details) {
  if (!BOT_TOKEN || !ADMIN_TELEGRAM_ID) return;

  const text =
    `🔔 Նոր հայտ գումարի հանման համար\n\n` +
    `👤 Խաղացող՝ ${details.username} (ID: ${details.telegramId})\n` +
    `📛 Անուն Ազգանուն՝ ${details.fullName}\n` +
    `💳 Քարտի համարը՝ ${details.cardNumber}\n` +
    `💰 Մետաղադրամներ՝ ${details.coins.toLocaleString('ru-RU')}\n` +
    `💵 Գումարը՝ ${details.amd.toLocaleString('ru-RU')} ֏`;

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_TELEGRAM_ID, text })
    });
  } catch (e) {
    console.error('Failed to notify admin about withdrawal:', e);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Game API is running');
  }

  if (!BOT_TOKEN || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing BOT_TOKEN or SUPABASE_SERVICE_ROLE_KEY env vars');
    return res.status(500).json({ ok: false, error: 'Server misconfigured' });
  }

  const { initData, action, payload } = req.body || {};

  const tgUser = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!tgUser || !tgUser.id) {
    return res.status(401).json({ ok: false, error: 'Invalid Telegram signature' });
  }

  const telegramId = tgUser.id;
  const userName = tgUser.first_name || 'Խաղացող';

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    let { data: user, error } = await db.from('users').select('*').eq('telegram_id', telegramId).maybeSingle();
    if (error) throw error;

    if (!user) {
      const { data: created, error: insertErr } = await db.from('users').insert([{
        telegram_id: telegramId,
        username: userName,
        balance: 0,
        total_earned: 0,
        click_power: 1,
        xp: 0,
        referrer_id: null,
        ref_claimed: 0,
        last_spin: 0,
        vouchers: [],
        last_sync: Date.now(),
        last_daily_claim: 0,
        daily_streak: 0,
        last_ad_reward_claim: 0,
        channel_bonus_claimed: false,
        businesses: [],
        last_business_collect: Date.now()
      }]).select().single();
      if (insertErr) throw insertErr;
      user = created;
    }

    switch (action) {
      case 'load': {
        const { count } = await db.from('users')
          .select('*', { count: 'exact', head: true })
          .eq('referrer_id', telegramId);

        // Считаем, сколько накопилось от бизнесов, но НЕ начисляем автоматически —
        // игрок должен нажать «Հավաքել», чтобы забрать доход
        const now = Date.now();
        const { earned: pendingBusinessIncome } = calculateBusinessIncome(user, now);

        return res.status(200).json({
          ok: true,
          user: { ...user, refCount: count || 0 },
          pendingBusinessIncome
        });
      }

      case 'sync': {
        // Клиент присылает, сколько кликов сделал с прошлой синхронизации.
        // Сервер сам решает, сколько из них реалистичны по времени.
        const now = Date.now();
        const lastSync = Number(user.last_sync) || now;
        const elapsedMs = Math.max(0, now - lastSync);
        const maxPlausibleClicks = Math.floor(elapsedMs / MIN_CLICK_INTERVAL_MS) + 5;
        const claimedClicks = Math.max(0, parseInt(payload && payload.clicks, 10) || 0);
        const validClicks = Math.min(claimedClicks, maxPlausibleClicks);

        const earned = validClicks * (user.click_power || 1);
        const newBalance = (user.balance || 0) + earned;
        const newTotal = (user.total_earned || 0) + earned;
        const newXp = (user.xp || 0) + validClicks;

        const { data: updated, error: upErr } = await db.from('users')
          .update({ balance: newBalance, total_earned: newTotal, xp: newXp, last_sync: now })
          .eq('telegram_id', telegramId).select().single();
        if (upErr) throw upErr;

        return res.status(200).json({ ok: true, user: updated, acceptedClicks: validClicks });
      }

      case 'buyUpgrade': {
        const itemId = payload && payload.itemId;
        const item = SHOP_ITEMS[itemId];
        if (!item) return res.status(400).json({ ok: false, error: 'Unknown item' });

        // Синхронизируем накопленные клики прямо здесь же, в этом запросе —
        // чтобы не делать два похода в базу подряд (клиент раньше сначала звал sync, потом buyUpgrade)
        const now = Date.now();
        const lastSync = Number(user.last_sync) || now;
        const elapsedMs = Math.max(0, now - lastSync);
        const maxPlausibleClicks = Math.floor(elapsedMs / MIN_CLICK_INTERVAL_MS) + 5;
        const claimedClicks = Math.max(0, parseInt(payload && payload.clicks, 10) || 0);
        const validClicks = Math.min(claimedClicks, maxPlausibleClicks);
        const clickEarned = validClicks * (user.click_power || 1);

        const syncedBalance = (user.balance || 0) + clickEarned;
        const syncedTotal = (user.total_earned || 0) + clickEarned;
        const syncedXp = (user.xp || 0) + validClicks;

        if (user.click_power + item.powerAdd > MAX_POWER) {
          return res.status(400).json({ ok: false, error: 'Max power reached', user });
        }
        const cost = user.click_power * item.costMultiplier;
        if (syncedBalance < cost) {
          return res.status(400).json({ ok: false, error: 'Not enough coins', user });
        }

        const { data: updated, error: upErr } = await db.from('users')
          .update({
            balance: syncedBalance - cost,
            total_earned: syncedTotal,
            xp: syncedXp,
            click_power: user.click_power + item.powerAdd,
            last_sync: now
          })
          .eq('telegram_id', telegramId).select().single();
        if (upErr) throw upErr;

        return res.status(200).json({ ok: true, user: updated });
      }

      case 'buyVoucher': {
        const p = payload || {};
        const { sponsor, prize, cost } = p;
        if (!sponsor || !prize || !cost) return res.status(400).json({ ok: false, error: 'Bad request' });
        if (user.balance < cost) return res.status(400).json({ ok: false, error: 'Not enough coins', user });

        const code = 'VCHR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const newVoucher = { sponsor, prize, code, date: new Date().toISOString() };
        const vouchers = Array.isArray(user.vouchers) ? [...user.vouchers, newVoucher] : [newVoucher];

        const { data: updated, error: upErr } = await db.from('users')
          .update({ balance: user.balance - cost, vouchers })
          .eq('telegram_id', telegramId).select().single();
        if (upErr) throw upErr;

        return res.status(200).json({ ok: true, user: updated, voucher: newVoucher });
      }

      case 'referralsList': {
        const { data: refs, error: refErr } = await db.from('users')
          .select('username, total_earned, telegram_id')
          .eq('referrer_id', telegramId);
        if (refErr) throw refErr;

        const flatBonus = refs.length * REF_FLAT_BONUS;
        const percentBonus = refs.reduce((sum, r) => sum + Math.floor((r.total_earned || 0) * REF_PERCENT), 0);
        const totalBonusEarned = flatBonus + percentBonus;
        const available = Math.max(0, totalBonusEarned - (user.ref_claimed || 0));

        return res.status(200).json({ ok: true, refs, refCount: refs.length, availableRefBonus: available });
      }

      case 'claimReferral': {
        const { data: refs, error: refErr } = await db.from('users')
          .select('total_earned')
          .eq('referrer_id', telegramId);
        if (refErr) throw refErr;

        const flatBonus = refs.length * REF_FLAT_BONUS;
        const percentBonus = refs.reduce((sum, r) => sum + Math.floor((r.total_earned || 0) * REF_PERCENT), 0);
        const totalBonusEarned = flatBonus + percentBonus;
        const available = Math.max(0, totalBonusEarned - (user.ref_claimed || 0));

        if (available <= 0) return res.status(400).json({ ok: false, error: 'No bonus available', user });

        const { data: updated, error: upErr } = await db.from('users')
          .update({
            balance: user.balance + available,
            total_earned: user.total_earned + available,
            ref_claimed: (user.ref_claimed || 0) + available
          })
          .eq('telegram_id', telegramId).select().single();
        if (upErr) throw upErr;

        return res.status(200).json({ ok: true, user: updated, claimed: available });
      }

      case 'setReferrer': {
        if (user.referrer_id) return res.status(400).json({ ok: false, error: 'Referrer already set', user });

        const refIdInput = parseInt(payload && payload.referrerId, 10);
        if (!refIdInput || isNaN(refIdInput)) return res.status(400).json({ ok: false, error: 'Bad ID' });
        if (refIdInput === telegramId) return res.status(400).json({ ok: false, error: 'Cannot refer yourself' });

        const { data: refUser, error: refErr } = await db.from('users')
          .select('telegram_id').eq('telegram_id', refIdInput).maybeSingle();
        if (refErr) throw refErr;
        if (!refUser) return res.status(404).json({ ok: false, error: 'Referrer not found' });

        const { data: updated, error: upErr } = await db.from('users')
          .update({
            referrer_id: refIdInput,
            balance: user.balance + REFERRER_BONUS,
            total_earned: user.total_earned + REFERRER_BONUS
          })
          .eq('telegram_id', telegramId).select().single();
        if (upErr) throw upErr;

        return res.status(200).json({ ok: true, user: updated });
      }

      case 'spin': {
        const now = Date.now();
        const lastSpin = Number(user.last_spin) || 0;
        if (now - lastSpin < SPIN_COOLDOWN_MS) {
          return res.status(400).json({ ok: false, error: 'Cooldown active', user });
        }

        const prize = SPIN_PRIZES[Math.floor(Math.random() * SPIN_PRIZES.length)];

        const { data: updated, error: upErr } = await db.from('users')
          .update({
            balance: user.balance + prize,
            total_earned: user.total_earned + prize,
            last_spin: now
          })
          .eq('telegram_id', telegramId).select().single();
        if (upErr) throw upErr;

        return res.status(200).json({ ok: true, user: updated, prize });
      }

      case 'requestWithdrawal': {
        const p = payload || {};
        const coins = Math.max(0, parseInt(p.coins, 10) || 0);
        const fullName = (p.fullName || '').trim();
        const cardNumber = (p.cardNumber || '').replace(/\s+/g, '');

        // Синхронизируем накопленные клики прямо здесь же, в этом запросе —
        // чтобы не делать два похода в базу подряд
        const now = Date.now();
        const lastSync = Number(user.last_sync) || now;
        const elapsedMs = Math.max(0, now - lastSync);
        const maxPlausibleClicks = Math.floor(elapsedMs / MIN_CLICK_INTERVAL_MS) + 5;
        const claimedClicks = Math.max(0, parseInt(p.clicks, 10) || 0);
        const validClicks = Math.min(claimedClicks, maxPlausibleClicks);
        const clickEarned = validClicks * (user.click_power || 1);

        const syncedBalance = (user.balance || 0) + clickEarned;
        const syncedTotal = (user.total_earned || 0) + clickEarned;
        const syncedXp = (user.xp || 0) + validClicks;

        if (coins < MIN_WITHDRAWAL_COINS) {
          return res.status(400).json({ ok: false, error: 'Below minimum', user });
        }
        if (coins > syncedBalance) {
          return res.status(400).json({ ok: false, error: 'Not enough coins', user });
        }
        if (!fullName) {
          return res.status(400).json({ ok: false, error: 'Name required', user });
        }
        if (!/^\d{13,19}$/.test(cardNumber)) {
          return res.status(400).json({ ok: false, error: 'Invalid card', user });
        }

        const amd = Math.floor((coins / WITHDRAWAL_RATE_COINS) * WITHDRAWAL_RATE_AMD);
        const cardLast4 = cardNumber.slice(-4);

        // Сначала создаём саму заявку — и только если это удалось, списываем монеты.
        // Так игрок никогда не потеряет монеты "в никуда", если с записью что-то пойдёт не так
        const { error: insErr } = await db.from('withdrawals').insert([{
          telegram_id: telegramId,
          username: userName,
          full_name: fullName,
          card_last4: cardLast4,
          coins_amount: coins,
          amd_amount: amd,
          status: 'pending'
        }]);
        if (insErr) throw insErr;

        const { data: updated, error: upErr } = await db.from('users')
          .update({ balance: syncedBalance - coins, total_earned: syncedTotal, xp: syncedXp, last_sync: now })
          .eq('telegram_id', telegramId)
          .gte('balance', coins - clickEarned) // атомарная защита от двух одновременных заявок
          .select().single();
        if (upErr) {
          // Баланса не хватило по факту (например, из-за гонки двух одновременных заявок) —
          // помечаем уже созданную заявку как отклонённую, чтобы не осталась висеть заявка без денег
          await db.from('withdrawals').update({ status: 'rejected' })
            .eq('telegram_id', telegramId).eq('status', 'pending')
            .eq('coins_amount', coins).eq('amd_amount', amd);
          return res.status(400).json({ ok: false, error: 'Not enough coins', user });
        }

        // Полный номер карты уходит только сюда, в личное сообщение админу — не в базу
        await notifyAdminAboutWithdrawal({
          username: userName,
          telegramId,
          fullName,
          cardNumber,
          coins,
          amd
        });

        return res.status(200).json({ ok: true, user: updated, amd });
      }

      case 'myWithdrawals': {
        const { data: withdrawals, error: wErr } = await db.from('withdrawals')
          .select('id, coins_amount, amd_amount, status, created_at')
          .eq('telegram_id', telegramId)
          .order('created_at', { ascending: false })
          .limit(20);
        if (wErr) throw wErr;

        return res.status(200).json({ ok: true, withdrawals: withdrawals || [] });
      }

      case 'claimDailyBonus': {
        const now = Date.now();
        const lastClaim = Number(user.last_daily_claim) || 0;
        const elapsed = lastClaim ? now - lastClaim : Infinity;

        if (lastClaim && elapsed < DAILY_BONUS_COOLDOWN_MS) {
          return res.status(400).json({ ok: false, error: 'Too soon', user });
        }

        let newStreak;
        if (!lastClaim || elapsed >= DAILY_BONUS_RESET_MS) {
          newStreak = 1; // первый заход или пропустил день — начинаем заново
        } else {
          newStreak = ((user.daily_streak || 0) % 7) + 1; // 7 → снова 1
        }

        const reward = DAILY_BONUS_REWARDS[newStreak - 1];

        const { data: updated, error: upErr } = await db.from('users')
          .update({
            balance: user.balance + reward,
            total_earned: user.total_earned + reward,
            last_daily_claim: now,
            daily_streak: newStreak
          })
          .eq('telegram_id', telegramId).select().single();
        if (upErr) throw upErr;

        return res.status(200).json({ ok: true, user: updated, reward, streakDay: newStreak });
      }

      case 'claimAdReward': {
        const now = Date.now();
        const lastClaim = Number(user.last_ad_reward_claim) || 0;

        if (now - lastClaim < AD_REWARD_COOLDOWN_MS) {
          return res.status(400).json({ ok: false, error: 'Cooldown active', user });
        }

        const { data: updated, error: upErr } = await db.from('users')
          .update({
            balance: user.balance + AD_REWARD_COINS,
            total_earned: user.total_earned + AD_REWARD_COINS,
            last_ad_reward_claim: now
          })
          .eq('telegram_id', telegramId).select().single();
        if (upErr) throw upErr;

        return res.status(200).json({ ok: true, user: updated, reward: AD_REWARD_COINS });
      }

      case 'claimChannelBonus': {
        if (user.channel_bonus_claimed) {
          return res.status(400).json({ ok: false, error: 'Already claimed', user });
        }

        // Спрашиваем у Telegram напрямую, подписан ли пользователь —
        // клиенту в этом вопросе доверять нельзя
        let isMember = false;
        try {
          const tgRes = await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(CHANNEL_USERNAME)}&user_id=${telegramId}`
          );
          const tgData = await tgRes.json();
          if (tgData.ok) {
            const status = tgData.result.status;
            isMember = status === 'member' || status === 'administrator' || status === 'creator';
          } else {
            console.error('getChatMember failed:', tgData);
          }
        } catch (e) {
          console.error('getChatMember error:', e);
        }

        if (!isMember) {
          return res.status(400).json({ ok: false, error: 'Not subscribed', user });
        }

        const { data: updated, error: upErr } = await db.from('users')
          .update({
            balance: user.balance + CHANNEL_BONUS_COINS,
            total_earned: user.total_earned + CHANNEL_BONUS_COINS,
            channel_bonus_claimed: true
          })
          .eq('telegram_id', telegramId).select().single();
        if (upErr) throw upErr;

        return res.status(200).json({ ok: true, user: updated, reward: CHANNEL_BONUS_COINS });
      }

      case 'buyBusiness': {
        const businessId = payload && payload.businessId;
        const biz = BUSINESSES.find(b => b.id === businessId);
        if (!biz) return res.status(400).json({ ok: false, error: 'Unknown business' });

        const owned = Array.isArray(user.businesses) ? user.businesses : [];
        if (owned.includes(businessId)) {
          return res.status(400).json({ ok: false, error: 'Already owned', user });
        }

        // Сначала собираем накопленный доход (с лимитом 3 часа), потом считаем баланс для покупки
        const now = Date.now();
        const { earned: businessEarned } = calculateBusinessIncome(user, now);
        const syncedBalance = user.balance + businessEarned;
        const syncedTotal = user.total_earned + businessEarned;

        if (syncedBalance < biz.cost) {
          return res.status(400).json({ ok: false, error: 'Not enough coins', user });
        }

        const newOwned = [...owned, businessId];

        const { data: updated, error: upErr } = await db.from('users')
          .update({
            balance: syncedBalance - biz.cost,
            total_earned: syncedTotal,
            businesses: newOwned,
            last_business_collect: now
          })
          .eq('telegram_id', telegramId).select().single();
        if (upErr) throw upErr;

        return res.status(200).json({ ok: true, user: updated });
      }

      case 'collectBusinessIncome': {
        const now = Date.now();
        const { earned } = calculateBusinessIncome(user, now);

        if (earned <= 0) {
          return res.status(400).json({ ok: false, error: 'Nothing to collect', user });
        }

        const { data: updated, error: upErr } = await db.from('users')
          .update({
            balance: user.balance + earned,
            total_earned: user.total_earned + earned,
            last_business_collect: now
          })
          .eq('telegram_id', telegramId).select().single();
        if (upErr) throw upErr;

        return res.status(200).json({ ok: true, user: updated, collected: earned });
      }

      default:
        return res.status(400).json({ ok: false, error: 'Unknown action' });
    }
  } catch (e) {
    console.error('Game API error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
