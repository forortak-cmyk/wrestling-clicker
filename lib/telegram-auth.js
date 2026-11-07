const crypto = require('crypto');
function verifyTelegramInitData(initData, botToken) {
  if (typeof initData !== 'string' || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!/^[a-f0-9]{64}$/i.test(hash || '')) return null;
    if ([...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) return null;
    params.delete('hash');
    const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => `${key}=${value}`).join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed = crypto.createHmac('sha256', key).update(check).digest();
    if (!crypto.timingSafeEqual(computed, Buffer.from(hash, 'hex'))) return null;
    const authDate = Number(params.get('auth_date'));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(authDate) || authDate <= 0 || authDate > now + 30 || now - authDate > 86400) return null;
    const user = JSON.parse(params.get('user'));
    return user && Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
  } catch { return null; }
}
module.exports = { verifyTelegramInitData };
