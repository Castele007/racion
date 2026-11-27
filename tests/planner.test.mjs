import { CATEGORIES, SIDES, SIMILAR_DISH, completeDish, dishProfile, dishSimilarity, familyOf } from "../site/js/culinary.mjs";
import {
  ALLERGENS, EQUIPMENT, MEALS as QUESTIONNAIRE_MEALS, activeMeals, buildRules, compatibleMethods,
  mealPeople, plannerSettings, portionSchedule, restoreAnswers, validBudget, validateStep,
} from "../site/js/questionnaire.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { allocateMealCosts, estimateLowerBound, estimatePricing, estimateRows, fillMissingPrices } from "../site/js/estimates.mjs";
import {
  MEALS, STORES, bestQuote, cheapestPacks, eligibleRecipes, exclusionIds, generateMenu,
  mealIngredientCosts, pricing, purchasable, recipeAmount, replacementMenu, replacementOptions, shoppingList,
  starterMenu, validMenu, weekForDate, weekStart,
} from "../site/js/planner.mjs";

const load = file => JSON.parse(readFileSync(new URL("../site/data/" + file + ".json", import.meta.url), "utf8"));
const ingredients = load("ingredients");
const recipes = load("recipes");
const byId = new Map(recipes.map(recipe => [recipe.id, recipe]));
const now = Date.parse("2026-11-27T06:00:00Z");
const scope = { city: "Оренбург", address: "Тестовая точка", id: "fixture", channel: "pickup" };

function offer(overrides = {}) {
  return {
    packSize: 1000, unit: "g", ingredientId: "rice", priceKopecks: 6500, available: true,
    terms: { kind: "regular" }, updatedAt: "2026-11-27T04:00:00Z", ...overrides,
  };
}

function catalog(stores) {
  return { city: "Оренбург", stores: stores.map((entry, index) => ({
    id: STORES[index].id, status: "fresh", location: scope, ...entry,
  })) };
}

function randomWithSeed(seed) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

test("public cookbook has at least 300 complete, unique recipes and working assets", () => {
  assert.equal(byId.size, recipes.length);
  assert.equal(new Set(recipes.map(recipe => recipe.title)).size, recipes.length);
  assert.ok(recipes.length >= 300);
  for (const meal of QUESTIONNAIRE_MEALS) assert.ok(recipes.filter(recipe => recipe.meal === meal).length >= 7);
  const imageHashes = new Set();
  const sides = new Set();
  for (const recipe of recipes) {
    assert.ok(recipe.title && QUESTIONNAIRE_MEALS.includes(recipe.meal) && /^[a-z-]+$/.test(recipe.id));
    assert.ok(recipe.minutes >= 10 && recipe.servings > 0);
    assert.ok(recipe.instructions.length >= 3 && recipe.instructions.every(step => step.length >= 25));
    for (const [id, count] of Object.entries(recipe.ingredients)) {
      assert.ok(Object.hasOwn(ingredients, id) && Number.isInteger(count) && count > 0);
    }
    assert.ok(Array.isArray(recipe.tags) && recipe.methods.length > 0);
    assert.ok(Object.hasOwn(recipe.ingredients, recipe.mainIngredient), recipe.id);
    assert.ok(Object.hasOwn(CATEGORIES, recipe.category) && /^[a-z-]+$/.test(recipe.family), recipe.id);
    assert.ok(["standalone", "with-side", "needs-side"].includes(recipe.servingStyle), recipe.id);
    if (recipe.servingStyle === "with-side") {
      assert.ok(Object.hasOwn(SIDES, recipe.sideDish), recipe.id);
      sides.add(recipe.sideDish);
    } else assert.equal(recipe.sideDish, null, recipe.id);
    for (const method of recipe.methods) {
      assert.ok(method.equipment.every(key => Object.hasOwn(EQUIPMENT, key)) && method.minutes > 0);
      assert.ok(method.mode && method.instructions.length >= 3);
      assert.ok(method.temperature === null || method.temperature >= 100);
    }
    assert.equal(recipe.image, recipe.id);
    const asset = new URL("../site/assets/" + recipe.image + ".webp", import.meta.url);
    assert.ok(existsSync(asset));
    const data = readFileSync(asset);
    assert.equal(data.toString("ascii", 0, 4), "RIFF");
    assert.equal(data.toString("ascii", 8, 12), "WEBP");
    imageHashes.add(createHash("sha256").update(data).digest("hex"));
  }
  assert.equal(imageHashes.size, recipes.length);
  assert.deepEqual([...sides].sort(), Object.keys(SIDES).sort());
  assert.ok(validMenu(starterMenu(), recipes, ingredients, []));
});

