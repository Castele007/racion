import { MEALS, portionsAt, recipeAmount } from "./planner.mjs";

export const ESTIMATE_STORE = { id: "estimate", name: "Ориентировочные цены" };

export function estimateRows(database, ingredients, overrides = {}) {
  if (database?.city !== "Оренбург") return [];
  return Object.entries(database.items ?? {}).flatMap(([id, item]) => {
    const ingredient = ingredients[id];
    if (!ingredient || !Number.isSafeInteger(item.packSize) || item.packSize <= 0 ||
        !Number.isSafeInteger(item.priceKopecks) || item.priceKopecks <= 0) return [];
    return [{
      ...ingredient, ...item, id,
      reference: database.references?.[item.referenceId],
      priceKopecks: overrides[id] ?? item.priceKopecks,
      originalPrice: item.priceKopecks,
      edited: Object.hasOwn(overrides, id),
    }];
  });
}

export function cleanOverrides(value, ingredients) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([id, price]) =>
    Object.hasOwn(ingredients, id) && Number.isSafeInteger(price) && price > 0 && price <= 100000000));
}

export function estimatePricing(database, ingredients, overrides) {
  const rows = estimateRows(database, ingredients, overrides);
  const lookup = new Map(rows.map(row => [row.id, row]));
  return {
    hasOffers: rows.length > 0,
    unitCost: id => lookup.has(id) ? lookup.get(id).priceKopecks / lookup.get(id).packSize : null,
    quote(list) {
      const lines = list.map(item => {
        const row = lookup.get(item.id);
        if (!row) return { ...item, hasPrice: false, conditional: [] };
        const count = Math.ceil(item.quantity / row.packSize);
        return {
          ...item, estimate: row, hasPrice: true, conditional: [], cost: count * row.priceKopecks,
          bought: count * row.packSize, packs: [{ count, offer: row }],
        };
      });
      const known = lines.filter(line => line.hasPrice);
      return {
        store: ESTIMATE_STORE, estimate: true, estimatedItems: known.length, stale: 0, lines,
        missing: lines.length - known.length,
        knownCost: known.length ? known.reduce((sum, line) => sum + line.cost, 0) : null,
        complete: known.length > 0 && known.length === lines.length,
      };
    },
  };
}

// Keep the store quote available for comparison. Fill gaps only in the
// planning quote and keep inventory, promotion and reference details per item.
export function fillMissingPrices(storeQuote, estimateQuote) {
  if (!storeQuote || storeQuote.complete || !estimateQuote) return storeQuote;
  const estimates = new Map(estimateQuote.lines.filter(line => line.hasPrice).map(line => [line.id, line]));
  let estimatedItems = 0;
  const lines = storeQuote.lines.map(line => {
    const estimate = estimates.get(line.id);
    if (line.hasPrice || !estimate) return line;
    estimatedItems++;
    return { ...estimate, conditional: line.conditional, outOfStock: line.outOfStock };
  });
  if (!estimatedItems) return storeQuote;
  const known = lines.filter(line => line.hasPrice);
  return {
    ...storeQuote, lines, estimate: true, estimatedItems,
    missing: lines.length - known.length,
    knownCost: known.reduce((sum, line) => sum + line.cost, 0),
    complete: known.length === lines.length,
  };
}

// Allocate each purchased ingredient once over the meals that use it. The
// largest-remainder adjustment preserves every kopeck in the shopping total.
export function allocateMealCosts(menu, recipes, ingredients, people, quote) {
  if (!quote?.complete) return null;
  const amounts = Array(menu.length).fill(0);
  for (const line of quote.lines) {
    const shares = menu.flatMap((id, index) => {
      const recipe = recipes.get(id);
      if (!Object.hasOwn(recipe.ingredients, line.id)) return [];
      const quantity = recipeAmount(recipe, line.id, portionsAt(people, index), ingredients[line.id].unit);
      const exact = line.cost * (quantity / line.quantity);
      const whole = Math.floor(exact);
      return [{ index, whole, fraction: exact - whole }];
    }).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    let rest = line.cost - shares.reduce((sum, share) => sum + share.whole, 0);
    for (const share of shares) amounts[share.index] += share.whole + (rest-- > 0 ? 1 : 0);
  }
  return amounts;
}

// Relax the packaging constraint and allow repeats. The resulting minimum
// cannot exceed the cost of an actual plan using this estimate database.
export function estimateLowerBound(recipes, ingredients, people, estimates, meals = MEALS) {
  if (!estimates.hasOffers || Object.keys(ingredients).some(id => estimates.unitCost(id) === null)) return null;
  const minima = new Map(meals.map(meal => [meal, Infinity]));
  for (const recipe of recipes) {
    const slot = meals.indexOf(recipe.meal);
    if (slot === -1) continue;
    const cost = Object.keys(recipe.ingredients).reduce((sum, id) =>
      sum + recipeAmount(recipe, id, portionsAt(people, slot), ingredients[id].unit) * estimates.unitCost(id), 0);
    minima.set(recipe.meal, Math.min(minima.get(recipe.meal), cost));
  }
  const total = 7 * [...minima.values()].reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) ? Math.floor(total) : null;
}
