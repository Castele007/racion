import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dishProfile, familyOf, sideFamily } from "../site/js/culinary.mjs";
import { estimatePricing } from "../site/js/estimates.mjs";
import { MENU_MODES, MIN_NEW_DISHES, menuRenewal } from "../site/js/menu-search.mjs";
import { generateMenu, mealIngredientCosts, shoppingList, validMenu } from "../site/js/planner.mjs";
import { plannerSettings, recipeAvailability, restoreAnswers } from "../site/js/questionnaire.mjs";

const data = name => JSON.parse(readFileSync(new URL("../site/data/" + name + ".json", import.meta.url), "utf8"));
const recipes = data("recipes");
const ingredients = data("ingredients");
const recipesById = new Map(recipes.map(recipe => [recipe.id, recipe]));
const estimates = estimatePricing(data("estimates"), ingredients);
const prices = { hasOffers: estimates.hasOffers, quote: list => [estimates.quote(list)] };
const answers = restoreAnswers({
  store: "magnit", adults: 1, equipment: ["stove", "oven"],
  meals: { breakfast: { enabled: false }, lunch: { enabled: false }, dinner: { enabled: true }, snack: { enabled: true } },
  favorites: ["chicken", "beef", "pork", "fish", "seafood", "soup", "salad", "pasta", "porridge"],
  exclusions: ["лук", "баклажаны", "оливки", "зелень", "укроп", "петрушка", "свёкла", "белокочанная капуста"],
});
const budgets = [3400, 5800, 10100];
const trials = 20;

function rng(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function sample(mode, budget, random, previous = [], history = [], previousBudget) {
  const rules = { ...plannerSettings({ ...answers, mode, budget }, ingredients), previousBudget };
  const { menu } = generateMenu(recipes, ingredients, rules, prices, random, previous, history);
  assert.ok(validMenu(menu, recipes, ingredients, rules.exclusions, rules.meals, rules.allows));
  const list = shoppingList(menu, recipesById, ingredients, rules.people);
  const quote = estimates.quote(list);
  assert.ok(quote.complete && quote.knownCost <= budget * 100);

  const selected = menu.map(id => recipesById.get(id));
  const products = new Set(selected.flatMap(recipe => dishProfile(recipe, rules.method(recipe)).ingredients));
  const sides = selected.map(sideFamily).filter(Boolean);
  const costs = mealIngredientCosts(menu, recipesById, ingredients, rules.people, quote);
  const used = Math.round(costs.reduce((total, cost) => total + cost.used, 0));
  assert.ok(used > 0 && used <= quote.knownCost);
  return {
    menu, cost: quote.knownCost, used, ingredients: list.length, mainIngredients: products.size,
    repeatedIngredientUses: selected.reduce((sum, recipe) => sum + Object.keys(recipe.ingredients).length, 0) - list.length,
    sides: new Set(sides).size, repeatedSides: sides.length - new Set(sides).size,
    families: new Set(selected.map(familyOf)).size,
    dinner: new Set(menu.filter((_, slot) => slot % 2 === 0)).size,
    snack: new Set(menu.filter((_, slot) => slot % 2 === 1)).size,
    changes: menuRenewal(menu, previous, recipesById, rules.meals, rules.method),
  };
}

function range(values) {
  return { min: Math.min(...values), max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length };
}

const results = [];
for (const mode of Object.keys(MENU_MODES)) {
  for (const budget of budgets) {
    const initial = Array.from({ length: trials }, (_, index) => sample(mode, budget, rng(5050 + index)));
    const updates = [];
    const random = rng(22631);
    let previous = sample(mode, budget, random).menu;
    let history = [];
    for (let index = 0; index < trials; index++) {
      const plan = sample(mode, budget, random, previous, history);
      updates.push(plan);
      history = [previous, ...history].slice(0, 8);
      previous = plan.menu;
    }
    const metrics = ["cost", "used", "ingredients", "mainIngredients", "repeatedIngredientUses",
      "sides", "repeatedSides", "families", "dinner", "snack"];
    results.push({
      mode, budget, trials, initial: Object.fromEntries(metrics.map(key => [key, range(initial.map(plan => plan[key]))])),
      updates: ["dinner", "snack"].map(meal => {
        const changes = updates.flatMap(plan => plan.changes.filter(change => change.meal === meal));
        return { meal, recipes: range(changes.map(change => change.recipes)),
          families: range(changes.map(change => change.families)),
          target: changes.filter(change => change.recipes >= MIN_NEW_DISHES).length,
          familyTarget: changes.filter(change => change.families >= MIN_NEW_DISHES).length };
      }),
      cookedAcrossTrials: new Set(initial.flatMap(plan => plan.menu)).size,
      updatedCost: range(updates.map(plan => plan.cost)),
    });
  }
}

const examples = [];
for (const budget of budgets) {
  const plan = sample("balanced", budget, rng(5050), examples.at(-1)?.menu,
    examples.slice(0, -1).reverse().map(example => example.menu), examples.at(-1)?.budget);
  examples.push({ budget, ...plan, titles: plan.menu.map(id => recipesById.get(id).title) });
}
console.log(JSON.stringify({ ingredients: Object.keys(ingredients).length,
  availability: recipeAvailability(answers, recipes, ingredients), results, examples }, null, 2));