test("regional public snapshot has all stores and only validated data shapes", () => {
  const snapshot = load("prices");
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.city, "Оренбург");
  assert.deepEqual(snapshot.stores.map(store => store.id), STORES.map(store => store.id));
  for (const store of snapshot.stores) {
    assert.ok(["unavailable", "stale", "partial", "fresh"].includes(store.status));
    if (!store.offers.length) assert.equal(store.status, "unavailable");
    if (store.offers.length) assert.equal(store.location.city, snapshot.city);
    for (const entry of store.offers) {
      assert.equal(entry.unit, ingredients[entry.ingredientId]?.unit);
      assert.ok(entry.packSize > 0 && Number.isSafeInteger(entry.packSize));
      assert.ok(entry.name && entry.priceKopecks > 0 && Number.isSafeInteger(entry.priceKopecks));
      assert.ok(typeof entry.available === "boolean" && Number.isFinite(Date.parse(entry.updatedAt)));
      assert.equal(new URL(entry.sourceUrl).protocol, "https:");
    }
  }
});

test("week boundary uses the time zone of Orenburg", () => {
  assert.equal(weekStart(new Date("2026-11-29T18:59:59Z")), "2026-11-23");
  assert.equal(weekStart(new Date("2026-11-29T19:00:00Z")), "2026-11-30");
});

test("generation respects exclusions, meal types, variety, and cannot submit an empty meal pool", () => {
  const settings = { people: 3, budget: 4500, exclusions: ["грибы", "ЛУК", "рыба"] };
  const { menu } = generateMenu(recipes, ingredients, settings, null, randomWithSeed(13));
  assert.equal(menu.length, 21);
  const possible = eligibleRecipes(recipes, ingredients, settings.exclusions);
  for (const [slot, meal] of MEALS.entries()) {
    const distinct = new Set(menu.filter((_, index) => index % 3 === slot));
    assert.equal(distinct.size, Math.min(7, possible.filter(recipe => recipe.meal === meal).length));
  }
  assert.ok(validMenu(menu, recipes, ingredients, settings.exclusions));
  assert.deepEqual([...exclusionIds(ingredients, ["Лук"])], ["onion", "green-onion"]);
  const { menu: impossible, empty } = generateMenu(recipes, ingredients,
    { ...settings, allows: () => false }, null);
  assert.equal(impossible, null);
  assert.ok(empty.length > 0);
  assert.ok(eligibleRecipes(recipes, ingredients, ["шампиньоны"]).every(recipe => !recipe.ingredients.mushrooms));
});

test("replacement respects eligibility and preserves the other 20 slots", () => {
  const menu = starterMenu();
  const options = replacementOptions(menu, 0, recipes, ingredients, ["банан"]);
  assert.ok(options.length);
  assert.ok(options.every(item => item.meal === "breakfast" && !menu.includes(item.id) && !item.ingredients.banana));
  const updated = replacementMenu(menu, 0, options[0].id, recipes, ingredients, ["банан"]);
  assert.equal(updated[0], options[0].id);
  assert.deepEqual(updated.slice(1), menu.slice(1));
  assert.equal(replacementMenu(menu, 0, "baked-pollock", recipes, ingredients, []), null);
});

