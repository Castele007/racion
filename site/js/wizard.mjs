import { normalize, STORES, cleanExclusions } from "./planner.mjs";
import {
  ADULT_LIMIT, CHILD_LIMIT, BUDGET_MAX, MEALS, MEAL_LABELS, STEP_NAMES, EQUIPMENT, FAVORITES,
  ALLERGENS, COMMON_EXCLUSIONS, activeMeals, childDefault, dietFilter, household, mealPeople, restoreAnswers, validBudget, validateStep,
} from "./questionnaire.mjs";

const labels = [
  ["Где покупаете продукты?", "Выберите магазин в Оренбурге. Если его корзину пока нельзя посчитать, используем ориентировочные цены."],
  ["Кто будет за столом?", "Укажите состав семьи. Детские порции можно настроить отдельно."],
  ["Когда будете готовить?", "Отметьте приёмы пищи и выберите участников для каждого из них."],
  ["Какой бюджет на неделю?", "Проверим, какое меню можно подобрать для выбранных приёмов пищи."],
  ["Что вам нравится?", "Отметьте любимое, пищевые ограничения и продукты, которые нужно исключить."],
  ["Какая техника есть дома?", "Выберите всё, чем готовы пользоваться. Пустой список оставит рецепты без техники."],
];
const mealIcons = { breakfast: "sun", lunch: "bowl", dinner: "moon", snack: "leaf" };
const devices = {
  stove: "stove", oven: "oven", microwave: "microwave", multicooker: "cooker", airfryer: "air",
  blender: "blender", steamer: "steam", "electric-grill": "grill", kettle: "kettle",
};
const rubles = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const decimals = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

