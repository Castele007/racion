import {
  DAYS, STORES, MAX_PRICE_AGE, bestQuote, dateAt, generateMenu, isWeekStart, pricing, recipeAmount,
  replacementMenu, replacementOptions, shoppingList, validMenu, weekForDate, weekStart,
} from "./planner.mjs";
import {
  ESTIMATE_STORE, allocateMealCosts, cleanOverrides, estimateLowerBound, estimatePricing, estimateRows, fillMissingPrices,
} from "./estimates.mjs";
import {
  STEP_NAMES, MEAL_LABELS, ALLERGENS, FAVORITES, EQUIPMENT, activeMeals, compatibleMethods, household, mealPeople,
  plannerSettings, portionSchedule, restoreAnswers, validateStep,
} from "./questionnaire.mjs";
import { CATEGORIES, SIDES, familyOf } from "./culinary.mjs";
import { mountWizard } from "./wizard.mjs";

const $ = id => document.getElementById(id);
const storageKey = "racion.v1";
const views = { setup: "Настройка меню", menu: "Планировщик питания", shopping: "Список покупок", stores: "Магазины и цены", settings: "Настройки рациона" };
const mealIcons = { breakfast: "sun", lunch: "bowl", dinner: "moon", snack: "leaf" };
const dateShort = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
const dateWithYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const fullDay = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const updatedFormat = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short", timeStyle: "short", timeZone: "Asia/Yekaterinburg",
});
const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
const currency = new Intl.NumberFormat("ru-RU", {
  style: "currency", currency: "RUB", minimumFractionDigits: 0, maximumFractionDigits: 2,
});
const peoplePlural = new Intl.PluralRules("ru");
const units = { g: "г", ml: "мл", pcs: "шт." };
const channels = { pickup: "Самовывоз", "in-store": "Покупка в магазине", delivery: "Онлайн-заказ" };

let ingredients, recipes, recipesById, state, basket, quotes;
let magnitQuote;
let wizard;
let currentView;
let activeDialogIndex = null;
let loadedCatalog = null;
let estimateDatabase = null;
let planningQuote = null;
let mealCosts = null;

const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => entities[char]);
const icon = name => '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
const money = kopecks => currency.format(kopecks / 100);
const amount = (value, unit) => {
  if (value >= 1000 && (unit === "g" || unit === "ml")) {
    return number.format(value / 1000) + " " + (unit === "g" ? "кг" : "л");
  }
  return number.format(value) + " " + units[unit];
};

function peopleText(value) {
  return value + " " + (peoplePlural.select(value) === "few" ? "человека" : "человек");
}

function countText(value, forms) {
  return value + " " + (forms[peoplePlural.select(value)] ?? forms.many);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function timestamp(value) {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? updatedFormat.format(millis) : null;
}

function sourceLink(url, text, cssClass = "text-link") {
  const safe = safeUrl(url);
  return safe ? '<a class="' + cssClass + '" href="' + escapeHtml(safe) +
    '" target="_blank" rel="noopener noreferrer">' + escapeHtml(text) + '</a>' : escapeHtml(text);
}

async function data(name) {
  const response = await fetch(new URL("../data/" + name + ".json", import.meta.url), { cache: "no-cache" });
  if (!response.ok) throw new Error(response.status + " " + name);
  return response.json();
}

function readState() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch { /* First visit or storage is unavailable. */ }
  const draft = restoreAnswers(saved?.draft, saved?.settings);
  const answers = saved?.answers ? restoreAnswers(saved.answers) : null;
  const rules = answers ? plannerSettings(answers, ingredients) : null;
  const menu = rules && !validateStep(answers, 0) && !validateStep(answers, 2) &&
    validMenu(saved?.menu, recipes, ingredients, [], rules.meals, rules.allows) ? saved.menu : null;
  return {
    answers: menu ? answers : null, draft, menu,
    step: Number.isInteger(saved?.step) && saved.step >= 0 && saved.step < STEP_NAMES.length ? saved.step : 0,
    wizardMode: menu && (saved?.wizardMode === "parameter" || saved?.wizardMode === "restart") ? saved.wizardMode :
      menu && saved?.editing ? "parameter" : "initial",
    settingsDraft: menu && saved?.settingsDraft?.answers && isWeekStart(saved.settingsDraft.start) ?
      { answers: restoreAnswers(saved.settingsDraft.answers), start: saved.settingsDraft.start } : null,
    searched: Boolean(menu && saved?.searched),
    start: isWeekStart(saved?.start) ? saved.start : weekStart(),
    day: Number.isInteger(saved?.day) && saved.day >= 0 && saved.day < 7 ? saved.day : 0,
    store: [...STORES, ESTIMATE_STORE].some(store => store.id === saved?.store) ? saved.store : null,
    overrides: cleanOverrides(saved?.overrides, ingredients),
    checked: new Set(Array.isArray(saved?.checked) ? saved.checked.filter(id => Object.hasOwn(ingredients, id)) : []),
  };
}