test("shopping aggregates proportional quantities before rounding to purchasable packs", () => {
  const list = shoppingList(["syrniki", "syrniki", "apple-oats"], byId, ingredients, 3);
  assert.equal(recipeAmount(byId.get("syrniki"), "egg", 3, "pcs"), 1.5);
  assert.equal(list.find(item => item.id === "egg").quantity, 3);
  assert.equal(list.find(item => item.id === "curd").quantity, 1050);
  assert.equal(list.find(item => item.id === "milk").quantity, 525);
  const result = cheapestPacks(3.5, [offer({ unit: "pcs", packSize: 3 })]);
  assert.equal(result.packs[0].count, 2);
});

test("minimum cost can require combining different sizes, not prorating a unit price", () => {
  const small = offer({ packSize: 400, priceKopecks: 4900 });
  const large = offer({ packSize: 600, priceKopecks: 6800 });
  const exact = cheapestPacks(1000, [small, large, offer()]);
  assert.equal(exact.cost, 6500);
  const mix = cheapestPacks(1000, [small, large]);
  assert.equal(mix.cost, 11700);
  assert.equal(mix.bought, 1000);
  assert.deepEqual(new Set(mix.packs.map(item => item.offer.packSize)), new Set([400, 600]));
  assert.equal(cheapestPacks(1001, [small, large]).cost, 13600);
});

test("regional scope, stale prices, partial coverage, out of stock and promotion terms stay distinct", () => {
  const publicOffer = offer({
    priceKopecks: 4200, terms: { kind: "public", startsAt: "2026-11-25T00:00:00Z", endsAt: "2026-11-28T00:00:00Z" },
  });
  const expiredOffer = offer({
    priceKopecks: 100, terms: { kind: "public", startsAt: "2026-11-24T00:00:00Z", endsAt: "2026-11-25T00:00:00Z" },
  });
  const restrictedOffer = offer({ priceKopecks: 300, terms: { kind: "conditional", note: "Только по карте" } });
  assert.equal(purchasable(expiredOffer, now), false);
  assert.equal(purchasable(publicOffer, now), true);
  assert.equal(purchasable(restrictedOffer, now), false);
  const prices = pricing(catalog([
    { offers: [offer(), publicOffer, expiredOffer, restrictedOffer, offer({ ingredientId: "flour" })] },
    { status: "stale", offers: [offer({ priceKopecks: 3800 }), offer({ ingredientId: "flour" })] },
    { offers: [offer(), offer({ ingredientId: "flour", available: false })] },
    { location: { ...scope, city: "Орск" }, offers: [offer(), offer({ ingredientId: "flour" })] },
  ]), now);
  const list = ["rice", "flour"].map(id => ({ id, quantity: 1200, ...ingredients[id] }));
  const quotes = prices.quote(list);
  const [fresh, stale, partial, wrongCity, missing] = quotes;
  assert.equal(fresh.knownCost, 21400);
  assert.equal(fresh.lines[0].conditional.length, 1);
  assert.equal(stale.stale, 2);
  assert.ok(stale.complete && stale.knownCost < fresh.knownCost);
  assert.equal(partial.missing, 1);
  assert.ok(partial.lines[1].outOfStock);
  assert.equal(wrongCity.knownCost, null);
  assert.equal(missing.complete, false);
  assert.equal(bestQuote(quotes), fresh);
});

test("the budget search finds a full basket within budget when inexpensive options exist", () => {
  const sampleIngredients = { rice: ingredients.rice, flour: ingredients.flour };
  const sampleRecipes = MEALS.flatMap(meal => Array.from({ length: 9 }, (_, i) => ({
    id: meal + i, meal, servings: 2, ingredients: i === 0 ? { flour: 100 } : { rice: 100 },
  })));
  const prices = pricing(catalog([{ offers: [
    offer({ priceKopecks: 100 }), offer({ ingredientId: "flour", priceKopecks: 50000 }),
  ] }]), now);
  const { menu } = generateMenu(sampleRecipes, sampleIngredients,
    { people: 2, budget: 5, exclusions: [] }, prices, randomWithSeed(21));
  assert.equal(new Set(menu).size, 21);
  assert.ok(menu.every(id => !id.endsWith("0")));
  const list = shoppingList(menu, new Map(sampleRecipes.map(item => [item.id, item])), sampleIngredients, 2);
  assert.equal(bestQuote(prices.quote(list)).knownCost, 300);
});

