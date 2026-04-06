importScripts('../renderer/constants.js');

const STAT_KEYS = ['d', 'p', 'c', 'w', 's'];
const TOTAL_ATTEMPTS = 5_000_000;
const MIN_TOTAL_ATTEMPTS = 1;
const MAX_TOTAL_ATTEMPTS = 50_000_000;
const DEFAULT_TARGET_COUNT = 360;
const MIN_TARGET_COUNT = 1;
const MAX_TARGET_COUNT = 5000;
const TEXT_ENCODER = new TextEncoder();
const EMPTY_FILTERS = Object.freeze({
  species: null,
  rarity: null,
  eye: null,
  hat: null,
  shiny: null,
  d: null,
  p: null,
  c: null,
  w: null,
  s: null,
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return function generateRandom() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const MASK64 = (1n << 64n) - 1n;
const WS0 = 0xa0761d6478bd642fn;
const WS1 = 0xe7037ed1a0b428dbn;
const WS2 = 0x8ebc6af09c88c6e3n;
const WS3 = 0x589965cc75374cc3n;

function wideMultiplyParts(left, right) {
  const maskedLeft = left & MASK64;
  const maskedRight = right & MASK64;
  const product = maskedLeft * maskedRight;
  return [product & MASK64, (product >> 64n) & MASK64];
}

function wideMix(left, right) {
  const [low, high] = wideMultiplyParts(left, right);
  return low ^ high;
}

function readUint64(buffer, offset) {
  let value = 0n;
  for (let index = 0; index < 8; index++) {
    value |= BigInt(buffer[offset + index]) << BigInt(index * 8);
  }
  return value;
}

function readUint32(buffer, offset) {
  let value = 0n;
  for (let index = 0; index < 4; index++) {
    value |= BigInt(buffer[offset + index]) << BigInt(index * 8);
  }
  return value;
}

function wyhash32(value) {
  const bytes = TEXT_ENCODER.encode(value);
  const byteLength = bytes.length;
  let seed = 0n;
  seed = (seed ^ wideMix((seed ^ WS0) & MASK64, WS1)) & MASK64;

  let left = 0n;
  let right = 0n;
  let offset = 0;

  if (byteLength <= 16) {
    if (byteLength >= 4) {
      left = ((readUint32(bytes, 0) << 32n) | readUint32(bytes, byteLength - 4)) & MASK64;
      const delta = (byteLength >>> 3) << 2;
      right = ((readUint32(bytes, delta) << 32n) | readUint32(bytes, byteLength - 4 - delta)) & MASK64;
    } else if (byteLength > 0) {
      left = (BigInt(bytes[0]) << 16n) | (BigInt(bytes[byteLength >> 1] || 0) << 8n) | BigInt(bytes[byteLength - 1] || 0);
    }
  } else {
    let remaining = byteLength;
    if (remaining > 48) {
      let seed1 = seed;
      let seed2 = seed;
      while (remaining > 48) {
        seed = wideMix((readUint64(bytes, offset) ^ WS1) & MASK64, (readUint64(bytes, offset + 8) ^ seed) & MASK64);
        seed1 = wideMix((readUint64(bytes, offset + 16) ^ WS2) & MASK64, (readUint64(bytes, offset + 24) ^ seed1) & MASK64);
        seed2 = wideMix((readUint64(bytes, offset + 32) ^ WS3) & MASK64, (readUint64(bytes, offset + 40) ^ seed2) & MASK64);
        offset += 48;
        remaining -= 48;
      }
      seed = (seed ^ seed1 ^ seed2) & MASK64;
    }
    while (remaining > 16) {
      seed = wideMix((readUint64(bytes, offset) ^ WS1) & MASK64, (readUint64(bytes, offset + 8) ^ seed) & MASK64);
      offset += 16;
      remaining -= 16;
    }
    left = readUint64(bytes, offset + remaining - 16);
    right = readUint64(bytes, offset + remaining - 8);
  }

  const mixedLeft = (left ^ WS1) & MASK64;
  const mixedRight = (right ^ seed) & MASK64;
  const [low, high] = wideMultiplyParts(mixedLeft, mixedRight);
  return Number(wideMix((low ^ WS0 ^ BigInt(byteLength)) & MASK64, (high ^ WS1) & MASK64) & 0xFFFFFFFFn);
}

function pickRandom(random, list) {
  return list[Math.floor(random() * list.length)];
}

function normalizeCategoryFilter(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeStatFilter(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeFilters(rawFilters = {}) {
  return {
    species: normalizeCategoryFilter(rawFilters.species),
    rarity: normalizeCategoryFilter(rawFilters.rarity),
    eye: normalizeCategoryFilter(rawFilters.eye),
    hat: normalizeCategoryFilter(rawFilters.hat),
    shiny: rawFilters.shiny === true ? true : null,
    d: normalizeStatFilter(rawFilters.d),
    p: normalizeStatFilter(rawFilters.p),
    c: normalizeStatFilter(rawFilters.c),
    w: normalizeStatFilter(rawFilters.w),
    s: normalizeStatFilter(rawFilters.s),
  };
}

function normalizeTotalAttempts(rawTotalAttempts) {
  if (rawTotalAttempts === null || rawTotalAttempts === undefined || rawTotalAttempts === '') return null;
  const parsed = Number(rawTotalAttempts);
  if (!Number.isFinite(parsed)) return null;
  const asInteger = Math.trunc(parsed);
  return Math.max(MIN_TOTAL_ATTEMPTS, Math.min(MAX_TOTAL_ATTEMPTS, asInteger));
}

function normalizeTargetCount(rawTargetCount) {
  const parsed = Number(rawTargetCount);
  if (!Number.isFinite(parsed)) return DEFAULT_TARGET_COUNT;
  const asInteger = Math.trunc(parsed);
  return Math.max(MIN_TARGET_COUNT, Math.min(MAX_TARGET_COUNT, asInteger));
}

function buildMeta(userId, salt) {
  const random = mulberry32(wyhash32(userId + salt));
  let rarityRoll = random() * 100;
  let rarity = 'common';
  for (const candidateRarity of RARITIES) {
    rarityRoll -= RARITY_WEIGHTS[candidateRarity];
    if (rarityRoll < 0) {
      rarity = candidateRarity;
      break;
    }
  }

  const species = pickRandom(random, SPECIES);
  const eye = pickRandom(random, EYES);
  const hat = rarity !== 'common' ? pickRandom(random, HATS) : 'none';
  const shiny = random() < 0.01;
  const floor = RARITY_FLOOR[rarity];
  const peakIndex = Math.floor(random() * STAT_KEYS.length);
  let dumpIndex = Math.floor(random() * STAT_KEYS.length);
  while (dumpIndex === peakIndex) {
    dumpIndex = Math.floor(random() * STAT_KEYS.length);
  }

  return { random, rarity, species, eye, hat, shiny, floor, peakIndex, dumpIndex };
}

function matchesCategoryFilters(meta, filters) {
  return (
    (!filters.species || meta.species === filters.species) &&
    (!filters.rarity || meta.rarity === filters.rarity) &&
    (!filters.eye || meta.eye === filters.eye) &&
    (!filters.hat || meta.hat === filters.hat) &&
    (!filters.shiny || meta.shiny === filters.shiny)
  );
}

function rollStats(meta, filters) {
  const values = [0, 0, 0, 0, 0];
  let total = 0;

  for (let statIndex = 0; statIndex < STAT_KEYS.length; statIndex++) {
    const randomValue = meta.random();
    let statValue;
    if (statIndex === meta.peakIndex) {
      statValue = Math.min(100, meta.floor + 50 + Math.floor(randomValue * 30));
    } else if (statIndex === meta.dumpIndex) {
      statValue = Math.max(1, meta.floor - 10 + Math.floor(randomValue * 15));
    } else {
      statValue = meta.floor + Math.floor(randomValue * 40);
    }

    const threshold = filters[STAT_KEYS[statIndex]];
    if (threshold !== null && statValue < threshold) return null;

    values[statIndex] = statValue;
    total += statValue;
  }

  return { total, d: values[0], p: values[1], c: values[2], w: values[3], s: values[4] };
}

function buildBuddyEntry(meta, salt, stats) {
  return {
    salt,
    rarity: meta.rarity,
    species: meta.species,
    eye: meta.eye,
    hat: meta.hat,
    shiny: meta.shiny,
    total: stats.total,
    d: stats.d,
    p: stats.p,
    c: stats.c,
    w: stats.w,
    s: stats.s,
  };
}

function fullRoll(userId, salt) {
  const meta = buildMeta(userId, salt);
  const stats = rollStats(meta, EMPTY_FILTERS);
  if (!stats) return null;
  return buildBuddyEntry(meta, salt, stats);
}

function randomSalt() {
  let salt = '';
  for (let index = 0; index < SALT_LENGTH; index++) {
    salt += CHARSET[(Math.random() * CHARSET.length) | 0];
  }
  return salt;
}

function upsertTopPool(pool, entry, limit) {
  if (pool.length < limit) {
    pool.push(entry);
    return { inserted: true, replaced: false };
  }

  let weakestIndex = 0;
  let weakestTotal = Infinity;
  for (let index = 0; index < pool.length; index++) {
    if (pool[index].total < weakestTotal) {
      weakestIndex = index;
      weakestTotal = pool[index].total;
    }
  }

  if (entry.total > weakestTotal) {
    pool[weakestIndex] = entry;
    return { inserted: false, replaced: true };
  }

  return { inserted: false, replaced: false };
}

self.onmessage = function onMessage(event) {
  try {
    const userId = typeof event?.data?.userId === 'string' ? event.data.userId.trim() : '';
    const filters = normalizeFilters(event?.data?.filters);
    if (!userId) {
      throw new Error('Search worker received an invalid userId.');
    }

    const pool = [];

    const currentBuddy = fullRoll(userId, DEFAULT_SALT);
    self.postMessage({ type: 'current', data: currentBuddy });

    let matchedCount = 0;
    let storedCount = 0;
    let bestTotal = 0;

    const totalAttempts = normalizeTotalAttempts(event?.data?.totalAttempts);
    const targetCount = normalizeTargetCount(event?.data?.targetCount);
    const progressInterval = Number.isFinite(totalAttempts) && totalAttempts > 0
      ? Math.max(1000, Math.floor(totalAttempts / 50))
      : 100000;

    for (let attempt = 0; totalAttempts === null || attempt < totalAttempts; attempt++) {
      const salt = randomSalt();
      const meta = buildMeta(userId, salt);

      if (matchesCategoryFilters(meta, filters)) {
        const stats = rollStats(meta, filters);
        if (stats) {
          matchedCount++;
          const entry = buildBuddyEntry(meta, salt, stats);
          const upsertResult = upsertTopPool(pool, entry, targetCount);
          if (upsertResult.inserted) storedCount++;
          if ((upsertResult.inserted || upsertResult.replaced)) {
            if (entry.total > bestTotal) bestTotal = entry.total;
            self.postMessage({ type: 'buddy', data: entry });
          }

          if (storedCount >= targetCount) {
            self.postMessage({
              type: 'progress',
              done: attempt + 1,
              total: totalAttempts,
              matches: matchedCount,
              stored: storedCount,
              bestTotal,
            });
            break;
          }
        }
      }

      if ((attempt + 1) % progressInterval === 0) {
        self.postMessage({
          type: 'progress',
          done: attempt + 1,
          total: totalAttempts ?? null,
          matches: matchedCount,
          stored: storedCount,
          bestTotal,
        });
      }
    }

    self.postMessage({ type: 'done', pool: pool.sort((left, right) => right.total - left.total) });
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
