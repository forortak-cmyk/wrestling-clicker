const crypto = require('crypto');
const { PREMIUM_PASS_PRICE_STARS, COIN_PACKAGES, QUICK_COIN_PACKAGES, getCurrentSeason } = require('../api/battlepass-config');
function signature(value, token) {
  return crypto.createHmac('sha256', token).update(value).digest('hex').slice(0, 32);
}
function createPaymentPayload(type, userId, pack, token) {
  const season = getCurrentSeason(Date.now()).seasonNumber;
  const value = ['v1', type, userId, pack?.id || '-', season,
    pack?.stars || PREMIUM_PASS_PRICE_STARS, pack?.coins || 0, crypto.randomBytes(6).toString('hex')].join(':');
  const payload = `${value}:${signature(value, token)}`;
  if (Buffer.byteLength(payload) > 128) throw new Error('Invoice payload is too long');
  return payload;
}
function validatePayment(payload, userId, currency, amount, token) {
  if (typeof payload !== 'string' || !token || currency !== 'XTR' || !Number.isSafeInteger(amount) || amount <= 0) return null;
  let product;
  if (payload.startsWith('v1:')) {
    const parts = payload.split(':');
    if (parts.length !== 9 || !/^[a-f0-9]{32}$/.test(parts[8])) return null;
    const expected = signature(parts.slice(0, 8).join(':'), token);
    if (!crypto.timingSafeEqual(Buffer.from(parts[8]), Buffer.from(expected))) return null;
    product = { t: parts[1], u: Number(parts[2]), p: parts[3], s: Number(parts[4]), a: Number(parts[5]), c: Number(parts[6]) };
  } else {
    // Honour already issued legacy invoices only after the webhook has been authenticated.
    try {
      const old = JSON.parse(payload);
      const pack = [...COIN_PACKAGES, ...QUICK_COIN_PACKAGES].find(p => p.id === old.p);
      product = { ...old, a: old.t === 'pass' ? PREMIUM_PASS_PRICE_STARS : pack?.stars, c: pack?.coins || 0 };
    } catch { return null; }
  }
  if (!Number.isSafeInteger(product.u) || product.u <= 0 || product.u !== userId || product.a !== amount) return null;
  if (product.t !== 'pass' && product.t !== 'coins') return null;
  if (product.t === 'coins' && (!Number.isSafeInteger(product.c) || product.c <= 0)) return null;
  return product;
}
module.exports = { createPaymentPayload, validatePayment };