test("the local estimates cover the whole cookbook, with a dated source and reproducible package model", () => {
  const database = load("estimates");
  const rows = estimateRows(database, ingredients);
  assert.equal(rows.length, Object.keys(ingredients).length);
  for (const row of rows) {
    const ref = row.reference;
    assert.match(ref.observedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new URL(ref.url).protocol, "https:");
    assert.ok(ref.name && row.method && row.priceKopecks > 0);
    const factor = Number(row.model.factor);
    const base = row.model.basis === "unit" ? ref.priceKopecks * row.packSize / ref.amount : ref.priceKopecks;
    if (row.model.basis === "unit") assert.equal(row.unit, ref.unit);
    assert.equal(row.priceKopecks, Math.round(base * factor / 100) * 100);
  }
});

test("the empty-store fallback changes a real weekly menu to fit a tighter budget", () => {
  const estimates = estimatePricing(load("estimates"), ingredients, {});
  const unavailable = pricing({ city: "Оренбург", stores: [] });
  const prices = { hasOffers: estimates.hasOffers, quote: list => [...unavailable.quote(list), estimates.quote(list)] };
  const settings = { people: 3, budget: 5500, exclusions: [] };
  const select = budget => generateMenu(recipes, ingredients, { ...settings, budget }, prices, randomWithSeed(13), starterMenu()).menu;
  const generous = select(9500);
  const tight = select(5500);
  assert.equal(new Set(tight).size, 21);
  assert.notDeepEqual(tight, generous);
  const quote = menu => bestQuote(prices.quote(shoppingList(menu, byId, ingredients, settings.people)));
  assert.ok(quote(generous).knownCost > settings.budget * 100);
  const subtotal = quote(tight);
  assert.ok(subtotal.estimate && subtotal.knownCost <= settings.budget * 100);
  const allocated = allocateMealCosts(tight, byId, ingredients, settings.people, subtotal);
  assert.equal(allocated.length, 21);
  assert.ok(allocated.every(value => Number.isSafeInteger(value) && value > 0));
  assert.equal(allocated.reduce((sum, value) => sum + value, 0), subtotal.knownCost);
  assert.ok(estimateLowerBound(recipes, ingredients, 3, estimates) > 100);
});

test("an edited price changes just the estimated quote and whole packs are allocated once", () => {
  const database = load("estimates");
  const list = shoppingList(["apple-oats", "apple-oats"], byId, ingredients, 2);
  const original = estimatePricing(database, ingredients, {}).quote(list);
  const edited = estimatePricing(database, ingredients, { oats: 11111 }).quote(list);
  const originalOats = original.lines.find(line => line.id === "oats");
  const editedOats = edited.lines.find(line => line.id === "oats");
  assert.equal(editedOats.packs[0].count, 1);
  assert.equal(edited.knownCost, original.knownCost - originalOats.cost + 11111);
  const portions = allocateMealCosts(["apple-oats", "apple-oats"], byId, ingredients, 2, edited);
  assert.equal(portions[0] + portions[1], edited.knownCost);
  assert.ok(Math.abs(portions[0] - portions[1]) <= edited.lines.length);
  const actual = { ...edited, estimate: false, stale: 0, knownCost: edited.knownCost + 100 };
  assert.equal(bestQuote([edited, actual]), actual);
});

