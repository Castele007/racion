export const CATEGORIES = {
  porridge: "Каши", eggs: "Блюда из яиц", curd: "Блюда из творога",
  pancakes: "Блины и оладьи", baking: "Домашняя выпечка", sandwich: "Бутерброды и тосты",
  soup: "Супы", salad: "Салаты", cutlets: "Котлеты и тефтели", gravy: "Блюда с подливой",
  pasta: "Паста и макароны", grain: "Блюда из круп", stuffed: "Фаршированные блюда",
  casserole: "Запеканки", stew: "Жаркое и рагу", dumplings: "Пельмени и вареники",
  fish: "Рыбные блюда", roast: "Запечённые блюда", steamed: "Блюда на пару",
  grill: "Блюда на гриле", smoothie: "Смузи", "cold-plate": "Холодные блюда",
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