function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ ...state, checked: [...state.checked] }));
  } catch { /* The planner still works until this tab closes. */ }
}

function announce(message) {
  $("live-status").textContent = message;
}

function tabId(index) { return "day-tab-" + index; }

function renderTabs() {
  $("menu-dates").textContent = dateWithYear.formatRange(dateAt(state.start, 0), dateAt(state.start, 6)) +
    " · " + peopleText(household(state.answers)) +
    " · Разных семейств блюд: " + new Set(state.menu.map(id => familyOf(recipesById.get(id)))).size;
  $("week-tabs").innerHTML = DAYS.map((day, index) => {
    const date = dateAt(state.start, index);
    const selected = index === state.day;
    return '<button class="day-tab" id="' + tabId(index) + '" type="button" role="tab" data-day="' +
      index + '" aria-selected="' + selected + '" tabindex="' + (selected ? 0 : -1) +
      '" aria-controls="day-menu" aria-label="' + fullDay.format(date) + '"><span>' + day +
      '</span><time datetime="' + date.toISOString().slice(0, 10) + '">' + dateShort.format(date) + '</time></button>';
  }).join("");
  $("day-menu").setAttribute("aria-labelledby", tabId(state.day));
}

function quoteMoney(value, quote) {
  return (quote?.estimate || quote?.stale ? "≈ " : "") + money(value);
}

function renderDay() {
  const dayCost = $("day-cost");
  const meals = activeMeals(state.answers);
  const dayStart = state.day * meals.length;
  dayCost.hidden = !mealCosts;
  dayCost.textContent = mealCosts ? "Итого за день " + quoteMoney(
    mealCosts.slice(dayStart, dayStart + meals.length).reduce((sum, cost) => sum + cost, 0), planningQuote
  ) : "";
  $("day-menu").style.setProperty("--meal-count", meals.length);
  $("day-menu").innerHTML = meals.map((meal, slot) => {
    const index = dayStart + slot;
    const recipe = recipesById.get(state.menu[index]);
    const method = compatibleMethods(recipe, state.answers.equipment)[0];
    const participants = mealPeople(state.answers, meal);
    const image = recipe.image && /^[a-z-]+$/.test(recipe.image) ?
      '<img class="meal-photo" alt="" src="./assets/' + recipe.image + '.webp" width="400" height="186">' :
      '<div class="meal-photo meal-placeholder" aria-hidden="true">' + icon(mealIcons[meal]) + '</div>';
    return '<article class="meal-card">' + image + '<div class="meal-body"><div class="meal-meta">' +
      '<span class="meal-tag ' + meal + '">' + icon(mealIcons[meal]) + MEAL_LABELS[meal] + '</span>' +
      '<span class="meal-time">' + icon("clock") + method.minutes + ' мин</span></div>' +
      '<h3>' + escapeHtml(recipe.title) + '</h3><p class="meal-detail">' +
      peopleText(participants.people) + ' · ' + number.format(participants.portions) + ' порц. · ' +
      escapeHtml(equipmentText(method)) + '</p>' +
      (recipe.sideDish ? '<p class="meal-side">Гарнир: ' + escapeHtml(SIDES[recipe.sideDish]) + '</p>' : '') +
      (mealCosts ? '<p class="meal-cost">' + quoteMoney(mealCosts[index], planningQuote) + '</p>' : '') +
      '<div class="meal-actions">' +
      '<button class="button recipe-button" type="button" data-recipe="' + index + '">Рецепт</button>' +
      '<button class="button outline" type="button" data-replace="' + index + '">' +
      icon("refresh") + 'Заменить</button></div></div></article>';
  }).join("");
}

function selectDay(day, focus) {
  state.day = day;
  renderTabs();
  renderDay();
  if (focus) $(tabId(day)).focus();
  persist();
}

function summaryCard(title, value, note = "", style = "") {
  return '<div class="summary-card ' + style + '"><small>' + title + '</small><strong>' + value +
    '</strong>' + (note ? "<span>" + note + "</span>" : "") + "</div>";
}

