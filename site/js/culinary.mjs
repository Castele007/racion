export const CATEGORIES = {
  porridge: "Каши", eggs: "Блюда из яиц", curd: "Блюда из творога",
  pancakes: "Блины и оладьи", baking: "Домашняя выпечка", sandwich: "Бутерброды и тосты",
  soup: "Супы", salad: "Салаты", cutlets: "Котлеты и тефтели", gravy: "Блюда с подливой",
  pasta: "Паста и макароны", grain: "Блюда из круп", stuffed: "Фаршированные блюда",
  casserole: "Запеканки", stew: "Жаркое и рагу", dumplings: "Пельмени и вареники",
  fish: "Рыбные блюда", roast: "Запечённые блюда", steamed: "Блюда на пару",
  grill: "Блюда на гриле", smoothie: "Смузи", "cold-plate": "Холодные блюда",
  chops: "Отбивные и шницели", seafood: "Морепродукты", fruit: "Фрукты", dairy: "Молочные перекусы", dessert: "Десерты",
};

export const SIDES = {
  "mashed-potatoes": "Картофельное пюре", "boiled-potatoes": "Отварной картофель",
  "fried-potatoes": "Жареный картофель", "country-potatoes": "Картофель по-деревенски",
  "roasted-potatoes": "Запечённый картофель", "steamed-potatoes": "Картофель на пару",
  buckwheat: "Гречка", rice: "Рис", bulgur: "Булгур", couscous: "Кускус",
  barley: "Перловка", millet: "Пшено", pasta: "Макароны", spaghetti: "Спагетти",
  vegetables: "Овощной гарнир",
};

export const familyOf = recipe => recipe.family ?? recipe.id;
export const completeDish = recipe => recipe.servingStyle !== "needs-side";

const products = {
  chicken: ["chicken", "thigh", "liver"],
  beef: ["mince", "beef"],
  pork: ["pork", "bacon"],
  fish: ["pollock", "mackerel", "tuna"],
};

export function productOf(recipe) {
  const id = recipe.mainIngredient;
  return Object.keys(products).find(group => products[group].includes(id)) ?? id;
}

export function sideFamily(recipe) {
  if (recipe.sideDish?.endsWith("-potatoes")) return "potato";
  return recipe.sideDish === "spaghetti" ? "pasta" : recipe.sideDish;
}

const seasonings = new Set(["oil", "sugar", "cinnamon", "paprika", "soda", "baking-powder", "soy"]);

function technique(method, category) {
  if (!method) return "";
  const { equipment } = method;
  if (!equipment.length) return "cold";
  const appliance = equipment.find(item => item !== "stove" && item !== "blender");
  if (appliance) return appliance;
  const mode = method.mode.toLowerCase();
  if (/туш|томл/u.test(mode)) return "braise";
  if (/жар/u.test(mode) || ["cutlets", "chops", "pancakes", "eggs"].includes(category)) return "pan";
  return "boil";
}

export function dishProfile(recipe, method = recipe.methods?.[0]) {
  const ingredients = Object.keys(recipe.ingredients).filter(id => !seasonings.has(id));
  return {
    recipe, family: familyOf(recipe), primary: productOf(recipe), side: sideFamily(recipe),
    category: recipe.category, method: technique(method, recipe.category), ingredients,
    secondary: ingredients.filter(id => id !== recipe.mainIngredient),
  };
}

function ingredientOverlap(a, b) {
  const shared = a.filter(id => b.includes(id)).length;
  return shared / (a.length + b.length - shared || 1);
}

const same = (a, b) => Number(Boolean(a && a === b));
export const SIMILAR_DISH = 0.58;

export function dishSimilarity(a, b) {
  if (a.family === b.family) return 1;
  return 0.46 * ingredientOverlap(a.ingredients, b.ingredients) +
    0.16 * ingredientOverlap(a.secondary, b.secondary) +
    0.13 * same(a.category, b.category) + 0.13 * same(a.method, b.method) +
    0.1 * same(a.side, b.side) + 0.06 * same(a.primary, b.primary);
}