export function mountWizard({ state, recipes, ingredients, persist, assess, submit, cancel, icon, escape }) {
  const $ = id => document.getElementById(id);
  const form = $("wizard-form");
  const content = $("wizard-content");
  let ratingIndex = 0;
  let assessment = null;

  function error(message = "") {
    $("wizard-error").textContent = message;
    $("wizard-error").hidden = !message;
  }

  function card(attrs, isChecked, body, className = "") {
    return '<button type="button" class="wizard-choice ' + className + '" ' + attrs +
      ' aria-pressed="' + isChecked + '">' + body + '<span class="choice-check">' + icon("check") + "</span></button>";
  }

  function chips(group, options, current) {
    return '<div class="wizard-chips">' + Object.entries(options).map(([value, title]) =>
      '<button type="button" class="wizard-chip" data-toggle-group="' + group + '" data-value="' + escape(value) +
      '" aria-pressed="' + (group === "exclusions" ? current.some(item => normalize(item) === normalize(value)) :
        current.includes(value)) + '">' + escape(title) + "</button>").join("") + "</div>";
  }

  function counter(id, count, label, min, max) {
    return '<div class="wizard-counter" role="group" aria-label="' + escape(label) + '">' +
      [-1, 1].map((direction, index) => (index === 1 ?
        '<output aria-label="' + escape(label) + '">' + count + '</output>' : '') +
        '<button type="button" data-counter="' + id + '" data-change="' + direction + '" aria-label="' +
        (direction < 0 ? "Уменьшить: " : "Увеличить: ") + escape(label) + '"' +
        ((direction < 0 ? count <= min : count >= max) ? " disabled" : "") + '>' +
        icon(direction < 0 ? "minus" : "plus") + "</button>").join("") + "</div>";
  }

  function storeStep(a) {
    return '<div class="wizard-store-grid">' + STORES.map(store => card(
      'data-store-choice="' + store.id + '"', a.store === store.id,
      '<span class="shop-logo"><img src="./assets/stores/' + store.id + '.webp" alt=""></span><strong>' +
      escape(store.name) + "</strong>", "wizard-store"
    )).join("") + "</div>";
  }

  function familyStep(a) {
    const rows = a.children.map((child, index) =>
      '<div class="child-row"><strong>Ребёнок ' + (index + 1) + '</strong>' +
      '<label for="child-age-' + index + '">Возраст, лет<input type="number" id="child-age-' + index +
      '" data-child-age="' + index + '" min="1" max="17" inputmode="numeric" value="' + child.age + '" required></label>' +
      '<label for="child-percent-' + index + '">Порция, %<input type="number" id="child-percent-' + index +
      '" data-child-percent="' + index + '" min="10" max="150" inputmode="numeric" value="' + child.percent + '" required></label></div>'
    ).join("");
    return '<div class="wizard-unit"><div><strong>Взрослые</strong><small>Одна взрослая порция на человека</small></div>' +
      counter("adults", a.adults, "взрослые", 1, ADULT_LIMIT) + '</div>' +
      '<label class="wizard-unit"><strong>Есть дети?</strong><input type="checkbox" role="switch" id="has-children"' +
      (a.hasChildren ? " checked" : "") + '></label>' +
      (a.hasChildren ? '<div class="wizard-unit"><div><strong>Количество детей</strong><small>Возраст от 1 до 17 лет</small></div>' +
        counter("children", a.children.length, "дети", 1, CHILD_LIMIT) + '</div><div class="child-list">' + rows +
        '</div><p class="wizard-note">Процент задаёт долю взрослой порции для расчёта покупок. Для маленьких детей проверьте состав и адаптируйте текстуру блюда.</p>' : "");
  }

  function mealsStep(a) {
    return '<div class="wizard-meals">' + MEALS.map(meal => {
      const plan = a.meals[meal];
      const count = mealPeople(a, meal);
      const title = MEAL_LABELS[meal];
      const childButtons = a.hasChildren ? '<div class="wizard-chips">' + a.children.map((child, index) =>
        '<button type="button" class="wizard-chip" data-meal-child="' + meal + '" data-child-index="' + index +
        '" aria-pressed="' + (plan.children === null || plan.children.includes(index)) + '">Ребёнок ' +
        (index + 1) + ' · ' + child.age + ' лет</button>').join("") + "</div>" : "";
      return '<article class="wizard-meal">' + card('data-meal-choice="' + meal + '"', plan.enabled,
        '<span class="choice-icon">' + icon(mealIcons[meal]) + '</span><strong>' + title + '</strong>', "wizard-meal-choice") +
        (plan.enabled ? '<div class="meal-participants"><div class="wizard-unit"><div><strong>Взрослые</strong><small>Всего ' +
          count.people + " чел. · " + decimals.format(count.portions) + " порц.</small></div>" +
          counter("meal-" + meal, count.adults, title.toLowerCase() + ", взрослые", 0, a.adults) + "</div>" +
          childButtons + "</div>" : "") + "</article>";
    }).join("") + "</div>";
  }

  function budgetStep(a) {
    return '<div class="budget-control"><label for="wizard-budget">На семь дней</label><div class="budget-amount"><input type="number" ' +
      'id="wizard-budget" inputmode="decimal" min="0.01" max="' + BUDGET_MAX + '" step="0.01" required value="' + a.budget +
      '"><span>₽</span></div><label for="budget-range" class="sr-only">Ползунок бюджета</label><input type="range" id="budget-range" ' +
      'min="1000" max="30000" step="100" value="' + Math.max(1000, Math.min(30000, a.budget)) +
      '"><div class="range-endpoints"><span>1 000 ₽</span><span>30 000 ₽</span></div></div>' +
      '<div class="budget-stats"><div><small>На человека в неделю</small><strong id="budget-per-person"></strong></div>' +
      '<div><small>На день</small><strong id="budget-per-day"></strong></div></div>' +
      '<p id="budget-assessment" class="wizard-note" aria-live="polite"></p>';
  }

  function budgetText() {
    const budget = state.draft.budget;
    $("budget-per-person").textContent = rubles.format(budget / household(state.draft));
    $("budget-per-day").textContent = rubles.format(budget / 7);
    const target = $("budget-assessment");
    if (!assessment?.quote) {
      target.textContent = assessment?.message ?? "Для этих настроек пока нет полной цены корзины.";
      return;
    }
    const { quote, bound } = assessment;
    const source = quote.estimate ? "по ориентирам" : quote.stale ? "по архивным ценам" : "по ценам выбранного магазина";
    const example = (quote.estimate || quote.stale ? "≈ " : "") + rubles.format(quote.knownCost / 100);
    target.textContent = quote.knownCost <= Math.round(budget * 100) ? "Уже найден вариант " + source + " за " + example + "." :
      bound !== null && bound > Math.round(budget * 100) ? "По этим ориентирам бюджета не хватит даже без округления до упаковок." :
      "Проверенный вариант " + source + " стоит " + example + ". Подбор может найти более дешёвое меню.";
  }

  function preferencesStep(a) {
    const meals = activeMeals(a);
    const dietAllows = dietFilter(a, ingredients);
    const eligible = recipes.filter(recipe => meals.includes(recipe.meal) && dietAllows(recipe));
    const liked = eligible.filter(recipe => recipe.tags.some(tag => a.favorites.includes(tag)));
    const queue = [...liked, ...eligible.filter(recipe => !liked.includes(recipe))];
    const recipe = queue[ratingIndex % queue.length];
    const ratingCard = !recipe ? "" : '<article class="wizard-rating"><img src="./assets/' + recipe.image +
      '.webp" alt=""><div><strong>' + escape(recipe.title) +
      '</strong><div class="wizard-chips"><button type="button" class="wizard-chip" data-rate="1" data-recipe="' + recipe.id +
      '" aria-pressed="' + (a.ratings[recipe.id] === 1) + '">Нравится</button><button type="button" class="wizard-chip" ' +
      'data-rate="-1" data-recipe="' + recipe.id + '" aria-pressed="' + (a.ratings[recipe.id] === -1) +
      '">Не нравится</button><button type="button" class="wizard-chip" data-rate="0">Пропустить</button></div></div></article>';
    const list = a.exclusions.map((item, index) =>
      '<button type="button" class="wizard-chip chosen-exclusion" data-remove-exclusion="' + index +
      '" aria-label="' + escape("Убрать " + item) + '">' + escape(item) + icon("close") + "</button>").join("");
    return '<div class="wizard-preferences"><section><h2>Любимые блюда и продукты</h2>' + chips("favorites", FAVORITES, a.favorites) +
      ratingCard + '</section><section><h2>Аллергии и ограничения</h2>' + chips("allergens", ALLERGENS, a.allergens) +
      '<p class="wizard-note">Лактоза и молочный белок учитываются отдельно. Безлактозное коровье молоко исключается при аллергии на молочные продукты. ' +
      'Проверяйте состав и предупреждение о возможных следах аллергенов на упаковке каждого товара.</p></section>' +
      '<section><h2>Нелюбимые продукты</h2>' +
      chips("exclusions", Object.fromEntries(COMMON_EXCLUSIONS.map(item => [item, item])), a.exclusions) +
      '<div class="wizard-entry"><label class="sr-only" for="wizard-exclude">Добавить продукт</label>' +
      '<input type="text" id="wizard-exclude" maxlength="150" list="wizard-ingredients" placeholder="Добавить продукт" autocomplete="off">' +
      '<button class="button outline" type="button" id="wizard-exclude-add">Добавить</button></div>' +
      '<datalist id="wizard-ingredients">' + Object.values(ingredients).map(item =>
        '<option value="' + escape(item.name.toLocaleLowerCase("ru")) + '"></option>').join("") + '</datalist>' +
      '<div class="wizard-chips" id="wizard-exclusions">' + list + '</div></section></div>';
  }

  function equipmentStep(a) {
    return '<div class="wizard-device-grid">' + Object.entries(EQUIPMENT).map(([key, title]) =>
      card('data-toggle-group="equipment" data-value="' + key + '"', a.equipment.includes(key),
        '<span class="choice-icon">' + icon(devices[key]) + '</span><strong>' + title + "</strong>", "wizard-device")
    ).join("") + "</div>";
  }

  const renderStep = [storeStep, familyStep, mealsStep, budgetStep, preferencesStep, equipmentStep];

  function render({ focus = false, enter = false } = {}) {
    const step = state.step;
    $("wizard-progress-text").textContent = "Этап " + (step + 1) + " из 6 · " + STEP_NAMES[step];
    $("wizard-progress").innerHTML = STEP_NAMES.map((name, i) =>
      '<li class="' + (i < step ? "past" : i === step ? "current" : "") + '" ' +
      (i === step ? 'aria-current="step" ' : "") + 'aria-label="' + name + '"></li>').join("");
    $("wizard-title").textContent = labels[step][0];
    $("wizard-intro").textContent = labels[step][1];
    const previousScroll = content.scrollTop;
    content.innerHTML = renderStep[step](state.draft);
    content.scrollTop = enter ? 0 : previousScroll;
    $("wizard-back").disabled = step === 0 && !state.editing;
    $("wizard-back").textContent = state.editing ? "К меню" : "Назад";
    $("wizard-next").textContent = state.editing || step === 5 ? "Составить меню" : "Далее";
    if (step === 3) {
      if (enter || assessment === null) assessment = assess(state.draft);
      budgetText();
    }
    if (enter && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      content.animate([{ opacity: .45, transform: "translateY(5px)" }, { opacity: 1, transform: "translateY(0)" }], 170);
    }
    if (focus) $("wizard-title").focus();
  }

  function saveRender(target) {
    state.draft = restoreAnswers(state.draft);
    persist();
    error();
    render();
    if (target) content.querySelector(target)?.focus();
  }

  function setStep(step, focus = true) {
    state.step = step;
    persist();
    error();
    render({ focus, enter: true });
    if (focus) window.scrollTo(0, 0);
  }

  function updateCounter(name, change) {
    const a = state.draft;
    if (name === "adults") a.adults = Math.max(1, Math.min(ADULT_LIMIT, a.adults + change));
    else if (name === "children") {
      if (change > 0 && a.children.length < CHILD_LIMIT) a.children.push(childDefault(6));
      if (change < 0 && a.children.length > 1) a.children.pop();
    } else {
      const choice = a.meals[name.slice(5)];
      choice.adults = Math.max(0, Math.min(a.adults, (choice.adults ?? a.adults) + change));
    }
  }

  function addExclusion() {
    const field = $("wizard-exclude");
    const values = field.value.split(/[,;\n]+/u);
    state.draft.exclusions = cleanExclusions([...state.draft.exclusions, ...values]);
    saveRender("#wizard-exclude");
  }

  content.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    const a = state.draft;
    const d = button.dataset;
    if (d.storeChoice) a.store = d.storeChoice;
    else if (d.counter) updateCounter(d.counter, Number(d.change));
    else if (d.mealChoice) a.meals[d.mealChoice].enabled = !a.meals[d.mealChoice].enabled;
    else if (d.mealChild) {
      const meal = a.meals[d.mealChild];
      const index = Number(d.childIndex);
      const children = meal.children ?? a.children.map((_, i) => i);
      meal.children = children.includes(index) ? children.filter(i => i !== index) : [...children, index];
    } else if (d.toggleGroup) {
      const key = d.toggleGroup;
      const value = d.value;
      const same = item => key === "exclusions" ? normalize(item) === normalize(value) : item === value;
      a[key] = a[key].some(same) ? a[key].filter(item => !same(item)) : [...a[key], value];
    } else if (d.rate) {
      if (d.recipe) a.ratings[d.recipe] = Number(d.rate);
      ratingIndex++;
    } else if (d.removeExclusion !== undefined) {
      a.exclusions.splice(Number(d.removeExclusion), 1);
      saveRender("#wizard-exclude");
      return;
    } else if (button.id === "wizard-exclude-add") {
      addExclusion();
      return;
    } else return;
    const sibling = [...content.querySelectorAll("button")].indexOf(button);
    saveRender();
    const next = content.querySelectorAll("button")[sibling];
    if (next && !next.disabled) next.focus({ preventScroll: true });
  });

  content.addEventListener("input", event => {
    const input = event.target;
    const a = state.draft;
    if (input.id === "budget-range") {
      a.budget = input.valueAsNumber;
      $("wizard-budget").value = a.budget;
    } else if (input.id === "wizard-budget" && validBudget(input.valueAsNumber)) {
      a.budget = input.valueAsNumber;
      $("budget-range").value = Math.max(1000, Math.min(30000, a.budget));
    } else if (input.dataset.childAge !== undefined && input.validity.valid && Number.isInteger(input.valueAsNumber)) {
      const index = Number(input.dataset.childAge);
      const child = a.children[index];
      const preset = child.percent === childDefault(child.age).percent;
      child.age = input.valueAsNumber;
      if (preset) {
        child.percent = childDefault(child.age).percent;
        $("child-percent-" + index).value = child.percent;
      }
    } else if (input.dataset.childPercent !== undefined && input.validity.valid && Number.isInteger(input.valueAsNumber)) {
      a.children[Number(input.dataset.childPercent)].percent = input.valueAsNumber;
    } else return;
    if (state.step === 3) budgetText();
    persist();
  });

  content.addEventListener("change", event => {
    if (event.target.id !== "has-children") return;
    state.draft.hasChildren = event.target.checked;
    saveRender("#has-children");
  });

  content.addEventListener("keydown", event => {
    if (event.target.id !== "wizard-exclude" || event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    addExclusion();
  });

  form.addEventListener("submit", event => {
    event.preventDefault();
    if (state.step === 4 && $("wizard-exclude").value.trim()) addExclusion();
    const problem = validateStep(state.draft, state.step);
    if (problem) {
      error(problem);
      return;
    }
    if (state.editing || state.step === 5) {
      error(submit());
      return;
    }
    setStep(state.step + 1);
  });
  $("wizard-back").addEventListener("click", () => {
    if (state.editing) cancel();
    else if (state.step > 0) setStep(state.step - 1);
  });

  return { render, setStep };
}