function budgetSummary(quote, menuView = false) {
  const budget = Math.round(state.answers.budget * 100);
  const remainder = quote?.complete ? budget - quote.knownCost : null;
  const incomplete = !quote?.complete;
  const historical = Boolean(quote?.stale);
  const estimated = Boolean(quote?.estimatedItems);
  const mixedPrices = estimated && quote.estimatedItems < quote.lines.length - quote.missing;
  const basketTitle = incomplete && quote?.knownCost != null ? "Часть корзины" : "Вся корзина";
  const remainderTitle = remainder !== null && remainder < 0 ? "Сверх бюджета" : "Остаток бюджета";
  let note = "";
  if (quote?.complete) {
    const source = mixedPrices ? "Магнит и ориентиры по Оренбургу" :
      estimated ? "Ориентиры по Оренбургу" : escapeHtml(quote.store.name);
    note = "Корзина целых упаковок · " + source +
      (historical ? " · есть архивные цены" : "");
  } else if (menuView) {
    note = '<a class="text-link" href="#stores">Проверить магазины и цены</a>';
  } else if (quote?.knownCost != null) {
    note = "Известная сумма за часть списка. Для остальных продуктов нет подходящих цен.";
  }
  const warning = menuView && remainder < 0 ? overBudgetNotice(quote, budget) : "";
  const details = menuView && quote?.complete ?
    '<p class="summary-note">Стоимость целых упаковок распределена по блюдам пропорционально их долям в покупках.</p>' : "";
  return '<div class="summary-grid">' + summaryCard("Бюджет", money(budget), "На неделю") +
    summaryCard(basketTitle, quote?.knownCost == null ? "—" : quoteMoney(quote.knownCost, quote),
      mixedPrices ? "Ориентиры для " + quote.estimatedItems + " из " + quote.lines.length + " позиций" :
        estimated ? "Расчёт по ориентирам" : historical ? "Есть устаревшие цены" :
        (incomplete ? "Нет полной оценки" : "Целые упаковки")) +
    summaryCard(remainderTitle, remainder === null ? "—" : quoteMoney(Math.abs(remainder), quote),
      remainder === null ? "Нужна цена всей корзины" : (historical || estimated ? "Ориентировочно" : ""),
      remainder === null ? "" : (remainder < 0 ? "over" : "good")) + "</div>" +
    (note ? '<p class="summary-note">' + note + '</p>' : "") + details + warning;
}

function overBudgetNotice(quote, budget) {
  const rules = plannerSettings(state.answers, ingredients);
  const source = planningPrices(state.overrides, state.answers.store);
  const bound = priceLowerBound(quote, rules, source, state.answers.store);
  const intro = bound !== null && bound > budget
    ? "По этим ориентирам уложиться в бюджет невозможно даже без округления до упаковок."
    : state.searched ? "В пределах бюджета меню подобрать не удалось. Показан найденный вариант с превышением."
      : "Текущее меню превышает бюджет. Попробуйте подобрать меню заново или изменить настройки.";
  return '<div id="budget-warning">' + message(intro, true) + '</div>';
}

function estimateReference(row) {
  const ref = row.reference;
  if (!ref) return "";
  return sourceLink(ref.url, ref.name) + " · " + escapeHtml(ref.observedOn) + " · " + escapeHtml(row.method);
}

function selectedQuote() {
  const selected = quotes.find(quote => quote.store.id === state.store);
  if (selected?.store.id === "magnit") return magnitQuote;
  if (!selected && !planningQuote && state.answers.store === "magnit") return magnitQuote;
  return selected ?? planningQuote ??
    [...quotes].sort((a, b) => a.missing - b.missing || a.stale - b.stale)[0];
}

function updateShoppingCount() {
  const checked = basket.filter(item => state.checked.has(item.id)).length;
  $("shopping-subtitle").textContent = peopleText(household(state.answers)) + " · " +
    countText(basket.length, { one: "продукт", few: "продукта", many: "продуктов" }) +
    (checked ? " · отмечено " + checked : "");
  $("clear-checks").disabled = checked === 0;
}

function offerDetails(offer, item, count) {
  const checkedAt = timestamp(offer.updatedAt);
  const note = offer.terms?.note;
  const title = sourceLink(offer.sourceUrl, offer.name);
  return '<li>' + title + ' · ' + amount(offer.packSize, item.unit) + ' · ' +
    (count ? count + ' × ' : '') + money(offer.priceKopecks) +
    (offer.terms?.kind === "public" ? ' · Акция до ' + (timestamp(offer.terms.endsAt) ?? "уточнения") : '') +
    (note ? ' · ' + escapeHtml(note) : '') + (checkedAt ? ' · ' + checkedAt : '') + '</li>';
}

function shoppingRow(item) {
  const checked = state.checked.has(item.id);
  let packs = item.outOfStock ? "Нет в наличии" : "Нет цены";
  if (item.hasPrice) {
    packs = item.packs.map(({ count, offer }) => count + " × " + amount(offer.packSize, item.unit) +
      " по " + quoteMoney(offer.priceKopecks, item)).join(" + ");
    if (item.estimate) {
      packs += " · Ориентир" + (item.outOfStock ? " · Нет в наличии в Магните" : "");
    } else if (item.stale) packs += " · Архивная цена";
  }
  const products = item.estimate ? ["<li>" + (item.estimate.edited ? "Ваша цена · Исходный ориентир: " : "") +
    estimateReference(item.estimate) + "</li>"] :
    (item.packs ?? []).map(({ offer, count }) => offerDetails(offer, item, count));
  const conditional = item.conditional.map(offer => offerDetails(offer, item, 0));
  return '<div class="shopping-row' + (checked ? ' checked' : '') + '"><label><input type="checkbox" data-item="' +
    item.id + '"' + (checked ? " checked" : "") + '><span>' + escapeHtml(item.name) + '<small>Нужно ' +
    amount(item.quantity, item.unit) + '</small></span></label><div class="pack-details">' + packs +
    (products.length ? '<details><summary>' + (item.estimate ? "Источник ориентира" : "Товары и источник") +
      '</summary><ul>' + products.join("") + '</ul></details>' : '') +
    (conditional.length ? '<details><summary>Акции с условиями</summary><ul>' + conditional.join("") + '</ul></details>' : '') +
    '</div><div class="shopping-price">' + (item.hasPrice ? quoteMoney(item.cost, item) : "—") + '</div></div>';
}

