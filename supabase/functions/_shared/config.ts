// Game content + economy/claim settings. Server-side source of truth: clients never send prices,
// yields or timers — they only name what they want to do.

export interface CropConfig {
  name: string;
  seedPrice: number; // coin
  growSeconds: number;
  yield: number; // units harvested
  sellPrice: number; // coin per unit
  xp: number;
  minLevel: number;
}

export const CROPS: Record<string, CropConfig> = {
  wheat: { name: "Wheat", seedPrice: 5, growSeconds: 2 * 60, yield: 2, sellPrice: 4, xp: 1, minLevel: 1 },
  corn: { name: "Corn", seedPrice: 10, growSeconds: 5 * 60, yield: 2, sellPrice: 8, xp: 2, minLevel: 1 },
  carrot: { name: "Carrot", seedPrice: 20, growSeconds: 15 * 60, yield: 3, sellPrice: 9, xp: 3, minLevel: 2 },
  tomato: { name: "Tomato", seedPrice: 40, growSeconds: 45 * 60, yield: 3, sellPrice: 18, xp: 5, minLevel: 3 },
  strawberry: { name: "Strawberry", seedPrice: 80, growSeconds: 2 * 3600, yield: 4, sellPrice: 30, xp: 8, minLevel: 5 },
};

export interface AnimalConfig {
  name: string;
  price: number; // coin to buy one
  maxOwned: number;
  minLevel: number;
  feedItem: string;
  feedQty: number;
  produceSeconds: number;
  produce: string;
  produceQty: number;
  xp: number;
}

export const ANIMALS: Record<string, AnimalConfig> = {
  chicken: {
    name: "Chicken",
    price: 100,
    maxOwned: 10,
    minLevel: 1,
    feedItem: "chicken_feed",
    feedQty: 1,
    produceSeconds: 20 * 60,
    produce: "egg",
    produceQty: 1,
    xp: 2,
  },
  cow: {
    name: "Cow",
    price: 500,
    maxOwned: 5,
    minLevel: 3,
    feedItem: "cow_feed",
    feedQty: 1,
    produceSeconds: 60 * 60,
    produce: "milk",
    produceQty: 1,
    xp: 5,
  },
  sheep: {
    name: "Sheep",
    price: 800,
    maxOwned: 5,
    minLevel: 5,
    feedItem: "sheep_feed",
    feedQty: 1,
    produceSeconds: 2 * 3600,
    produce: "wool",
    produceQty: 1,
    xp: 8,
  },
};

/** Shop items (non-animal). */
export const SHOP_ITEMS: Record<string, { name: string; price: number; minLevel: number }> = {
  chicken_feed: { name: "Chicken Feed", price: 5, minLevel: 1 },
  cow_feed: { name: "Cow Feed", price: 15, minLevel: 3 },
  sheep_feed: { name: "Sheep Feed", price: 25, minLevel: 5 },
};

/** Sell prices for everything that can be sold (crops + animal produce). */
export const SELL_PRICES: Record<string, number> = {
  ...Object.fromEntries(Object.entries(CROPS).map(([k, c]) => [k, c.sellPrice])),
  egg: 20,
  milk: 60,
  wool: 110,
};

/** Orders board: each order can be completed once per Bangkok day. */
export const ORDERS: Record<
  string,
  { name: string; items: Record<string, number>; rewardCoin: number; rewardXp: number }
> = {
  bakery_basic: { name: "Bakery Basics", items: { wheat: 6, egg: 2 }, rewardCoin: 120, rewardXp: 10 },
  garden_salad: { name: "Garden Salad", items: { carrot: 3, tomato: 2 }, rewardCoin: 200, rewardXp: 15 },
  farm_breakfast: { name: "Farm Breakfast", items: { egg: 3, milk: 2, corn: 4 }, rewardCoin: 350, rewardXp: 25 },
};

export const NEW_PLAYER = { gridSize: 9, startCoins: 500 };

function num(name: string, fallback: number): number {
  const v = Deno.env.get(name);
  return v ? Number(v) : fallback;
}

/** Claim policy (keep maxPerClaim <= FarmZClaim.dailyClaimCap if that on-chain guard is enabled). */
export function claimPolicy() {
  return {
    maxPerClaim: num("CLAIM_MAX_PER_DAY", 1000), // FARMZ
    minPerClaim: num("CLAIM_MIN_AMOUNT", 1), // FARMZ
    cooldownSeconds: num("CLAIM_COOLDOWN_SECONDS", 24 * 3600),
    signatureTtlSeconds: num("CLAIM_SIGNATURE_TTL_SECONDS", 3600),
    settleGraceSeconds: 120, // wait after deadline before trusting nonceUsed == false
    unsignedStaleSeconds: 120, // reserved-but-never-signed rows older than this are refunded
  };
}

// Shapes passed to the SQL RPCs.
export const cropsForSql = () =>
  Object.fromEntries(Object.entries(CROPS).map(([k, c]) => [k, { yield: c.yield, xp: c.xp }]));

export const animalsForSql = () =>
  Object.fromEntries(
    Object.entries(ANIMALS).map(([k, a]) => [k, {
      feed_item: a.feedItem,
      feed_qty: a.feedQty,
      produce_seconds: a.produceSeconds,
      produce: a.produce,
      produce_qty: a.produceQty,
      xp: a.xp,
    }]),
  );