test("per-meal people scale groceries and costs using adjustable child portions", () => {
  const options = restoreAnswers({
    store: "magnit", adults: 2, hasChildren: true, children: [{ age: 4, percent: 50 }, { age: 12, percent: 80 }],
    meals: { breakfast: { adults: 1, children: [] }, lunch: { enabled: false }, dinner: { adults: 2, children: [0] },
      snack: { enabled: true, adults: 0, children: [1] } },
  });
  assert.deepEqual(activeMeals(options), ["breakfast", "dinner", "snack"]);
  assert.deepEqual(portionSchedule(options).slice(0, 6), [1, 2.5, 0.8, 1, 2.5, 0.8]);
  assert.equal(mealPeople(options, "dinner").people, 3);
  assert.equal(mealPeople(options, "snack").people, 1);
  const menu = ["apple-oats", "apple-oats", "apple-oats"];
  const amounts = shoppingList(menu, byId, ingredients, portionSchedule(options));
  assert.equal(amounts.find(entry => entry.id === "oats").quantity, 215);
  const estimate = estimatePricing(load("estimates"), ingredients, {});
  const quote = estimate.quote(amounts);
  const mealCosts = allocateMealCosts(menu, byId, ingredients, portionSchedule(options), quote);
  assert.equal(mealCosts.reduce((sum, cost) => sum + cost, 0), quote.knownCost);
  assert.ok(mealCosts[1] > mealCosts[0] && mealCosts[0] > mealCosts[2]);
  assert.equal(validateStep(options, 2), "");
  assert.ok(validateStep(restoreAnswers({ meals: { dinner: { adults: 0 } } }), 2));
  assert.ok(validBudget(50000.25) && validBudget(0.01));
  assert.ok(!validBudget(0) && !validBudget(-1) && !validBudget(0.009));
});

test("ingredient composition distinguishes lactose from dairy and fish from seafood", () => {
  for (const item of Object.values(ingredients)) assert.ok(item.allergens.every(key => Object.hasOwn(ALLERGENS, key)));
  const recipe = byId.get("overnight-c-a");
  assert.ok(recipe.ingredients["lactose-free-milk"]);
  const base = { equipment: [] };
  assert.equal(buildRules(restoreAnswers({ ...base, allergens: ["lactose"] }), ingredients).allows(recipe), true);
  assert.equal(buildRules(restoreAnswers({ ...base, allergens: ["dairy"] }), ingredients).allows(recipe), false);
  assert.equal(buildRules(restoreAnswers({ ...base, allergens: ["gluten"] }), ingredients).allows(recipe), false);
  assert.equal(buildRules(restoreAnswers({ ...base, allergens: ["fish"] }), ingredients).allows(byId.get("cold-dinner-b-a")), true);
  assert.equal(buildRules(restoreAnswers({ ...base, allergens: ["seafood"] }), ingredients).allows(byId.get("cold-dinner-b-a")), false);
  assert.equal(buildRules(restoreAnswers({ ...base, exclusions: ["укроп"] }), ingredients).allows(byId.get("cold-dinner-b-a")), false);
});

test("all nine appliances are used, alternate methods are isolated and replacements stay eligible", () => {
  for (const key of Object.keys(EQUIPMENT)) {
    assert.ok(recipes.some(recipe => recipe.methods.some(method => method.equipment.includes(key))), key);
  }
  const roasted = byId.get("roast-a-a");
  assert.deepEqual(compatibleMethods(roasted, ["airfryer"]).map(method => method.temperature), [185]);
  assert.deepEqual(compatibleMethods(roasted, ["oven"]).map(method => method.temperature), [200]);
  assert.deepEqual(compatibleMethods(roasted, ["stove"]), []);
  const compact = byId.get("puree-a-a");
  assert.deepEqual(compatibleMethods(compact, ["microwave"]), []);
  assert.equal(compatibleMethods(compact, ["microwave", "blender"]).length, 1);
  const answers = restoreAnswers({
    equipment: [], meals: { breakfast: { enabled: false }, lunch: { enabled: true }, dinner: { enabled: false },
      snack: { enabled: true } },
    exclusions: ["лука"], allergens: ["fish"], ratings: { "salad-b-a": 1, "salad-b-b": -1 },
  });
  const rules = plannerSettings(answers, ingredients);
  const plan = generateMenu(recipes, ingredients, rules, null, randomWithSeed(12)).menu;
  assert.equal(plan.length, 14);
  assert.equal(new Set(plan).size, 14);
  assert.ok(plan.includes("salad-b-a"));
  assert.ok(!plan.includes("salad-b-b"));
  assert.ok(plan.every(id => rules.allows(byId.get(id)) && compatibleMethods(byId.get(id), [])[0]));
  assert.ok(replacementOptions(plan, 0, recipes, ingredients, [], rules.meals, rules.allows)
    .every(rules.allows));
  assert.equal(replacementMenu(plan, 0, "soup-a-a", recipes, ingredients, [], rules.meals, rules.allows), null);
  const filters = restoreAnswers({ equipment: [], allergens: Object.keys(ALLERGENS) });
  assert.equal(generateMenu(recipes, ingredients, plannerSettings(filters, ingredients), null).menu, null);
});

