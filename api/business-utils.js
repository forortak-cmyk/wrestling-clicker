// Бизнесы — пассивный доход в час. Каждый покупается один раз.
// Доход накапливается офлайн, но не больше 3 часов подряд — жёсткое ограничение,
// проверяется на сервере, не доверяется клиенту.
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

module.exports = { BUSINESSES, MAX_OFFLINE_ACCRUAL_MS, calculateBusinessIncome };
