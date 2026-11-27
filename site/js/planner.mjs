export const MEALS = ["breakfast", "lunch", "dinner"];
export const MEAL_NAMES = { breakfast: "Завтрак", lunch: "Обед", dinner: "Ужин" };
export const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
export const STORES = [
  { id: "pyaterochka", name: "Пятёрочка", mark: "5", url: "https://5ka.ru/" },
  { id: "magnit", name: "Магнит", mark: "М", url: "https://magnit.ru/" },
  { id: "lenta", name: "Лента", mark: "Л", url: "https://lenta.com/" },
  { id: "perekrestok", name: "Перекрёсток", mark: "П", url: "https://www.perekrestok.ru/" },
  { id: "metro", name: "METRO", mark: "M", url: "https://online.metro-cc.ru/" },
];
export const DEFAULT_SETTINGS = { people: 3, budget: 6500, exclusions: [] };
export const LIMITS = { people: 20, budget: 1000000, exclusions: 30 };
export const MAX_PRICE_AGE = 12 * 60 * 60 * 1000;

const STARTER_DAYS = [
  ["apple-oats", "chicken-noodle-soup", "roast-chicken-buckwheat"],
  ["syrniki", "home-borscht", "baked-pollock"],
  ["tomato-eggs", "pilaf-chicken", "pasta-tomato"],
  ["millet-pumpkin", "pea-soup", "beef-patties"],
  ["kefir-pancakes", "lentil-soup", "stew-cabbage"],
  ["curd-berries", "fish-soup", "chicken-sour-cream"],
  ["cheese-omelet", "pumpkin-soup", "vegetable-stew"],
];

export function normalize(value) {
  return String(value).toLocaleLowerCase("ru").replaceAll("ё", "е")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim();
}

export function cleanExclusions(values) {
  const unique = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string") continue;
    const label = value.trim().replace(/\s+/gu, " ").slice(0, 60);
    const key = normalize(label);
    if (key && !unique.has(key)) unique.set(key, label);
    if (unique.size === LIMITS.exclusions) break;
  }
  return [...unique.values()];
}

function integerWithin(value, maximum, fallback) {
  return Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

export function restoreSettings(saved) {
  return {
    people: integerWithin(saved?.people, LIMITS.people, DEFAULT_SETTINGS.people),
    budget: integerWithin(saved?.budget, LIMITS.budget, DEFAULT_SETTINGS.budget),
    exclusions: cleanExclusions(saved?.exclusions),
  };
}

export function exclusionIds(ingredients, exclusions) {
  const terms = cleanExclusions(exclusions).map(normalize);
  return new Set(Object.entries(ingredients).filter(([, ingredient]) => {
    const names = [ingredient.name, ...(ingredient.aliases ?? [])].map(normalize);
    return terms.some(term => names.some(name => name === term || name.startsWith(term + " ") ||
      name.endsWith(" " + term) || name.includes(" " + term + " ")));
  }).map(([id]) => id));
}

export function eligibleRecipes(recipes, ingredients, exclusions) {
  const excluded = exclusionIds(ingredients, exclusions);
  return recipes.filter(recipe => !Object.keys(recipe.ingredients).some(id => excluded.has(id)));
}

export function weekStart(now = new Date()) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Yekaterinburg", year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(now).reduce((parts, { type, value }) => ({ ...parts, [type]: value }), {});
  const monday = new Date(Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day)));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

export function dateAt(start, offset) {
  const date = new Date(start + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + offset);
  return date;
}

export function isWeekStart(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = dateAt(value, 0);
  return Number.isFinite(date.getTime()) && date.getUTCDay() === 1 && date.toISOString().startsWith(value);
}

export function starterMenu() {
  return STARTER_DAYS.flat();
}

export function validMenu(menu, recipes, ingredients, exclusions) {
  if (!Array.isArray(menu) || menu.length !== 21) return false;
  const allowed = new Map(eligibleRecipes(recipes, ingredients, exclusions).map(recipe => [recipe.id, recipe.meal]));
  return menu.every((id, index) => allowed.get(id) === MEALS[index % MEALS.length]);
}

export function recipeAmount(recipe, id, people, unit) {
  const quantity = recipe.ingredients[id] * people / recipe.servings;
  // Half an egg can be measured by whisking it, then using half by volume.
  return unit === "pcs" ? quantity : Math.ceil(quantity);
}

export function shoppingList(menu, recipesById, ingredients, people) {
  const quantities = new Map();
  for (const recipeId of menu) {
    const recipe = recipesById.get(recipeId);
    if (!recipe) continue;
    for (const id of Object.keys(recipe.ingredients)) {
      quantities.set(id, (quantities.get(id) ?? 0) + recipeAmount(recipe, id, people, ingredients[id].unit));
    }
  }
  return [...quantities].map(([id, quantity]) => ({ id, quantity, ...ingredients[id] }))
    .sort((a, b) => a.category.localeCompare(b.category, "ru") || a.name.localeCompare(b.name, "ru"));
}

