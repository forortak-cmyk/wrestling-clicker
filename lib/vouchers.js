// Preserve the voucher endpoint; prices and descriptions come only from this server catalogue.
function findVoucher(payload) {
  let catalog;
  try { catalog = JSON.parse(process.env.VOUCHER_CATALOG_JSON || '[]'); } catch { return null; }
  if (!Array.isArray(catalog)) return null;
  const item = catalog.find(v => v && (payload.voucherId ? v.id === payload.voucherId :
    v.sponsor === payload.sponsor && v.prize === payload.prize));
  if (!item || typeof item.sponsor !== 'string' || typeof item.prize !== 'string' ||
      !Number.isSafeInteger(item.cost) || item.cost <= 0) return null;
  return item;
}
module.exports = { findVoucher };
