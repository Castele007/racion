import { DEFAULT_SETTINGS, STORES, cleanExclusions, exclusionIds } from "./planner.mjs";
import { completeDish, familyOf } from "./culinary.mjs";
import { DEFAULT_MODE, MENU_MODES } from "./menu-search.mjs";

export const MEALS = ["breakfast", "lunch", "dinner", "snack"];
export const MEAL_LABELS = { breakfast: "Завтрак", lunch: "Обед", dinner: "Ужин", snack: "Перекус" };
export const EQUIPMENT = {
  stove: "Плита", oven: "Духовка", microwave: "Микроволновка", multicooker: "Мультиварка",
  airfryer: "Аэрогриль", blender: "Блендер", steamer: "Пароварка",
  "electric-grill": "Электрогриль", kettle: "Электрочайник",
};
export const FAVORITES = {
  chicken: "Курица", beef: "Говядина", pork: "Свинина", fish: "Рыба", seafood: "Морепродукты",
  soup: "Супы", salad: "Салаты", pasta: "Паста", porridge: "Каши", vegetables: "Овощные блюда",
};
export const ALLERGENS = {
  nuts: "Орехи", peanuts: "Арахис", gluten: "Глютен", dairy: "Молочные продукты", lactose: "Лактоза",
  eggs: "Яйца", fish: "Рыба", seafood: "Морепродукты", honey: "Мёд", soy: "Соя", citrus: "Цитрусовые", sesame: "Кунжут",
};
export const COMMON_EXCLUSIONS = [
  "Лук", "Чеснок", "Грибы", "Оливки", "Баклажаны", "Кинза", "Зелень", "Острое", "Сахар", "Свинина",
];
export const STEP_NAMES = ["Магазин", "Семья", "Приёмы пищи", "Бюджет", "Предпочтения", "Техника"];
export const ADULT_LIMIT = 20;
export const CHILD_LIMIT = 12;
export const BUDGET_MAX = Math.floor(Number.MAX_SAFE_INTEGER / 100);
const between = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const selected = (value, choices) => [...new Set(Array.isArray(value) ?
  value.filter(key => typeof key === "string" && Object.hasOwn(choices, key)) : [])];

export function childDefault(age) {
  const percent = age <= 3 ? 50 : age <= 7 ? 65 : age <= 12 ? 80 : 95;
  return { age, percent };
}

export function validBudget(value) {
  return Number.isFinite(value) && value >= 0.01 && value <= BUDGET_MAX &&
    Math.abs(value * 100 - Math.round(value * 100)) < 0.00001;
}

export function restoreAnswers(input = {}, legacy = {}) {
  input = input ?? {};
  const adults = between(input.adults, 1, ADULT_LIMIT) ? input.adults :
    between(legacy.people, 1, ADULT_LIMIT) ? legacy.people : DEFAULT_SETTINGS.people;
  const children = (Array.isArray(input.children) ? input.children : []).slice(0, CHILD_LIMIT).map(child => {
    const age = between(child?.age, 1, 17) ? child.age : 6;
    return { age, percent: between(child?.percent, 10, 150) ? child.percent : childDefault(age).percent };
  });
  const hasChildren = input.hasChildren === true;
  if (hasChildren && children.length === 0) children.push(childDefault(6));
  const meals = Object.fromEntries(MEALS.map(meal => {
    const option = input.meals?.[meal];
    const childIndices = Array.isArray(option?.children) ?
      [...new Set(option.children.filter(index => between(index, 0, children.length - 1)))] : null;
    return [meal, {
      enabled: typeof option?.enabled === "boolean" ? option.enabled : meal !== "snack",
      adults: between(option?.adults, 0, ADULT_LIMIT) ? Math.min(adults, option.adults) : null,
      children: childIndices,
    }];
  }));
  const ratings = Object.fromEntries(Object.entries(input.ratings ?? {})
    .filter(([id, rating]) => /^[a-z0-9-]{1,80}$/.test(id) && (rating === 1 || rating === -1)));
  return {
    store: STORES.some(store => store.id === input.store) ? input.store : null,
    adults, hasChildren, children, meals,
    budget: validBudget(input.budget) ? input.budget : validBudget(legacy.budget) ? legacy.budget : DEFAULT_SETTINGS.budget,
    mode: Object.hasOwn(MENU_MODES, input.mode) ? input.mode : DEFAULT_MODE,
    favorites: selected(input.favorites, FAVORITES),
    allergens: selected(input.allergens, ALLERGENS),
    exclusions: cleanExclusions(input.exclusions ?? legacy.exclusions),
    equipment: Array.isArray(input.equipment) ? selected(input.equipment, EQUIPMENT) : ["stove"],
    ratings,
  };
}