const integerPrice = value => Number.isSafeInteger(value) && value > 0 && value <= 100000000;
const validSize = value => Number.isSafeInteger(value) && value > 0 && value <= 25000;

export function isStale(offer, store, now) {
  const updated = Date.parse(offer.updatedAt);
  return store.status === "stale" || offer.stale === true || !Number.isFinite(updated) ||
    updated > now || now - updated >= MAX_PRICE_AGE;
}

export function purchasable(offer, now) {
  if (offer.available !== true || !integerPrice(offer.priceKopecks) || !validSize(offer.packSize)) return false;
  if (offer.terms?.kind === "regular") return true;
  if (offer.terms?.kind !== "public") return false;
  const starts = Date.parse(offer.terms.startsAt);
  const ends = Date.parse(offer.terms.endsAt);
  return Number.isFinite(starts) && Number.isFinite(ends) && starts <= now && now < ends;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// Solve unbounded whole-pack purchase. A minimum-cost basket cannot overshoot by
// a whole additional pack, since removing that pack would make it cheaper.
export function cheapestPacks(quantity, offers) {
  if (!Number.isFinite(quantity) || quantity <= 0 || !offers.length) return null;
  const bySize = new Map();
  for (const offer of offers) {
    if (!validSize(offer.packSize) || !integerPrice(offer.priceKopecks)) continue;
    const other = bySize.get(offer.packSize);
    if (!other || offer.priceKopecks < other.priceKopecks) bySize.set(offer.packSize, offer);
  }
  const options = [...bySize.values()];
  if (!options.length) return null;
  if (options.length === 1) {
    const [offer] = options;
    const count = Math.ceil(quantity / offer.packSize);
    return { cost: count * offer.priceKopecks, bought: count * offer.packSize, packs: [{ offer, count }] };
  }

  const divisor = options.map(offer => offer.packSize).reduce(gcd);
  const target = Math.ceil(quantity / divisor);
  const sizes = options.map(offer => offer.packSize / divisor);
  const limit = target + Math.max(...sizes) - 1;
  const costs = new Float64Array(limit + 1).fill(Infinity);
  const previous = new Int32Array(limit + 1).fill(-1);
  costs[0] = 0;
  for (let amount = 0; amount < target; amount++) {
    if (costs[amount] === Infinity) continue;
    options.forEach((offer, index) => {
      const next = amount + sizes[index];
      const cost = costs[amount] + offer.priceKopecks;
      if (cost < costs[next]) {
        costs[next] = cost;
        previous[next] = index;
      }
    });
  }
  let best = target;
  for (let amount = target + 1; amount <= limit; amount++) {
    if (costs[amount] < costs[best]) best = amount;
  }
  const counts = new Map();
  for (let amount = best; amount > 0;) {
    const index = previous[amount];
    counts.set(index, (counts.get(index) ?? 0) + 1);
    amount -= sizes[index];
  }
  return {
    cost: costs[best],
    bought: best * divisor,
    packs: [...counts].map(([index, count]) => ({ offer: options[index], count })),
  };
}

export function pricing(catalog, now = Date.now()) {
  const stores = STORES.map(meta => ({ ...meta, ...(catalog?.city === "Оренбург" ?
    catalog?.stores?.find(store => store.id === meta.id) : undefined) }));
  const lookups = stores.map(store => {
    const byIngredient = new Map();
    if (store.location?.city === "Оренбург") {
      for (const offer of store.offers ?? []) {
        if (!byIngredient.has(offer.ingredientId)) byIngredient.set(offer.ingredientId, []);
        byIngredient.get(offer.ingredientId).push(offer);
      }
    }
    return { store, byIngredient, cache: new Map() };
  });

  function quoteLine(lookup, item) {
    const key = item.id + ":" + item.quantity;
    if (lookup.cache.has(key)) return lookup.cache.get(key);
    const all = (lookup.byIngredient.get(item.id) ?? []).filter(offer => offer.unit === item.unit);
    const possible = all.filter(offer => purchasable(offer, now));
    const fresh = possible.filter(offer => !isStale(offer, lookup.store, now));
    // Compare with historical quotes only when the ingredient has no fresh choice.
    const result = cheapestPacks(item.quantity, fresh.length ? fresh : possible);
    const conditional = all.filter(offer => offer.available && offer.terms?.kind === "conditional");
    const line = {
      ...item, ...result, hasPrice: result !== null, stale: result !== null && fresh.length === 0,
      conditional, outOfStock: all.length > 0 && all.every(offer => offer.available === false),
    };
    lookup.cache.set(key, line);
    return line;
  }

  function quote(list) {
    return lookups.map(lookup => {
      const lines = list.map(item => quoteLine(lookup, item));
      const known = lines.filter(line => line.hasPrice);
      const missing = lines.length - known.length;
      const stale = known.filter(line => line.stale).length;
      return {
        store: lookup.store, lines, missing, stale,
        knownCost: known.length ? known.reduce((sum, line) => sum + line.cost, 0) : null,
        complete: lines.length > 0 && missing === 0,
      };
    });
  }

  return {
    quote, stores,
    hasOffers: lookups.some(({ byIngredient }) =>
      [...byIngredient.values()].some(offers => offers.some(offer => purchasable(offer, now)))),
  };
}

export function bestQuote(quotes) {
  return quotes.filter(quote => quote.complete)
    .sort((a, b) => Number(Boolean(a.stale)) - Number(Boolean(b.stale)) || a.knownCost - b.knownCost)[0] ?? null;
}

function shuffle(items, random) {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

function quoteScore(quote, budget) {
  // Prefer a verified full basket within budget, then the lowest verified full
  // basket. Historic prices and incomplete baskets are separate evidence levels.
  // When whole packs tie, use ingredient consumption to keep searching toward
  // a plan that can actually drop a pack. This never changes the quoted total.
  const consumption = quote.lines.reduce((sum, line) =>
    sum + (line.hasPrice ? line.cost * line.quantity / line.bought : 0), 0);
  if (quote.complete && !quote.stale) return [quote.knownCost > budget ? 1 : 0, quote.knownCost, consumption];
  if (quote.complete) return [quote.knownCost > budget ? 3 : 2, quote.knownCost, consumption];
  return [4, quote.missing, quote.knownCost ?? Infinity, consumption];
}

function better(candidate, reference) {
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] !== reference[i]) return candidate[i] < reference[i];
  }
  return false;
}