function renderShopping() {
  const selected = selectedQuote();
  updateShoppingCount();
  $("shopping-summary").innerHTML = budgetSummary(selected);
  $("shopping-store").innerHTML = quotes.map(quote => '<option value="' + quote.store.id + '"' +
    (quote.store.id === selected.store.id ? ' selected' : '') + '>' + escapeHtml(quote.store.name) +
    (quote.store.id === "magnit" && magnitQuote.estimatedItems ? " · с ориентирами" : "") + '</option>').join("");
  const groups = new Map();
  for (const item of selected.lines) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  $("shopping-list").innerHTML = [...groups].map(([category, items]) =>
    '<section class="shopping-group"><h2>' + escapeHtml(category) + '</h2>' +
    items.map(shoppingRow).join("") + '</section>').join("");
}

function message(text, warn = false) {
  return '<p class="message' + (warn ? ' warn' : '') + '">' + icon("info") + '<span>' + text + '</span></p>';
}

function storeStatus(store, now) {
  if (!store.updatedAt || !store.offers?.length) return ["unavailable", "Источник недоступен"];
  if (store.status === "stale" || now - Date.parse(store.updatedAt) >= MAX_PRICE_AGE) return ["stale", "Цены устарели"];
  if (store.status === "partial") return ["partial", "Частично обновлено"];
  return ["fresh", "Каталог обновлён"];
}

function renderStores() {
  const now = Date.now();
  const storeQuotes = quotes.filter(quote => !quote.estimate);
  const best = bestQuote(storeQuotes);
  const headline = best ?
    (best.stale ? "Полная корзина по последним сохранённым ценам: " : "Самая низкая цена полной актуальной корзины: ") +
      '<strong>' + escapeHtml(best.store.name) + ' · ' + money(best.knownCost) + '</strong>.' :
    "Полных цен магазинов для этой корзины пока нет. Для планирования доступны отдельные ориентировочные цены.";
  $("stores-summary").innerHTML = message(headline, !best || Boolean(best.stale));
  $("store-comparison").innerHTML = storeQuotes.map(quote => {
    const { store } = quote;
    const [status, label] = storeStatus(store, now);
    const place = store.location;
    const location = place ? [channels[place.channel], place.address].filter(Boolean).join(" · ") : "";
    const updated = timestamp(store.updatedAt);
    const checkedAt = timestamp(store.checkedAt);
    const error = store.error?.message ?? (!updated ? "Файл цен пока недоступен." : "");
    const coverage = quote.complete ? "Весь список посчитан" :
      quote.missing === quote.lines.length ? "Для этого списка цен нет" :
        "Часть корзины · " + quote.missing + " из " + quote.lines.length + " позиций без цены";
    return '<article class="store-card"><div class="store-title"><span class="store-mark ' + store.id +
      '" aria-hidden="true">' + store.mark + '</span><h2>' + escapeHtml(store.name) + '</h2></div>' +
      '<span class="store-status ' + status + '">' + label + '</span>' +
      '<div class="store-cost">' + (quote.knownCost == null ? "—" : money(quote.knownCost)) + '</div>' +
      '<p>' + coverage + (quote.stale ? " · есть устаревшие цены" : "") + '</p>' +
      (location ? '<p>' + escapeHtml(location) + '</p>' : '') +
      (updated ? '<p>Цены получены ' + updated + '</p>' : '') +
      (checkedAt && (!updated || checkedAt !== updated) ? '<p>Проверка ' + checkedAt + '</p>' : '') +
      (error ? '<p>' + escapeHtml(error) + '</p>' : '') +
      '<div class="store-actions">' + sourceLink(store.url, "Каталог ↗") +
      '<a class="button outline" href="#shopping" data-store="' + store.id + '">К списку</a></div></article>';
  }).join("");
}

