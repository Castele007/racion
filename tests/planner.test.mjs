import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { allocateMealCosts, estimateLowerBound, estimatePricing, estimateRows } from "../site/js/estimates.mjs";
import {
  MEALS, STORES, bestQuote, cheapestPacks, eligibleRecipes, exclusionIds, generateMenu,
  pricing, purchasable, recipeAmount, replacementMenu, replacementOptions, shoppingList,
  starterMenu, validMenu, weekStart,
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

test("public cookbook has at least 100 complete, unique recipes and working assets", () => {
  assert.equal(byId.size, recipes.length);
  assert.equal(new Set(recipes.map(recipe => recipe.title)).size, recipes.length);
  assert.ok(recipes.length >= 100);
  for (const meal of MEALS) assert.ok(recipes.filter(recipe => recipe.meal === meal).length >= 7);
  const imageHashes = new Set();
  for (const recipe of recipes) {
    assert.ok(recipe.title && MEALS.includes(recipe.meal) && /^[a-z-]+$/.test(recipe.id));
    assert.ok(recipe.minutes >= 10 && recipe.servings > 0);
    assert.ok(recipe.instructions.length >= 3 && recipe.instructions.every(step => step.length >= 25));
    for (const [id, count] of Object.entries(recipe.ingredients)) {
      assert.ok(Object.hasOwn(ingredients, id) && Number.isInteger(count) && count > 0);
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
    { ...settings, exclusions: Object.values(ingredients).map(item => item.name).slice(0, 30) }, null);
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
