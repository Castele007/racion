import {
  MEALS, MEAL_NAMES, DAYS, STORES, LIMITS, MAX_PRICE_AGE, bestQuote, cleanExclusions, dateAt,
  generateMenu, isWeekStart, pricing, recipeAmount, replacementMenu, replacementOptions,
  restoreSettings, shoppingList, starterMenu, validMenu, weekStart,
} from "./planner.mjs";

const $ = id => document.getElementById(id);
const storageKey = "racion.v1";
const views = { menu: "Планировщик питания", shopping: "Список покупок", stores: "Магазины и цены" };
const mealIcons = { breakfast: "sun", lunch: "bowl", dinner: "moon" };
const dateShort = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
const dateLong = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
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

let ingredients, recipes, recipesById, state, prices, basket, quotes;
let draftExclusions = [];
let activeDialogIndex = null;
let loadedCatalog = null;

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
  const settings = restoreSettings(saved?.settings);
  let menu = saved?.menu;
  if (!validMenu(menu, recipes, ingredients, settings.exclusions)) {
    const defaultPlan = starterMenu();
    menu = validMenu(defaultPlan, recipes, ingredients, settings.exclusions) ? defaultPlan :
      generateMenu(recipes, ingredients, settings, prices).menu;
  }
  if (!menu) {
    settings.exclusions = [];
    menu = generateMenu(recipes, ingredients, settings, prices).menu;
  }
  return {
    settings, menu,
    start: isWeekStart(saved?.start) ? saved.start : weekStart(),
    day: Number.isInteger(saved?.day) && saved.day >= 0 && saved.day < 7 ? saved.day : 0,
    store: STORES.some(store => store.id === saved?.store) ? saved.store : null,
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

function showError(message = "") {
  $("form-error").textContent = message;
  $("form-error").hidden = !message;
}

function setPeopleButtons() {
  const count = $("people").valueAsNumber;
  document.querySelector('[data-people="-1"]').disabled = count <= 1;
  document.querySelector('[data-people="1"]').disabled = count >= LIMITS.people;
}

function chips() {
  const root = $("exclusion-chips");
  root.innerHTML = draftExclusions.map((label, index) =>
    '<button class="chip" type="button" data-remove="' + index + '" aria-label="' +
    escapeHtml("Убрать исключение " + label) + '">' + escapeHtml(label) + icon("close") + '</button>').join("");
  root.hidden = draftExclusions.length === 0;
}

function addExclusion() {
  const field = $("exclude");
  if (!field.value.trim()) return;
  draftExclusions = cleanExclusions([...draftExclusions, ...field.value.split(/[,;\n]+/u)]);
  field.value = "";
  showError();
  chips();
}

function renderPreferences() {
  draftExclusions = [...state.settings.exclusions];
  $("people").value = state.settings.people;
  $("budget").value = state.settings.budget;
  $("ingredient-suggestions").innerHTML = Object.values(ingredients).map(item =>
    '<option value="' + escapeHtml(item.name.toLocaleLowerCase("ru")) + '"></option>').join("");
  setPeopleButtons();
  chips();
}

function tabId(index) { return "day-tab-" + index; }

function renderTabs() {
  $("menu-dates").textContent = dateLong.formatRange(dateAt(state.start, 0), dateAt(state.start, 6)) +
    " · " + peopleText(state.settings.people) +
    (new Set(state.menu).size < state.menu.length ? " · Есть повторяющиеся блюда" : "");
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

function renderDay() {
  $("day-menu").innerHTML = MEALS.map((meal, slot) => {
    const index = state.day * MEALS.length + slot;
    const recipe = recipesById.get(state.menu[index]);
    const image = recipe.image && /^[a-z-]+$/.test(recipe.image) ?
      '<img class="meal-photo" alt="" src="./assets/' + recipe.image + '.webp" width="400" height="186">' :
      '<div class="meal-photo meal-placeholder" aria-hidden="true">' + icon(mealIcons[meal]) + '</div>';
    return '<article class="meal-card">' + image + '<div class="meal-body"><div class="meal-meta">' +
      '<span class="meal-tag ' + meal + '">' + icon(mealIcons[meal]) + MEAL_NAMES[meal] + '</span>' +
      '<span class="meal-time">' + icon("clock") + recipe.minutes + ' мин</span></div>' +
      '<h3>' + escapeHtml(recipe.title) + '</h3><div class="meal-actions">' +
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
  const budget = state.settings.budget * 100;
  const remainder = quote?.complete ? budget - quote.knownCost : null;
  const incomplete = !quote?.complete;
  const historical = Boolean(quote?.stale);
  const basketTitle = incomplete && quote?.knownCost != null ? "Часть корзины" : "Вся корзина";
  const remainderTitle = remainder !== null && remainder < 0 ? "Сверх бюджета" : "Остаток бюджета";
  let note = "";
  if (quote?.complete) {
    note = "Корзина целых упаковок · " + escapeHtml(quote.store.name) +
      (historical ? " · по последним сохранённым ценам" : "");
  } else if (menuView) {
    note = '<a class="text-link" href="#stores">Проверить магазины и цены</a>';
  } else if (quote?.knownCost != null) {
    note = "Известная сумма за часть списка. Для остальных продуктов нет подходящих цен.";
  }
  return '<div class="summary-grid">' + summaryCard("Бюджет", money(budget), "На неделю") +
    summaryCard(basketTitle, quote?.knownCost == null ? "—" : money(quote.knownCost),
      historical ? "Есть устаревшие цены" : (incomplete ? "Нет полной оценки" : "Целые упаковки")) +
    summaryCard(remainderTitle, remainder === null ? "—" : money(Math.abs(remainder)),
      remainder === null ? "Нужна цена всей корзины" : (historical ? "Ориентировочно" : ""),
      remainder === null ? "" : (remainder < 0 ? "over" : "good")) + "</div>" +
    (note ? '<p class="summary-note">' + note + '</p>' : "");
}

function selectedQuote() {
  return quotes.find(quote => quote.store.id === state.store) ?? bestQuote(quotes) ??
    [...quotes].sort((a, b) => a.missing - b.missing || a.stale - b.stale)[0];
}

function updateShoppingCount() {
  const checked = basket.filter(item => state.checked.has(item.id)).length;
  $("shopping-subtitle").textContent = peopleText(state.settings.people) + " · " +
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
    packs = item.packs.map(({ count, offer }) => count + " × " + amount(offer.packSize, item.unit)).join(" + ") +
      (item.stale ? " · устарело" : "");
  }
  const products = (item.packs ?? []).map(({ offer, count }) => offerDetails(offer, item, count));
  const conditional = item.conditional.map(offer => offerDetails(offer, item, 0));
  return '<div class="shopping-row' + (checked ? ' checked' : '') + '"><label><input type="checkbox" data-item="' +
    item.id + '"' + (checked ? " checked" : "") + '><span>' + escapeHtml(item.name) + '<small>Нужно ' +
    amount(item.quantity, item.unit) + '</small></span></label><div class="pack-details">' + packs +
    (products.length ? '<details><summary>Товары и источник</summary><ul>' + products.join("") + '</ul></details>' : '') +
    (conditional.length ? '<details><summary>Акции с условиями</summary><ul>' + conditional.join("") + '</ul></details>' : '') +
    '</div><div class="shopping-price">' + (item.hasPrice ? money(item.cost) : "—") + '</div></div>';
}

function renderShopping() {
  const selected = selectedQuote();
  updateShoppingCount();
  $("shopping-summary").innerHTML = budgetSummary(selected);
  $("shopping-store").innerHTML = quotes.map(quote => '<option value="' + quote.store.id + '"' +
    (quote === selected ? ' selected' : '') + '>' + escapeHtml(quote.store.name) + '</option>').join("");
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
  const best = bestQuote(quotes);
  const headline = best ?
    (best.stale ? "Полная корзина по последним сохранённым ценам: " : "Самая низкая цена полной актуальной корзины: ") +
      '<strong>' + escapeHtml(best.store.name) + ' · ' + money(best.knownCost) + '</strong>.' :
    "Полных цен для этой корзины пока нет. Доступные цены на отдельные продукты показаны в списке покупок.";
  $("stores-summary").innerHTML = message(headline, !best || Boolean(best.stale));
  $("store-comparison").innerHTML = quotes.map(quote => {
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

function refreshCalculations() {
  prices = pricing(loadedCatalog);
  basket = shoppingList(state.menu, recipesById, ingredients, state.settings.people);
  quotes = prices.quote(basket);
  $("budget-summary").innerHTML = budgetSummary(bestQuote(quotes), true);
  const activeStores = quotes.filter(quote => storeStatus(quote.store, Date.now())[0] === "fresh").length;
  $("sidebar-prices").textContent = activeStores ?
    countText(activeStores, { one: "магазин с ценами", few: "магазина с ценами", many: "магазинов с ценами" }) :
    "Нет актуальных каталогов";
  renderShopping();
  renderStores();
}

function recipeDialog(index) {
  const recipe = recipesById.get(state.menu[index]);
  const people = state.settings.people;
  $("dialog-kicker").textContent = MEAL_NAMES[recipe.meal] + " · " + recipe.minutes + " мин";
  $("dialog-title").textContent = recipe.title;
  $("dialog-content").innerHTML = '<section class="dialog-section"><h3>Ингредиенты · ' +
    peopleText(people) + '</h3><ul class="ingredient-list">' +
    Object.keys(recipe.ingredients).map(id => {
      const item = ingredients[id];
      return '<li><span>' + escapeHtml(item.name) + '</span><span>' +
        amount(recipeAmount(recipe, id, people, item.unit), item.unit) + '</span></li>';
    }).join("") + '</ul></section><section class="dialog-section"><h3>Приготовление</h3><ol class="steps">' +
    recipe.instructions.map(step => '<li>' + escapeHtml(step) + '</li>').join("") + '</ol></section>';
  $("meal-dialog").showModal();
}

function replaceDialog(index) {
  activeDialogIndex = index;
  const recipe = recipesById.get(state.menu[index]);
  const options = replacementOptions(state.menu, index, recipes, ingredients, state.settings.exclusions);
  $("dialog-kicker").textContent = MEAL_NAMES[recipe.meal] + " · " + fullDay.format(dateAt(state.start, state.day));
  $("dialog-title").textContent = "Заменить блюдо";
  $("dialog-content").innerHTML = options.length ?
    '<div class="replacement-list">' + options.map(item =>
      '<button class="replacement-option" type="button" data-alternative="' + item.id + '"><span>' +
      escapeHtml(item.title) + '</span><span>' + item.minutes + ' мин</span></button>').join("") + '</div>' :
    '<p class="method-note">Подходящих замен с текущими исключениями нет.</p>';
  $("meal-dialog").showModal();
}

function activateView(scroll = false) {
  const hash = window.location.hash.slice(1);
  if (hash === "main") return;
  const view = Object.hasOwn(views, hash) ? hash : "menu";
  for (const key of Object.keys(views)) $("view-" + key).hidden = key !== view;
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (link.dataset.nav === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  $("section-label").textContent = views[view];
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

function updatePlan(menu, settings, start, day) {
  const prior = basket;
  state.menu = menu;
  state.settings = settings;
  state.start = start;
  state.day = day;
  basket = shoppingList(menu, recipesById, ingredients, settings.people);
  syncChecked(prior);
  renderTabs();
  renderDay();
  refreshCalculations();
  persist();
}

function registerEvents() {
  $("people").addEventListener("input", setPeopleButtons);
  $("add-exclusion").addEventListener("click", () => { addExclusion(); $("exclude").focus(); });
  $("exclude").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing && $("exclude").value.trim()) {
      event.preventDefault();
      addExclusion();
    }
  });
  $("preferences").addEventListener("click", event => {
    const peopleButton = event.target.closest("[data-people]");
    const chip = event.target.closest("[data-remove]");
    if (peopleButton) {
      const current = $("people").valueAsNumber || state.settings.people;
      $("people").value = Math.min(LIMITS.people, Math.max(1, current + Number(peopleButton.dataset.people)));
      setPeopleButtons();
    }
    if (chip) {
      draftExclusions.splice(Number(chip.dataset.remove), 1);
      chips();
      showError();
      $("exclude").focus();
    }
  });
  $("preferences").addEventListener("submit", event => {
    event.preventDefault();
    addExclusion();
    const settings = { people: $("people").valueAsNumber, budget: $("budget").valueAsNumber, exclusions: draftExclusions };
    const result = generateMenu(recipes, ingredients, settings, prices, Math.random, state.menu);
    if (!result.menu) {
      showError("С этими исключениями не хватает блюд. Измените список продуктов и попробуйте снова.");
      return;
    }
    showError();
    updatePlan(result.menu, settings, weekStart(), 0);
    announce("Меню составлено на семь дней. Открыт понедельник.");
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
    const menu = replacementMenu(state.menu, slot, id, recipes, ingredients, state.settings.exclusions);
    if (!menu) return;
    $("meal-dialog").close();
    updatePlan(menu, state.settings, state.start, state.day);
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
  window.addEventListener("hashchange", () => activateView(true));
}

async function boot() {
  try {
    [ingredients, recipes, loadedCatalog] = await Promise.all([
      data("ingredients"), data("recipes"), data("prices").catch(() => null),
    ]);
    recipesById = new Map(recipes.map(recipe => [recipe.id, recipe]));
    prices = pricing(loadedCatalog);
    state = readState();
    registerEvents();
    renderPreferences();
    renderTabs();
    renderDay();
    refreshCalculations();
    activateView();
    $("generate").disabled = false;
    $("menu-board").hidden = false;
  } catch (error) {
    console.error(error);
    $("fatal").textContent = "Не удалось загрузить рецепты. Обновите страницу и попробуйте снова.";
    $("fatal").hidden = false;
  }
}

boot();