test("Magnit fills gaps with separate estimates, keeps inventory and excludes conditional prices", () => {
  const list = [
    { id: "milk", ...ingredients.milk, quantity: 1300 },
    { id: "rice", ...ingredients.rice, quantity: 1200 },
    { id: "flour", ...ingredients.flour, quantity: 500 },
  ];
  const magnit = {
    id: "magnit", location: scope, status: "partial",
    offers: [
      offer({ ingredientId: "milk", unit: "ml", packSize: 800, priceKopecks: 4999 }),
      offer({ ingredientId: "milk", unit: "ml", packSize: 800, priceKopecks: 1999, terms: { kind: "conditional" } }),
      offer({ ingredientId: "rice", priceKopecks: 500, available: false }),
      offer({ ingredientId: "flour", priceKopecks: 200, terms: { kind: "conditional" } }),
    ],
  };
  const [store] = pricing({ city: "Оренбург", stores: [magnit] }, now, "magnit").quote(list);
  const estimates = estimatePricing(load("estimates"), ingredients, { rice: 10100 }).quote(list);
  const filled = fillMissingPrices(store, estimates);
  assert.equal(store.knownCost, 9998);
  assert.equal(store.missing, 2);
  assert.equal(filled.estimatedItems, 2);
  assert.equal(filled.store.id, "magnit");
  assert.ok(filled.complete);
  assert.equal(filled.lines[0], store.lines[0]);
  assert.equal(filled.lines[0].packs[0].count, 2);
  assert.equal(filled.lines[1].cost, 20200);
  assert.equal(filled.lines[1].estimate.edited, true);
  assert.equal(filled.lines[1].outOfStock, true);
  assert.equal(filled.lines[2].conditional[0].priceKopecks, 200);
  assert.equal(filled.knownCost, 9998 + 20200 + estimates.lines[2].cost);

  assert.equal(fillMissingPrices(store, null), store);
  const [milkOnly] = pricing({ city: "Оренбург", stores: [magnit] }, now, "magnit").quote(list.slice(0, 1));
  assert.equal(fillMissingPrices(milkOnly, estimates), milkOnly);
  const incomplete = fillMissingPrices(store, { ...estimates, lines: estimates.lines.slice(0, 2) });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.missing, 1);
  assert.equal(incomplete.knownCost, 30198);

  const [stale] = pricing({ city: "Оренбург", stores: [{ ...magnit, status: "stale" }] }, now, "magnit").quote(list);
  const archived = fillMissingPrices(stale, estimates);
  assert.equal(archived.stale, 1);
  assert.equal(archived.lines[0].stale, true);
  assert.equal(archived.lines[1].stale, undefined);
});

test("the calendar date selects the Monday of its week and rejects invalid dates", () => {
  assert.equal(weekForDate("2027-01-03"), "2026-12-28");
  assert.equal(weekForDate("2027-01-04"), "2027-01-04");
  assert.equal(weekForDate("2028-02-29"), "2028-02-28");
  assert.equal(weekForDate("2027-02-29"), null);
  assert.equal(weekForDate(""), null);
});

