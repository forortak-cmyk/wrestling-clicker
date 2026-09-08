// Конфигурация Боевого пропуска.
// Сезон длится 30 дней и переключается АВТОМАТИЧЕСКИ по времени, без крона и без
// отдельной таблицы в базе — просто считаем номер сезона от фиксированной точки отсчёта.
const SEASON_EPOCH = Date.UTC(2026, 0, 1); // точка отсчёта, сама дата значения не имеет
const SEASON_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LEVEL = 100;

const PREMIUM_PASS_PRICE_STARS = 450;

// Пакеты монет за Telegram Stars — от малого к максимально выгодному
const COIN_PACKAGES = [
  { id: 'coins_small', stars: 100, coins: 50000000, label: '🥉 Ստարտային փաթեթ' },
  { id: 'coins_medium', stars: 250, coins: 150000000, label: '🥈 Միջին փաթեթ' },
  { id: 'coins_large', stars: 500, coins: 350000000, label: '🥇 Մեծ փաթեթ' },
  { id: 'coins_mega', stars: 1000, coins: 800000000, label: '💎 Մեգա փաթեթ' },
  { id: 'coins_ultra', stars: 2000, coins: 2000000000, label: '👑 Ուլտրա փաթեթ (լավագույն արժեքը)' }
];

// Очки боевого пропуска (BP) за игровые действия
const BP_POINTS_PER_CLICK = 1;
const BP_POINTS_PER_COLLECT = 60; // фиксировано за один сбор пассивного дохода
const BP_POINTS_DAILY_BASE = 40;  // умножается на день streak (1..7) при ежедневном бонусе

function getCurrentSeason(now) {
  const seasonNumber = Math.floor((now - SEASON_EPOCH) / SEASON_LENGTH_MS);
  const seasonStartsAt = SEASON_EPOCH + seasonNumber * SEASON_LENGTH_MS;
  const seasonEndsAt = seasonStartsAt + SEASON_LENGTH_MS;
  return { seasonNumber, seasonStartsAt, seasonEndsAt };
}

// Сколько очков нужно набрать, чтобы перейти С предыдущего уровня НА этот
// (не накопительно) — плавно растущая кривая сложности
function pointsForLevel(level) {
  return Math.round(300 + level * 60 + level * level * 3);
}

// Накопительный порог: сколько очков всего нужно, чтобы достичь этого уровня
function cumulativePointsForLevel(level) {
  let total = 0;
  for (let l = 1; l <= level; l++) total += pointsForLevel(l);
  return total;
}

// Текущий уровень игрока по общему числу накопленных очков за сезон
function levelFromPoints(points) {
  let level = 0;
  let acc = 0;
  while (level < MAX_LEVEL) {
    const next = acc + pointsForLevel(level + 1);
    if (points < next) break;
    acc = next;
    level++;
  }
  return level;
}

// Награда за конкретный уровень на конкретном треке ('free' | 'premium').
// Каждые 10 уровней — дополнительно бонус к силе клика.
function rewardForLevel(level, track) {
  const freeCoins = Math.round(20000 * Math.pow(1.045, level));
  const isMilestone = level % 10 === 0;

  if (track === 'premium') {
    const reward = { coins: freeCoins * 4 };
    if (isMilestone) reward.clickPower = 3;
    return reward;
  }

  const reward = { coins: freeCoins };
  if (isMilestone) reward.clickPower = 1;
  return reward;
}

module.exports = {
  SEASON_LENGTH_MS,
  MAX_LEVEL,
  PREMIUM_PASS_PRICE_STARS,
  COIN_PACKAGES,
  BP_POINTS_PER_CLICK,
  BP_POINTS_PER_COLLECT,
  BP_POINTS_DAILY_BASE,
  getCurrentSeason,
  pointsForLevel,
  cumulativePointsForLevel,
  levelFromPoints,
  rewardForLevel
};