function planningPrices(overrides, storeId) {
  const actual = pricing(loadedCatalog, Date.now(), storeId);
  const estimates = estimatePricing(estimateDatabase, ingredients, overrides);
  return {
    estimates,
    hasStoreOffers: actual.hasOffers,
    hasOffers: actual.hasOffers || estimates.hasOffers,
    quote(list) {
      const stores = actual.quote(list);
      if (!estimates.hasOffers) return stores;
      const estimate = estimates.quote(list);
      if (storeId === "magnit") return [fillMissingPrices(stores[0], estimate)];
      return [...stores, estimate];
    },
  };
}

function priceLowerBound(quote, rules, source, storeId) {
  // An estimate-only lower bound can be too high when a candidate could use
  // a cheaper confirmed price in Magnit.
  if (!quote?.estimate || (storeId === "magnit" && source.hasStoreOffers)) return null;
  return estimateLowerBound(recipes.filter(rules.allows), ingredients, rules.people, source.estimates, rules.meals);
}

function assessBudget(answers) {
  const source = planningPrices(state.overrides, answers.store);
  const rules = plannerSettings(answers, ingredients);
  // Find one inexpensive, reproducible example for this setup. It is a
  // feasible upper bound and is reused while the slider moves.
  let seed = 47;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const result = generateMenu(recipes, ingredients, { ...rules, budget: 0 }, source, random);
  if (!result.menu) return { message: "Для выбранных приёмов пищи пока нет подходящих рецептов." };
  const quote = bestQuote(source.quote(shoppingList(result.menu, recipesById, ingredients, rules.people)));
  const bound = priceLowerBound(quote, rules, source, answers.store);
  return { quote, bound };
}

function renderEstimateEditor() {
  const rows = estimateRows(estimateDatabase, ingredients, state.overrides);
  $("estimate-editor").hidden = !rows.length;
  $("estimate-rows").innerHTML = rows.sort((a, b) => a.name.localeCompare(b.name, "ru")).map(row =>
    '<div class="estimate-row"><div><label for="estimate-' + row.id + '">' + escapeHtml(row.name) +
    ' · ' + amount(row.packSize, row.unit) + '</label><small>' + estimateReference(row) +
    '</small></div><input id="estimate-' + row.id + '" data-estimate="' + row.id +
    '" data-default="' + row.originalPrice + '" type="number" inputmode="decimal" min="0.01" max="1000000" ' +
    'step="0.01" required value="' + row.priceKopecks / 100 + '"></div>').join("");
}

function refreshCalculations(prior) {
  const portions = portionSchedule(state.answers);
  basket = shoppingList(state.menu, recipesById, ingredients, portions);
  if (prior) syncChecked(prior);
  quotes = planningPrices(state.overrides).quote(basket);
  magnitQuote = fillMissingPrices(quotes.find(quote => quote.store.id === "magnit"),
    quotes.find(quote => quote.store.id === ESTIMATE_STORE.id));
  planningQuote = state.answers.store === "magnit"
    ? bestQuote([magnitQuote])
    : bestQuote(quotes.filter(quote => quote.estimate || quote.store.id === state.answers.store));
  mealCosts = allocateMealCosts(state.menu, recipesById, ingredients, portions, planningQuote);
  $("budget-summary").innerHTML = budgetSummary(planningQuote, true);
  const selectedStore = STORES.find(store => store.id === state.answers.store);
  const mixedPrices = planningQuote?.estimate && planningQuote.estimatedItems < planningQuote.lines.length;
  const source = mixedPrices ? "Цены магазина и ориентиры" : planningQuote?.estimate ?
    "Ориентировочные цены" : planningQuote?.stale ?
    "Архивные цены" : planningQuote ? "Подтверждённые цены" : "Полной цены корзины нет";
  const updated = planningQuote && !planningQuote.estimate ? timestamp(planningQuote.store.updatedAt) : null;
  $("result-store").textContent = selectedStore.name + " · Оренбург · " + source + (updated ? " · " + updated : "");
  renderDay();
  const activeStores = quotes.filter(quote => storeStatus(quote.store, Date.now())[0] === "fresh").length;
  $("sidebar-prices").textContent = activeStores ?
    countText(activeStores, { one: "магазин с ценами", few: "магазина с ценами", many: "магазинов с ценами" }) :
    "Нет актуальных каталогов";
  renderShopping();
  renderStores();
}

function equipmentText(method) {
  return method.equipment.length ? method.equipment.map(key => EQUIPMENT[key]).join(", ") : "Без техники";
}

function renderMethod(method) {
  return '<p class="method-note">' + escapeHtml(equipmentText(method) + " · " + method.minutes + " мин · " +
    method.mode + (method.temperature ? " · " + method.temperature + " °C" : "")) + '</p><ol class="steps">' +
    method.instructions.map(step => '<li>' + escapeHtml(step) + '</li>').join("") + "</ol>";
}