export function generateMenu(recipes, ingredients, settings, prices, random = Math.random, previousMenu = []) {
  const eligible = eligibleRecipes(recipes, ingredients, settings.exclusions);
  const pools = MEALS.map(meal => eligible.filter(recipe => recipe.meal === meal).map(recipe => recipe.id));
  const empty = pools.map((pool, index) => pool.length ? null : MEALS[index]).filter(Boolean);
  if (empty.length) return { menu: null, empty };

  function candidate() {
    const days = pools.map(pool => {
      const mixed = shuffle(pool, random);
      return Array.from({ length: 7 }, (_, index) => mixed[index % mixed.length]);
    });
    return Array.from({ length: 21 }, (_, index) => days[index % 3][Math.floor(index / 3)]);
  }

  let menu = candidate();
  // A new draw should differ when alternatives exist, even if all prices are missing.
  for (let i = 0; i < 4 && menu.every((id, index) => id === previousMenu[index]); i++) menu = candidate();
  if (!prices?.hasOffers) return { menu, empty };

  const recipesById = new Map(eligible.map(recipe => [recipe.id, recipe]));
  const budget = settings.budget * 100;
  function rank(plan) {
    const quotes = prices.quote(shoppingList(plan, recipesById, ingredients, settings.people));
    return quotes.map(quote => quoteScore(quote, budget)).reduce((best, score) => better(score, best) ? score : best);
  }

  let score = rank(menu);
  for (let i = 0; i < 30; i++) {
    const trial = candidate();
    const trialScore = rank(trial);
    if (better(trialScore, score)) [menu, score] = [trial, trialScore];
  }
  // Refine the sampled plan without introducing repeats where seven choices exist.
  for (let index = 0; index < menu.length; index++) {
    const options = pools[index % 3].filter(id => !menu.includes(id));
    for (const id of shuffle(options, random).slice(0, 5)) {
      const trial = menu.map((current, slot) => slot === index ? id : current);
      const trialScore = rank(trial);
      if (better(trialScore, score)) [menu, score] = [trial, trialScore];
    }
  }
  return { menu, empty };
}

export function replacementOptions(menu, index, recipes, ingredients, exclusions) {
  const pool = eligibleRecipes(recipes, ingredients, exclusions).filter(recipe =>
    recipe.meal === MEALS[index % 3] && recipe.id !== menu[index]);
  const unused = pool.filter(recipe => !menu.includes(recipe.id));
  return (unused.length ? unused : pool).sort((a, b) => a.title.localeCompare(b.title, "ru"));
}

export function replacementMenu(menu, index, id, recipes, ingredients, exclusions) {
  if (!Number.isInteger(index) || index < 0 || index >= menu.length ||
      !replacementOptions(menu, index, recipes, ingredients, exclusions).some(recipe => recipe.id === id)) return null;
  return menu.map((current, slot) => slot === index ? id : current);
}