test("different families are preferred to small recipe variations, including in replacements", () => {
  const recipesForDinner = [
    ...Array.from({ length: 10 }, (_, index) => ({
      id: "variant-" + index, title: "Вариант " + index, family: "roast-poultry", meal: "dinner",
      category: "roast", mainIngredient: "chicken", sideDish: "roasted-potatoes", servingStyle: "with-side",
      ingredients: { chicken: 280, potato: 335 }, servings: 2,
    })),
    ...["handmade-pelmeni", "beef-stroganoff", "cabbage-rolls-beef", "pork-goulash-bulgur",
      "risotto-green-peas", "spaghetti-carbonara", "mackerel-country-potatoes", "grill-a-a"]
      .map(id => byId.get(id)),
  ];
  const dinnerMap = new Map(recipesForDinner.map(recipe => [recipe.id, recipe]));
  const settings = {
    meals: ["dinner"], exclusions: [], people: 2, budget: 30000,
    priority: recipe => recipe.id.startsWith("variant-") ? 1 : 0,
  };
  const plan = generateMenu(recipesForDinner, ingredients, settings, null, randomWithSeed(21)).menu;
  assert.equal(new Set(plan.map(id => familyOf(dinnerMap.get(id)))).size, 7);
  assert.ok(plan.every(id => completeDish(dinnerMap.get(id))));
  const replace = replacementOptions(plan, plan.findIndex(id => !id.startsWith("variant-")),
    recipesForDinner, ingredients, [], ["dinner"]);
  assert.ok(replace[0] && !replace[0].id.startsWith("variant-"));
  assert.ok(replace.every(completeDish));
});

test("swapping the meat in an otherwise identical tray bake leaves a similar dish", () => {
  const common = { category: "roast", sideDish: "vegetables", methods: [{ equipment: ["oven"], mode: "Запекание" }] };
  const poultry = dishProfile({ ...common, id: "poultry", mainIngredient: "chicken", ingredients: { chicken: 200, broccoli: 200 } });
  const pork = dishProfile({ ...common, id: "pork", mainIngredient: "pork", ingredients: { pork: 200, broccoli: 200 } });
  assert.ok(dishSimilarity(poultry, pork) >= SIMILAR_DISH);
  assert.ok(dishSimilarity(pork, dishProfile(byId.get("homemade-beef-pelmeni"))) < SIMILAR_DISH);
});

test("the portion cost uses only the quantities eaten from a purchased pack", () => {
  const index = new Map([["rice-dish", { ingredients: { rice: 180 }, servings: 2 }]]);
  const quote = { complete: true, lines: [{ id: "rice", cost: 10000, bought: 1000 }] };
  assert.deepEqual(mealIngredientCosts(["rice-dish", "rice-dish"], index, ingredients, [1, 2], quote), [
    { used: 900, perPortion: 900 }, { used: 1800, perPortion: 900 },
  ]);
  assert.equal(mealIngredientCosts(["rice-dish"], index, ingredients, [1], { complete: false }), null);
});

test("the old authored families still provide options when equipment restricts a full dinner", () => {
  const options = restoreAnswers({ store: "magnit", equipment: [],
    meals: { breakfast: { enabled: false }, lunch: { enabled: false } } });
  const rules = plannerSettings(options, ingredients);
  const plan = generateMenu(recipes, ingredients, rules, null, randomWithSeed(5)).menu;
  assert.equal(plan.length, 7);
  assert.ok(plan.every(id => completeDish(byId.get(id)) && rules.allows(byId.get(id))));
});

test("a three-person budget admits a week with 21 families and full meat and fish plates", () => {
  const estimates = estimatePricing(load("estimates"), ingredients, {});
  const source = { hasOffers: true, quote: list => [estimates.quote(list)] };
  const answers = restoreAnswers({ adults: 3, budget: 6500, equipment: ["stove", "oven", "blender"] });
  const rules = plannerSettings(answers, ingredients);
  const { menu } = generateMenu(recipes, ingredients, rules, source, randomWithSeed(47));
  assert.equal(new Set(menu.map(id => familyOf(byId.get(id)))).size, 21);
  const dinners = menu.map(id => byId.get(id)).filter(recipe => recipe.meal === "dinner");
  const fish = dinners.filter(recipe => recipe.category === "fish");
  assert.ok(fish.length && fish.every(recipe => recipe.servingStyle === "with-side"));
  const quote = estimates.quote(shoppingList(menu, byId, ingredients, rules.people));
  assert.ok(quote.complete && quote.knownCost <= 650000);
});