function recipeDialog(index) {
  const recipe = recipesById.get(state.menu[index]);
  const people = mealPeople(state.answers, recipe.meal);
  const [method, ...alternatives] = compatibleMethods(recipe, state.answers.equipment);
  $("dialog-kicker").textContent = MEAL_LABELS[recipe.meal] + " · " + method.minutes + " мин";
  $("dialog-title").textContent = recipe.title;
  const composition = [CATEGORIES[recipe.category], "Основное: " + ingredients[recipe.mainIngredient].name,
    recipe.sideDish ? "Гарнир: " + SIDES[recipe.sideDish] : recipe.servingStyle === "needs-side" ?
      "Блюдо требует гарнира" : "Самостоятельное блюдо"];
  $("dialog-content").innerHTML = '<p class="method-note">' + escapeHtml(composition.join(" · ")) +
    '</p><section class="dialog-section"><h3>Ингредиенты · ' +
    peopleText(people.people) + " · " + number.format(people.portions) + ' порц.</h3><ul class="ingredient-list">' +
    Object.keys(recipe.ingredients).map(id => {
      const item = ingredients[id];
      return '<li><span>' + escapeHtml(item.name) + '</span><span>' +
        amount(recipeAmount(recipe, id, people.portions, item.unit), item.unit) + '</span></li>';
    }).join("") + '</ul></section><section class="dialog-section"><h3>Приготовление</h3>' + renderMethod(method) +
    alternatives.map(alt => '<details class="alternate-method"><summary>Вариант · ' +
      escapeHtml(equipmentText(alt)) + "</summary>" + renderMethod(alt) + "</details>").join("") + "</section>" +
    (state.answers.allergens.length ? '<p class="method-note">Проверьте состав и предупреждения о следах аллергенов на упаковках.</p>' : "");
  $("meal-dialog").showModal();
}

function replaceDialog(index) {
  activeDialogIndex = index;
  const recipe = recipesById.get(state.menu[index]);
  const rules = plannerSettings(state.answers, ingredients);
  const options = replacementOptions(state.menu, index, recipes, ingredients, [], rules.meals, rules.allows, rules.priority);
  $("dialog-kicker").textContent = MEAL_LABELS[recipe.meal] + " · " + fullDay.format(dateAt(state.start, state.day));
  $("dialog-title").textContent = "Заменить блюдо";
  $("dialog-content").innerHTML = options.length ?
    '<div class="replacement-list">' + options.map(item =>
      '<button class="replacement-option" type="button" data-alternative="' + item.id + '"><span>' +
      escapeHtml(item.title) + '</span><span>' +
      compatibleMethods(item, state.answers.equipment)[0].minutes + ' мин</span></button>').join("") + '</div>' :
    '<p class="method-note">Подходящих замен с текущими ограничениями и техникой нет.</p>';
  $("meal-dialog").showModal();
}

function currentSettings() {
  return state.settingsDraft ?? { answers: state.answers, start: state.start };
}

function saveSettingsDraft(answers, start) {
  const normalized = restoreAnswers(answers);
  state.settingsDraft = start === state.start && JSON.stringify(normalized) === JSON.stringify(state.answers)
    ? null : { answers: normalized, start };
  persist();
}

function showSettingsError(error = "") {
  $("settings-error").textContent = error;
  $("settings-error").hidden = !error;
}

function renderSettings() {
  const { answers, start } = currentSettings();
  const parts = [
    STORES.find(store => store.id === answers.store)?.name ?? "Магазин не выбран",
    [
      peopleText(household(answers)) + " · Взрослые: " + answers.adults,
      ...(answers.hasChildren ? answers.children.map(child => child.age + " лет · " + child.percent + "% взрослой порции") : []),
    ],
    activeMeals(answers).map(meal => MEAL_LABELS[meal] + " · " + peopleText(mealPeople(answers, meal).people)),
    money(Math.round(answers.budget * 100)),
    [
      "Любимые: " + (answers.favorites.map(key => FAVORITES[key]).join(", ") || "—"),
      "Оценки блюд: " + Object.keys(answers.ratings).length,
      "Аллергии и ограничения: " + (answers.allergens.map(key => ALLERGENS[key]).join(", ") || "—"),
      "Исключения: " + (answers.exclusions.join(", ") || "—"),
    ],
    answers.equipment.map(key => EQUIPMENT[key]).join(", ") || "Без техники",
  ];
  $("settings-status").textContent = state.settingsDraft
    ? "Есть несохранённые изменения. Текущее меню доступно в разделе «Меню на неделю»."
    : "Настройки текущего меню";
  $("settings-week").value = start;
  $("settings-week-range").textContent = dateWithYear.formatRange(dateAt(start, 0), dateAt(start, 6));
  $("settings-cancel").disabled = !state.settingsDraft;
  $("settings-parameters").innerHTML = STEP_NAMES.map((name, index) => {
    const lines = Array.isArray(parts[index]) ? parts[index] : [parts[index]];
    const title = index === 1 ? "Количество людей" : index === 3 ? "Недельный бюджет" :
      index === 4 ? "Предпочтения и исключения" : index === 5 ? "Кухонная техника" : name;
    return '<article class="settings-item"><div><h2>' + title + '</h2>' +
      lines.map(line => "<p>" + escapeHtml(line) + "</p>").join("") + '</div>' +
      '<button type="button" class="button outline" data-edit-step="' + index + '" aria-label="Изменить: ' +
      title + '">Изменить</button></article>';
  }).join("");
}

