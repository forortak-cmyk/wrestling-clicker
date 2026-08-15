const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bgrvgzgqtryudztngkqm.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_POWER = 500;
const SHOP_ITEMS = {
  1: { powerAdd: 1, costMultiplier: 100 },
  2: { powerAdd: 5, costMultiplier: 450 },
  3: { powerAdd: 10, costMultiplier: 800 }
};
const REF_FLAT_BONUS = 10000;
const REF_PERCENT = 0.1;
const SPIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SPIN_PRIZES = [1000, 5000, 10000, 25000, 50000, 100000];
const MIN_CLICK_INTERVAL_MS = 150; // защита: реалистично не быстрее одного клика в 150мс
const REFERRER_BONUS = 5000;

const ENERGY_MAX = 500;
const ENERGY_REGEN_PER_MS = 100 / (60 * 60 * 1000); // 100 энергии в час
const AD_ENERGY_BONUS = 100;
const AD_ENERGY_COOLDOWN_MS = 60 * 1000; // 1 минута между просмотрами рекламы за энергию —
                                          // временная защита, пока не подключена серверная
                                          // проверка реального просмотра рекламы через Adsgram

// Считает, сколько энергии накопилось к моменту now, с учётом пассивного восстановления
function calculateRegeneratedEnergy(storedEnergy, lastUpdateMs, nowMs) {
  const elapsed = Math.max(0, nowMs - (Number(lastUpdateMs) || nowMs));
  const regenerated = (Number(storedEnergy) || 0) + elapsed * ENERGY_REGEN_PER_MS;
  return Math.min(ENERGY_MAX, regenerated);
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
        referrer_id: null,
        ref_claimed: 0,
        last_spin: 0,
        vouchers: [],
        last_sync: Date.now(),
        energy: ENERGY_MAX,
        last_energy_update: Date.now(),
        last_ad_energy_claim: 0
      }]).select().single();
      if (insertErr) throw insertErr;
      user = created;
    }

    switch (action) {
      case 'load': {
        const { count } = await db.from('users')
          .select('*', { count: 'exact', head: true })
          .eq('referrer_id', telegramId);

        // Досчитываем энергию за время, что игрока не было в приложении
        const now = Date.now();
        const regenEnergy = calculateRegeneratedEnergy(user.energy, user.last_energy_update, now);

        let freshUser = user;
        if (Math.round(regenEnergy) !== (user.energy || 0)) {
          const { data: updated, error: upErr } = await db.from('users')
            .update({ energy: regenEnergy, last_energy_update: now })
            .eq('telegram_id', telegramId).select().single();
          if (upErr) throw upErr;
          freshUser = updated;
        }

        return res.status(200).json({ ok: true, user: { ...freshUser, refCount: count || 0 } });
      }

      case 'sync': {
        // Клиент присылает, сколько кликов сделал с прошлой синхронизации.
        // Сервер сам решает, сколько из них реалистичны по времени и по энергии.
        const now = Date.now();
        const lastSync = Number(user.last_sync) || now;
        const elapsedMs = Math.max(0, now - lastSync);
        const maxPlausibleClicks = Math.floor(elapsedMs / MIN_CLICK_INTERVAL_MS) + 5;
        const claimedClicks = Math.max(0, parseInt(payload && payload.clicks, 10) || 0);

        const clickPower = user.click_power || 1;
        const regenEnergy = calculateRegeneratedEnergy(user.energy, user.last_energy_update, now);
        const maxClicksByEnergy = Math.floor(regenEnergy / clickPower);

        const validClicks = Math.min(claimedClicks, maxPlausibleClicks, maxClicksByEnergy);

        const earned = validClicks * clickPower;
        const newBalance = (user.balance || 0) + earned;
        const newTotal = (user.total_earned || 0) + earned;
        const newEnergy = Math.max(0, regenEnergy - validClicks * clickPower);

        const { data: updated, error: upErr } = await db.from('users')
          .update({
            balance: newBalance,
            total_earned: newTotal,
            last_sync: now,
            energy: newEnergy,
            last_energy_update: now
          })
          .eq('telegram_id', telegramId).select().single();
        if (upErr) throw upErr;

        return res.status(200).json({ ok: true, user: updated, acceptedClicks: validClicks });
      }

      case 'buyUpgrade': {
        const itemId = payload && payload.itemId;
        const item = SHOP_ITEMS[itemId];
        if (!item) return res.status(400).json({ ok: false, error: 'Unknown item' });

        if (user.click_power + item.powerAdd > MAX_POWER) {
          return res.status(400).json({ ok: false, error: 'Max power reached', user });
        }
        const cost = user.click_power * item.costMultiplier;
        if (user.balance < cost) {
          return res.status(400).json({ ok: false, error: 'Not enough coins', user });
        }

        const { data: updated, error: upErr } = await db.from('users')
          .update({ balance: user.balance - cost, click_power: user.click_power + item.powerAdd })
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

      case 'restoreEnergy': {
        const now = Date.now();

        // Временная защита от спама, пока не подключена реальная проверка
        // просмотра рекламы через Adsgram reward callback на сервере
        const lastClaim = Number(user.last_ad_energy_claim) || 0;
        if (now - lastClaim < AD_ENERGY_COOLDOWN_MS) {
          return res.status(400).json({ ok: false, error: 'Cooldown active', user });
        }

        const regenEnergy = calculateRegeneratedEnergy(user.energy, user.last_energy_update, now);
        const newEnergy = Math.min(ENERGY_MAX, regenEnergy + AD_ENERGY_BONUS);

        const { data: updated, error: upErr } = await db.from('users')
          .update({
            energy: newEnergy,
            last_energy_update: now,
            last_ad_energy_claim: now
          })
          .eq('telegram_id', telegramId).select().single();
        if (upErr) throw upErr;

        return res.status(200).json({ ok: true, user: updated });
      }

      default:
        return res.status(400).json({ ok: false, error: 'Unknown action' });
    }
  } catch (e) {
    console.error('Game API error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
