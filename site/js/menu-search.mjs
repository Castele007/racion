import { dishProfile, dishSimilarity, SIMILAR_DISH } from "./culinary.mjs";

export const DEFAULT_MODE = "balanced";
export const MENU_MODES = {
  economy: { label: "Экономный", description: "Самая недорогая корзина среди найденных разнообразных меню." },
  balanced: { label: "Сбалансированный", description: "Больше разнообразия по мере роста бюджета." },
  variety: { label: "Максимальное разнообразие", description: "Больше разных продуктов, гарниров и способов приготовления." },
};

export const MIN_NEW_DISHES = 5;

export function better(candidate, reference) {
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] !== reference[i]) return candidate[i] < reference[i];
  }
  return false;
}

function shuffle(items, random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function weekProfiles(menu, recipes, method) {
  return (menu ?? []).flatMap(id => {
    const recipe = recipes.get(id);
    return recipe ? [dishProfile(recipe, method?.(recipe))] : [];
  });
}

export function menuRenewal(menu, previous, recipes, meals, method) {
  const old = weekProfiles(previous, recipes, method);
  const current = weekProfiles(menu, recipes, method);
  return meals.flatMap(meal => {
    const before = old.filter(dish => dish.recipe.meal === meal);
    if (!before.length) return [];
    const after = current.filter(dish => dish.recipe.meal === meal);
    const isNew = dish => before.every(other => other.recipe.id !== dish.recipe.id);
    const distinct = after.filter(dish => isNew(dish) && before.every(other => dishSimilarity(dish, other) < SIMILAR_DISH));
    return [{ meal, recipes: new Set(after.filter(isNew).map(dish => dish.recipe.id)).size,
      families: new Set(distinct.map(dish => dish.family)).size }];
  });
}

export function selectWeek({ pools, recipes, settings, random, previous, history, price }) {
  const { method, priority = () => 0 } = settings;
  const mode = Object.hasOwn(MENU_MODES, settings.mode) ? settings.mode : DEFAULT_MODE;
  const budget = Math.round(settings.budget * 100);
  const slotCount = pools.length * 7;
  const positions = Array.from({ length: slotCount }, (_, index) => index);
  const before = weekProfiles(previous, recipes, method);
  const lastRecipes = new Set(before.map(dish => dish.recipe.id));
  const expandAssortment = mode !== "economy" && before.length === slotCount &&
    settings.previousBudget > 0 && settings.previousBudget < settings.budget;
  const previousIngredients = new Set(before.flatMap(dish => dish.ingredients)).size;
  const recentRecipes = new Map(), recentFamilies = new Map();
  [previous, ...history.slice(0, 7)].forEach((menu, age) => {
    const weight = 0.65 ** age;
    const dishes = weekProfiles(menu, recipes, method);
    for (const id of new Set(dishes.map(dish => dish.recipe.id))) {
      recentRecipes.set(id, (recentRecipes.get(id) ?? 0) + weight);
    }
    for (const family of new Set(dishes.map(dish => dish.family))) {
      recentFamilies.set(family, (recentFamilies.get(family) ?? 0) + weight);
    }
  });

  let dishIndex = 0;
  const options = pools.map((pool, slot) => {
    const old = before.filter(dish => dish.recipe.meal === pool[0].meal);
    const dishes = pool.map(recipe => {
      const dish = dishProfile(recipe, method?.(recipe));
      const unseen = !lastRecipes.has(recipe.id);
      const different = unseen && old.every(other => dishSimilarity(dish, other) < SIMILAR_DISH);
      const exposure = 0.9 * (recentRecipes.get(recipe.id) ?? 0) + 0.35 * (recentFamilies.get(dish.family) ?? 0);
      const preference = Math.max(-6, Math.min(8, priority(recipe)));
      return { ...dish, index: dishIndex++, slot, unseen, different,
        quality: preference * (preference < 0 ? 0.6 : 0.14) - exposure + random() * 0.35 };
    });
    return {
      dishes,
      goal: old.length ? Math.min(MIN_NEW_DISHES, dishes.filter(dish => dish.unseen).length) : 0,
      differentGoal: old.length ? Math.min(MIN_NEW_DISHES,
        new Set(dishes.filter(dish => dish.different).map(dish => dish.family)).size) : 0,
    };
  });
  const overlaps = new Map();
  const similarCost = (first, second) => {
    const key = Math.min(first.index, second.index) * dishIndex + Math.max(first.index, second.index);
    if (!overlaps.has(key)) {
      // Small overlaps are normal for home cooking. Near-identical combinations
      // compete with each other even when their primary protein is different.
      const familyWeight = first.family === second.family ? 0.35 : 1;
      overlaps.set(key, Math.max(0, dishSimilarity(first, second) - 0.34) * familyWeight);
    }
    return overlaps.get(key);
  };

  function rank(plan, strategy) {
    const quote = price?.(plan);
    const cost = quote?.cost ?? 0;
    if (strategy === "packs" && quote) return [quote.missing ? 1 : 0, quote.missing, cost];
    const used = new Set(), families = new Set(), ingredients = new Set(), categories = new Set();
    const primary = new Set(), sides = new Set(), methods = new Set();
    const placed = options.map(() => ({ dishes: [], unseen: new Set(), different: new Set() }));
    let repeats = 0, familyRepeats = 0, similarity = 0, preferences = 0;
    for (const dish of plan) {
      if (!dish) continue;
      const id = dish.recipe.id;
      const meal = placed[dish.slot];
      for (const other of meal.dishes) similarity += similarCost(dish, other);
      meal.dishes.push(dish);
      if (dish.unseen) meal.unseen.add(id);
      if (dish.different) meal.different.add(dish.family);
      repeats += Number(used.has(id));
      familyRepeats += Number(families.has(dish.family));
      used.add(id);
      families.add(dish.family);
      if (dish.primary) primary.add(dish.primary);
      if (dish.side) sides.add(dish.side);
      if (dish.method) methods.add(dish.method);
      if (dish.category) categories.add(dish.slot + ":" + dish.category);
      for (const ingredient of dish.ingredients) ingredients.add(ingredient);
      preferences += dish.quality;
    }
    const due = (goal, filled) => strategy === "early" ? Math.min(goal, filled) : goal - (7 - filled);
    const deficits = placed.map(({ dishes, unseen }, slot) => Math.max(0, due(options[slot].goal, dishes.length) - unseen.size));
    const styleDeficit = placed.reduce((sum, { dishes, different }, slot) =>
      sum + Math.max(0, due(options[slot].differentGoal, dishes.length) - different.size), 0);
    const blend = 1.4 * categories.size + 1.55 * primary.size + 1.7 * sides.size + 0.9 * methods.size +
      0.66 * ingredients.size - 3.4 * similarity + preferences;
    const pricePressure = cost / Math.max(budget, 1) * (mode === "variety" ? 11 : 38);
    const diversity = [Math.max(...deficits), deficits.reduce((total, value) => total + value, 0),
      repeats, styleDeficit, familyRepeats];
    const filled = placed.reduce((total, meal) => total + meal.dishes.length, 0);
    const assortmentDeficit = expandAssortment && filled === slotCount ? Math.max(0, previousIngredients + 1 - ingredients.size) : 0;
    if (quote?.missing) return [2, quote.missing, ...diversity, cost, -blend];
    if (quote && cost > budget) return [1, cost, ...diversity, -blend];
    return [0, ...diversity, quote?.evidence ?? 0, assortmentDeficit,
      mode === "economy" || strategy === "economy" ? cost : pricePressure - blend, -blend, cost];
  }

  const shortlists = options.map(({ dishes }, slot) => {
    const scored = dishes.map(dish => {
      const plan = [];
      plan[slot] = dish;
      const quote = price?.(plan);
      return { dish, known: quote?.missing ?? 0, cost: quote?.cost ?? 0 };
    }).sort((a, b) => a.known - b.known || a.cost - b.cost || b.dish.quality - a.dish.quality);
    return scored.map(({ dish }) => dish);
  });

  function candidates(slot, cheap = false) {
    const all = options[slot].dishes;
    if (all.length <= 28) return shuffle(all, random);
    const sample = shuffle(all, random);
    const group = new Map();
    for (const dish of sample) {
      if (!group.has(dish.family)) group.set(dish.family, dish);
    }
    return new Set([...shortlists[slot].slice(0, cheap ? 22 : 7),
      ...[...group.values()].slice(0, 14), ...sample.slice(0, 10)]);
  }

  function sweep(plan, order, strategy) {
    let score = rank(plan, strategy);
    for (const position of order) {
      let selected = plan[position];
      for (const dish of candidates(position % pools.length, strategy === "packs" || strategy === "economy")) {
        if (dish === selected) continue;
        plan[position] = dish;
        const value = rank(plan, strategy);
        if (!selected || better(value, score)) [selected, score] = [dish, value];
      }
      plan[position] = selected;
    }
    return plan;
  }

  // Compare plans built from different directions. The inexpensive seed also
  // gives the wider modes a way to reuse packs before exploring costly dishes.
  const initial = [sweep([], positions, "early"), sweep([], shuffle(positions, random))];
  if (price) {
    initial.push(sweep([], positions, "economy"));
    const cheapest = sweep([], shuffle(positions, random), "packs");
    initial.push(sweep(cheapest, shuffle(positions, random), "economy"));
  }
  const ranked = initial.map(plan => ({ plan, score: rank(plan) }))
    .sort((left, right) => better(left.score, right.score) ? -1 : better(right.score, left.score) ? 1 : 0);
  let best = ranked[0].plan;
  let bestScore = ranked[0].score;
  for (const entry of ranked.slice(0, 2)) {
    const first = sweep([...entry.plan], shuffle(positions, random));
    const alternative = sweep(first, shuffle(positions, random));
    const score = rank(alternative);
    if (better(score, bestScore)) [best, bestScore] = [alternative, score];
  }
  if (price && (bestScore.slice(0, 6).some(value => value > 0) || bestScore[7] > 0)) {
    // Two different dishes can share a new pack or release an unused one.
    // Try replacing them together if individual swaps got stuck.
    const firstSlots = shuffle(positions, random).sort((a, b) =>
      Number(best[a].different) - Number(best[b].different) ||
      best.filter(dish => dish.family === best[b].family).length - best.filter(dish => dish.family === best[a].family).length);
    for (const first of firstSlots.slice(0, 5)) {
      const a = best[first];
      for (const second of shuffle(positions.filter(position => position !== first), random).slice(0, 4)) {
        const b = best[second];
        const shortlist = position => [...candidates(position % pools.length)].slice(0, 10);
        const trial = [...best];
        const rightOptions = shortlist(second);
        for (const left of shortlist(first)) {
          trial[first] = left;
          for (const right of rightOptions) {
            trial[second] = right;
            const score = rank(trial);
            if (better(score, bestScore)) [best, bestScore] = [[...trial], score];
          }
        }
        if (best[first] !== a || best[second] !== b) break;
      }
    }
    best = sweep(best, shuffle(positions, random));
  }
  bestScore = rank(best);
  for (const seed of [best, ...ranked.map(entry => entry.plan)]) {
    if (!price || bestScore[0] !== 0 || (!bestScore[1] && !bestScore[4])) break;
    // Make room in a tight basket before trying unfamiliar dishes again.
    const affordable = sweep([...seed], shuffle(positions, random), "economy");
    const trial = sweep(affordable, shuffle(positions, random), "early");
    const score = rank(trial);
    if (better(score, bestScore)) [best, bestScore] = [trial, score];
  }
  return best.map(dish => dish.recipe.id);
}