export function household(answers) {
  return answers.adults + (answers.hasChildren ? answers.children.length : 0);
}

export function mealPeople(answers, meal) {
  const option = answers.meals[meal];
  const adults = option.adults ?? answers.adults;
  const children = answers.hasChildren ? answers.children.filter((_, index) =>
    option.children === null || option.children.includes(index)) : [];
  return { adults, children, people: adults + children.length,
    portions: adults + children.reduce((sum, child) => sum + child.percent, 0) / 100 };
}

export function activeMeals(answers) {
  return MEALS.filter(meal => answers.meals[meal].enabled);
}

export function portionSchedule(answers) {
  const day = activeMeals(answers).map(meal => mealPeople(answers, meal).portions);
  return Array.from({ length: 7 }, () => day).flat();
}

export function compatibleMethods(recipe, equipment) {
  return recipe.methods.filter(method => method.equipment.every(device => equipment.includes(device)));
}

export function dietFilter(answers, ingredients) {
  const excluded = exclusionIds(ingredients, answers.exclusions);
  const restricted = new Set(answers.allergens);
  for (const [id, item] of Object.entries(ingredients)) {
    // Unknown or undeclared compositions are conservatively filtered when a restriction is set.
    if (restricted.size && (!Array.isArray(item.allergens) || item.allergens.some(key => restricted.has(key)))) {
      excluded.add(id);
    }
  }
  return recipe => !Object.keys(recipe.ingredients).some(id => excluded.has(id));
}

export function buildRules(answers, ingredients) {
  const dietAllows = dietFilter(answers, ingredients);
  const method = recipe => compatibleMethods(recipe, answers.equipment)[0];
  return {
    allows: recipe => dietAllows(recipe) && Boolean(method(recipe)),
    method,
    priority: recipe => (answers.ratings[recipe.id] ?? 0) * 4 +
      (recipe.tags.some(tag => answers.favorites.includes(tag)) ? 2 : 0),
  };
}

export function recipeAvailability(answers, recipes, ingredients) {
  const allergies = dietFilter({ ...answers, exclusions: [] }, ingredients);
  const exclusions = dietFilter({ ...answers, allergens: [] }, ingredients);
  return MEALS.map(meal => {
    const all = recipes.filter(recipe => recipe.meal === meal);
    const usable = all.filter(completeDish);
    const afterAllergies = usable.filter(allergies);
    const afterExclusions = afterAllergies.filter(exclusions);
    const eligible = afterExclusions.filter(recipe => compatibleMethods(recipe, answers.equipment).length > 0);
    return {
      meal, total: all.length, families: new Set(all.map(familyOf)).size, usable: usable.length,
      allergyLoss: usable.length - afterAllergies.length,
      exclusionLoss: afterAllergies.length - afterExclusions.length,
      equipmentLoss: afterExclusions.length - eligible.length,
      eligible: eligible.length, eligibleFamilies: new Set(eligible.map(familyOf)).size,
    };
  });
}

export function plannerSettings(answers, ingredients) {
  const rules = buildRules(answers, ingredients);
  return {
    meals: activeMeals(answers), people: portionSchedule(answers), budget: answers.budget, mode: answers.mode,
    exclusions: answers.exclusions, ...rules,
  };
}

export function validateStep(answers, step) {
  if (step === 0 && !answers.store) return "Выберите магазин в Оренбурге.";
  if (step === 2) {
    const meals = activeMeals(answers);
    if (!meals.length) return "Выберите хотя бы один приём пищи.";
    const empty = meals.find(meal => !mealPeople(answers, meal).people);
    if (empty) return "Добавьте хотя бы одного участника: " + MEAL_LABELS[empty].toLowerCase() + ".";
  }
  if (step === 3 && !validBudget(answers.budget)) return "Введите положительную сумму в рублях.";
  return "";
}