function navigate(view) {
  if (window.location.hash !== "#" + view) window.location.hash = view;
  else activateView(true);
}

function activateView(scroll = false) {
  const hash = window.location.hash.slice(1);
  const requested = hash === "main" ? currentView : hash;
  const view = !state.menu ? "setup" : Object.hasOwn(views, requested) ? requested : "menu";
  currentView = view;
  document.body.classList.toggle("setup-active", view === "setup");
  for (const key of Object.keys(views)) $("view-" + key).hidden = key !== view;
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (link.dataset.nav === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  $("section-label").textContent = views[view];
  if (view === "setup") wizard.render({ enter: true });
  if (view === "settings") renderSettings();
  if (scroll) {
    window.scrollTo(0, 0);
    $("main").focus({ preventScroll: true });
  }
}

function syncChecked(prior) {
  const quantities = new Map(prior.map(item => [item.id, item.quantity]));
  for (const id of state.checked) {
    const item = basket.find(product => product.id === id);
    if (!item || quantities.get(id) !== item.quantity) state.checked.delete(id);
  }
}

function updatePlan(menu, answers, day, generated, start = state.start) {
  const prior = basket ?? [];
  state.menu = menu;
  state.answers = answers;
  if (start !== state.start) state.checked.clear();
  state.start = start;
  state.day = day;
  state.searched = generated;
  renderTabs();
  refreshCalculations(prior);
  persist();
}

function generate(answers, start = state.start, applyDraft = false) {
  for (const step of [0, 2, 3]) {
    const error = validateStep(answers, step);
    if (error) return error;
  }
  const rules = plannerSettings(answers, ingredients);
  const source = planningPrices(state.overrides, answers.store);
  const result = generateMenu(recipes, ingredients, rules, source,
    Math.random, state.menu ?? []);
  if (!result.menu) {
    return "Нет подходящих блюд для: " + result.empty.map(meal => MEAL_LABELS[meal].toLowerCase()).join(", ") +
      ". Проверьте выбранные приёмы пищи, ограничения и технику." + (state.menu ? " Текущее меню сохранено." : "");
  }
  if (state.menu) {
    const list = shoppingList(result.menu, recipesById, ingredients, rules.people);
    const quote = bestQuote(source.quote(list));
    if (quote && quote.knownCost > Math.round(answers.budget * 100)) {
      return "Подбор не нашёл меню в пределах бюджета. Стоимость найденного варианта " +
        quoteMoney(quote.knownCost, quote) + ". Текущее меню сохранено.";
    }
  }
  if (answers.store !== state.answers?.store) state.store = null;
  state.wizardMode = "initial";
  if (applyDraft) state.settingsDraft = null;
  $("result-error").hidden = true;
  updatePlan(result.menu, restoreAnswers(answers), 0, true, start);
  navigate("menu");
  announce("Меню составлено на семь дней.");
  return "";
}

function submitWizard() {
  if (state.wizardMode === "parameter") {
    saveSettingsDraft(state.draft, currentSettings().start);
    state.wizardMode = "initial";
    persist();
    showSettingsError();
    navigate("settings");
    return "";
  }
  return generate(state.draft, currentSettings().start, true);
}

function editParameter(event) {
  const target = event.target.closest("[data-edit-step]");
  if (!target) return;
  state.draft = restoreAnswers(currentSettings().answers);
  state.wizardMode = "parameter";
  wizard.setStep(Number(target.dataset.editStep), false);
  navigate("setup");
}

function registerEvents() {
  $("edit-shortcuts").innerHTML = STEP_NAMES.map((label, i) =>
    '<button class="button outline" type="button" data-edit-step="' + i + '">' + label + '</button>').join("");
  $("edit-shortcuts").addEventListener("click", editParameter);
  $("settings-parameters").addEventListener("click", editParameter);
  $("settings-week").addEventListener("change", event => {
    const start = weekForDate(event.target.value);
    if (!start) {
      showSettingsError("Выберите корректную календарную дату.");
      return;
    }
    saveSettingsDraft(currentSettings().answers, start);
    renderSettings();
    showSettingsError();
  });
  $("settings-save").addEventListener("click", () => {
    if (!$("settings-week").reportValidity()) return;
    const { answers, start } = currentSettings();
    showSettingsError(generate(answers, start, true));
  });
  $("settings-refresh").addEventListener("click", () => showSettingsError(generate(state.answers)));
  $("settings-cancel").addEventListener("click", () => {
    state.settingsDraft = null;
    state.draft = restoreAnswers(state.answers);
    persist();
    showSettingsError();
    renderSettings();
    announce("Черновик настроек отменён.");
  });
  $("settings-restart").addEventListener("click", () => {
    state.draft = restoreAnswers();
    state.wizardMode = "restart";
    wizard.setStep(0, false);
    navigate("setup");
  });
  $("regenerate").addEventListener("click", () => {
    const error = generate(state.answers);
    $("result-error").textContent = error;
    $("result-error").hidden = !error;
  });
  $("week-tabs").addEventListener("click", event => {
    const button = event.target.closest("[data-day]");
    if (button) selectDay(Number(button.dataset.day), true);
  });
  $("week-tabs").addEventListener("keydown", event => {
    const target = { ArrowLeft: (state.day + 6) % 7, ArrowRight: (state.day + 1) % 7, Home: 0, End: 6 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    selectDay(target, true);
  });
  $("day-menu").addEventListener("click", event => {
    const read = event.target.closest("[data-recipe]");
    const replace = event.target.closest("[data-replace]");
    if (read) recipeDialog(Number(read.dataset.recipe));
    if (replace) replaceDialog(Number(replace.dataset.replace));
  });
  $("dialog-content").addEventListener("click", event => {
    const option = event.target.closest("[data-alternative]");
    if (!option || activeDialogIndex === null) return;
    const slot = activeDialogIndex;
    const id = option.dataset.alternative;
    const rules = plannerSettings(state.answers, ingredients);
    const menu = replacementMenu(state.menu, slot, id, recipes, ingredients, [], rules.meals, rules.allows, rules.priority);
    if (!menu) return;
    $("meal-dialog").close();
    updatePlan(menu, state.answers, state.day, false);
    document.querySelector('[data-replace="' + slot + '"]')?.focus();
    announce("Блюдо заменено: " + recipesById.get(id).title + ". Список покупок обновлён.");
  });
  $("meal-dialog").addEventListener("close", () => { activeDialogIndex = null; });
  $("shopping-list").addEventListener("change", event => {
    const box = event.target.closest("[data-item]");
    if (!box) return;
    if (box.checked) state.checked.add(box.dataset.item);
    else state.checked.delete(box.dataset.item);
    box.closest(".shopping-row").classList.toggle("checked", box.checked);
    persist();
    updateShoppingCount();
  });
  $("clear-checks").addEventListener("click", () => {
    state.checked.clear();
    persist();
    renderShopping();
    $("shopping-store").focus();
    announce("Отметки о покупках сняты.");
  });
  $("shopping-store").addEventListener("change", event => {
    state.store = event.target.value;
    persist();
    renderShopping();
    $("shopping-store").focus();
  });
  $("store-comparison").addEventListener("click", event => {
    const link = event.target.closest("[data-store]");
    if (!link) return;
    state.store = link.dataset.store;
    persist();
    renderShopping();
  });
  $("estimate-form").addEventListener("submit", event => {
    event.preventDefault();
    const values = [...$("estimate-rows").querySelectorAll("[data-estimate]")].map(input =>
      [input.dataset.estimate, Math.round(input.valueAsNumber * 100), Number(input.dataset.default)]);
    state.overrides = cleanOverrides(Object.fromEntries(values.filter(([, price, base]) => price !== base)), ingredients);
    state.searched = false;
    persist();
    refreshCalculations();
    announce("Ориентировочные цены сохранены. Стоимость меню пересчитана.");
  });
  $("reset-estimates").addEventListener("click", () => {
    state.overrides = {};
    state.searched = false;
    persist();
    refreshCalculations();
    renderEstimateEditor();
    announce("Исходные ориентировочные цены восстановлены.");
  });
  window.addEventListener("hashchange", () => activateView(true));
}

async function boot() {
  try {
    [ingredients, recipes, loadedCatalog, estimateDatabase] = await Promise.all([
      data("ingredients"), data("recipes"), data("prices").catch(() => null), data("estimates").catch(() => null),
    ]);
    recipesById = new Map(recipes.map(recipe => [recipe.id, recipe]));
    state = readState();
    wizard = mountWizard({
      state, recipes, ingredients, persist, assess: assessBudget, submit: submitWizard,
      cancel() {
        state.draft = restoreAnswers(currentSettings().answers);
        state.wizardMode = "initial";
        persist();
        navigate("settings");
      },
      icon, escape: escapeHtml,
    });
    registerEvents();
    if (state.menu) {
      renderTabs();
      refreshCalculations();
    }
    renderEstimateEditor();
    $("menu-board").hidden = false;
    activateView();
  } catch (error) {
    console.error(error);
    $("fatal").textContent = "Не удалось загрузить рецепты. Обновите страницу и попробуйте снова.";
    $("fatal").hidden = false;
  }
}

boot();
