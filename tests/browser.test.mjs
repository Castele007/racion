import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { STORES, recipeAmount, shoppingList, starterMenu } from "../site/js/planner.mjs";
import { activeMeals, buildRules, mealPeople, restoreAnswers } from "../site/js/questionnaire.mjs";

const published = process.env.RACION_PUBLISHED_URL;
const { chromium } = createRequire(import.meta.url)("playwright");
const root = fileURLToPath(new URL("../site", import.meta.url));
const ingredients = JSON.parse(await readFile(resolve(root, "data/ingredients.json"), "utf8"));
const recipes = JSON.parse(await readFile(resolve(root, "data/recipes.json"), "utf8"));
const realCatalog = JSON.parse(await readFile(resolve(root, "data/prices.json"), "utf8"));
const types = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".css": "text/css", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".woff2": "font/woff2" };
let server, browser, address;

before(async () => {
  if (!published) server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const relative = url.pathname.replace(/^\/racion(?:\/|$)/, "/");
      const path = resolve(root, "." + decodeURIComponent(relative === "/" ? "/index.html" : relative));
      if (!path.startsWith(root + sep)) throw new Error("Unknown path");
      const contents = await readFile(path);
      response.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" });
      response.end(contents);
    } catch {
      response.writeHead(404).end();
    }
  });
  if (server) await new Promise((ready, error) => server.once("error", error).listen(0, "127.0.0.1", ready));
  address = published ? published.replace(/\/?$/, "/") : "http://127.0.0.1:" + server.address().port + "/racion/";
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
});

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise(ready => server.close(ready));
});

async function screenshot(page, name) {
  const directory = process.env.RACION_TEST_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(directory, name + ".png"), fullPage: true });
}

async function state(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("racion.v1")));
}

async function fitViewport(page) {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert.equal(fits, true, "content must fit within the viewport");
}

const byId = new Map(recipes.map(recipe => [recipe.id, recipe]));
const progress = page => page.locator("#wizard-progress-text");
const next = page => page.getByRole("button", { name: "Далее", exact: true }).click();

async function expectStep(page, step) {
  await progress(page).filter({ hasText: "Этап " + step + " из 6" }).waitFor();
  assert.equal(await page.locator("#wizard-progress li").count(), 6);
}

async function verifyAssets(page) {
  const images = await page.evaluate(async () => {
    const response = await fetch("./data/recipes.json", { cache: "no-cache" });
    const names = (await response.json()).map(recipe => recipe.image);
    for (let index = 0; index < names.length; index += 16) {
      await Promise.all(names.slice(index, index + 16).map(async name => {
        const image = new Image();
        image.src = "./assets/" + name + ".webp";
        await image.decode();
        if (!image.naturalWidth) throw new Error("Invalid asset " + name);
      }));
    }
    return names;
  });
  assert.equal(images.length, recipes.length);
  assert.equal(new Set(images).size, recipes.length);
  assert.deepEqual(images, recipes.map(recipe => recipe.image));
}

test("all six mobile stages save answers, respect filters and build an itemized weekly plan", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(address);
    await expectStep(page, 1);
    await fitViewport(page);
    await screenshot(page, "store");
    await next(page);
    assert.match(await page.locator("#wizard-error").innerText(), /магазин/);
    assert.equal(await page.locator(".wizard-store img").evaluateAll(async images => {
      await Promise.all(images.map(image => image.decode()));
      return images.filter(image => image.naturalWidth > 0).length;
    }), 5);
    await page.getByRole("button", { name: "Магнит", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Магнит", exact: true }).getAttribute("aria-pressed"), "true");
    await next(page);
    await expectStep(page, 2);
    await page.getByRole("button", { name: "Уменьшить: взрослые", exact: true }).click();
    await page.getByRole("switch", { name: "Есть дети?" }).check();
    await page.locator("#child-age-0").fill("7");
    await page.locator("#child-percent-0").fill("50");
    await screenshot(page, "family");
    await next(page);
    await expectStep(page, 3);
    await page.getByRole("button", { name: "Уменьшить: завтрак, взрослые" }).click();
    await page.locator('[data-meal-child="breakfast"]').click();
    await page.locator('[data-meal-choice="lunch"]').click();
    await page.locator('[data-meal-choice="snack"]').click();
    await page.reload();
    await expectStep(page, 3);
    const draft = (await state(page)).draft;
    assert.equal(draft.adults, 2);
    assert.deepEqual(draft.children, [{ age: 7, percent: 50 }]);
    assert.equal(mealPeople(draft, "breakfast").portions, 1);
    assert.equal(mealPeople(draft, "dinner").portions, 2.5);
    assert.deepEqual(activeMeals(draft), ["breakfast", "dinner", "snack"]);
    await next(page);
    await expectStep(page, 4);
    assert.match(await page.locator("#budget-assessment").innerText(), /вариант|ориентир/);
    const slider = page.getByRole("slider");
    assert.equal(await slider.getAttribute("min"), "1000");
    assert.equal(await slider.getAttribute("max"), "30000");
    await slider.press("End");
    assert.equal(await page.locator("#wizard-budget").inputValue(), "30000");
    await page.locator("#wizard-budget").fill("31000.25");
    assert.match(await page.locator("#budget-per-person").innerText(), /10/);
    await screenshot(page, "budget");
    await next(page);
    await expectStep(page, 5);
    await page.locator('[data-toggle-group="favorites"][data-value="chicken"]').click();
    await page.getByRole("button", { name: "Нравится", exact: true }).click();
    await page.getByRole("button", { name: "Пропустить", exact: true }).click();
    await page.locator('[data-toggle-group="allergens"][data-value="eggs"]').click();
    assert.match(await page.getByText(/возможных следах аллергенов/).innerText(), /упаковке/);
    await page.locator("#wizard-exclude").fill("баклажан, чеснок, банан");
    await page.locator("#wizard-exclude").press("Enter");
    await page.getByRole("button", { name: "Убрать банан", exact: true }).click();
    await next(page);
    await expectStep(page, 6);
    assert.equal(await page.locator(".wizard-device").count(), 9);
    await page.locator('[data-toggle-group="equipment"][data-value="stove"]').click();
    await page.locator('[data-toggle-group="equipment"][data-value="airfryer"]').click();
    await page.locator('[data-toggle-group="equipment"][data-value="blender"]').click();
    await screenshot(page, "devices");
    await page.getByRole("button", { name: "Составить меню", exact: true }).click();
    await page.getByRole("tab", { name: /понедельник/ }).waitFor();
    await fitViewport(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await fitViewport(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const plan = await state(page);
    assert.equal(plan.answers.store, "magnit");
    assert.equal(plan.answers.budget, 31000.25);
    assert.equal(plan.menu.length, 21);
    assert.equal(new Set(plan.menu).size, 21);
    assert.deepEqual(plan.answers.allergens, ["eggs"]);
    assert.deepEqual(plan.answers.exclusions, ["баклажан", "чеснок"]);
    assert.equal(Object.values(plan.answers.ratings).filter(value => value === 1).length, 1);
    const rules = buildRules(plan.answers, ingredients);
    assert.ok(plan.menu.every(id => rules.allows(byId.get(id)) && byId.get(id).meal !== "lunch"));
    assert.match(await page.locator("#result-store").innerText(), /Магнит · Оренбург/);
    assert.equal(await page.locator(".meal-cost").count(), 3);

    const recipe = byId.get(plan.menu[0]);
    const ingredientId = Object.keys(recipe.ingredients)[0];
    await page.getByRole("button", { name: "Рецепт", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    assert.match(await dialog.locator(".ingredient-list li").first().innerText(), new RegExp(
      new Intl.NumberFormat("ru-RU").format(recipeAmount(recipe, ingredientId, 1, ingredients[ingredientId].unit))
    ));
    assert.match(await dialog.innerText(), /Приготовление/);
    await dialog.getByRole("button", { name: "Закрыть" }).click();
    await page.getByRole("button", { name: "Заменить", exact: true }).first().click();
    const options = await dialog.locator("[data-alternative]").evaluateAll(nodes => nodes.map(node => node.dataset.alternative));
    assert.ok(options.length && options.every(id => rules.allows(byId.get(id))));
    await dialog.locator("[data-alternative]").first().click();
    assert.notEqual((await state(page)).menu[0], plan.menu[0]);
    await page.reload();
    await page.getByRole("tab", { name: /понедельник/ }).waitFor();

    const kopecks = text => Math.round(Number(text.replace(/[^\d,]/g, "").replace(",", ".")) * 100);
    let week = 0;
    for (const day of await page.getByRole("tab").all()) {
      await day.click();
      const mealAmounts = await page.locator(".meal-cost").allTextContents();
      const subtotal = kopecks(await page.locator("#day-cost").textContent());
      assert.equal(mealAmounts.reduce((sum, value) => sum + kopecks(value), 0), subtotal);
      week += subtotal;
    }
    assert.equal(week, kopecks(await page.locator("#budget-summary strong").nth(1).textContent()));
    await page.getByText("Изменить настройки", { exact: true }).click();
    await page.locator('[data-edit-step="3"]').click();
    await expectStep(page, 4);
    await page.locator("#wizard-budget").fill("1.25");
    await page.getByRole("button", { name: "Составить меню", exact: true }).click();
    assert.match(await page.locator("#budget-warning").innerText(), /бюджет/);
    await page.getByRole("button", { name: "Новое меню", exact: true }).click();
    assert.equal((await state(page)).answers.budget, 1.25);
    assert.match(await page.locator("#budget-summary").innerText(), /Сверх бюджета/);
    await screenshot(page, "result");

    await page.getByRole("link", { name: "Список покупок", exact: true }).click();
    const box = page.getByRole("checkbox").first();
    await box.check();
    await page.reload();
    assert.ok(await box.isChecked());
    await page.getByLabel("Источник цен").selectOption("estimate");
    assert.match(await page.locator("#shopping-summary").innerText(), /Расчёт по ориентирам/);
    await page.getByRole("link", { name: "Магазины и цены", exact: true }).click();
    assert.equal(await page.locator(".store-card").count(), 5);
    await page.getByText("Настроить ориентировочные цены", { exact: true }).click();
    await page.locator("#estimate-bread").fill("123.45");
    await page.getByRole("button", { name: "Сохранить цены" }).click();
    assert.equal((await state(page)).overrides.bread, 12345);
    await page.getByRole("button", { name: "Восстановить исходные" }).click();
    assert.equal((await state(page)).overrides.bread, undefined);
    await verifyAssets(page);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("desktop warns when restrictions and equipment leave no eligible recipes", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    if (!published) {
      await page.route("**/data/prices.json", route => route.fulfill({ json: realCatalog }));
    }
    await page.goto(address);
    await expectStep(page, 1);
    await screenshot(page, "desktop");
    await page.getByRole("button", { name: "METRO", exact: true }).click();
    await next(page);
    await expectStep(page, 2);
    await page.getByRole("button", { name: "Назад", exact: true }).click();
    await expectStep(page, 1);
    assert.equal(await page.getByRole("button", { name: "METRO", exact: true }).getAttribute("aria-pressed"), "true");
    await next(page);
    await next(page);
    await expectStep(page, 3);
    for (const meal of ["breakfast", "lunch", "dinner"]) await page.locator('[data-meal-choice="' + meal + '"]').click();
    await next(page);
    assert.match(await page.locator("#wizard-error").innerText(), /хотя бы один/);
    await page.locator('[data-meal-choice="breakfast"]').click();
    await next(page);
    await next(page);
    for (const allergy of ["gluten", "dairy"]) {
      await page.locator('[data-toggle-group="allergens"][data-value="' + allergy + '"]').click();
    }
    await next(page);
    await expectStep(page, 6);
    await page.locator('[data-toggle-group="equipment"][data-value="stove"]').click();
    await page.getByRole("button", { name: "Составить меню", exact: true }).click();
    assert.match(await page.locator("#wizard-error").innerText(), /Нет подходящих блюд.*завтрак/);
    assert.equal((await state(page)).menu, null);
    assert.equal(await page.getByRole("tab").count(), 0);
  } finally {
    await page.close();
  }
});

test("city store cards remain priced separately from estimated prices", { skip: Boolean(published) }, async () => {
  const page = await browser.newPage();
  try {
    const updatedAt = new Date(Date.now() - 3600000).toISOString();
    const location = { city: "Оренбург", id: "fixture", address: "Тестовая точка", channel: "pickup" };
    const fixture = (index, priceKopecks, ids, status = "fresh") => ({
      ...STORES[index], location, status, checkedAt: updatedAt, updatedAt,
      offers: ids.map(id => ({
        sku: "fixture-" + id, ingredientId: id, name: ingredients[id].name,
        packSize: ingredients[id].unit === "pcs" ? 10 : 1000, unit: ingredients[id].unit,
        priceKopecks, available: true, updatedAt, terms: { kind: "regular" }, sourceUrl: STORES[index].url,
      })),
    });
    await page.route("**/data/prices.json", route => route.fulfill({ json: {
      schemaVersion: 1, city: "Оренбург", stores: [
        fixture(0, 20000, Object.keys(ingredients)), fixture(1, 10000, Object.keys(ingredients)),
        fixture(2, 5000, Object.keys(ingredients), "stale"), fixture(3, 8000, ["potato"]),
      ],
    } }));
    await page.goto(address);
    await page.getByRole("button", { name: "Пятёрочка", exact: true }).click();
    for (let step = 0; step < 5; step++) await next(page);
    await page.getByRole("button", { name: "Составить меню", exact: true }).click();
    assert.match(await page.locator("#result-store").innerText(), /Пятёрочка.*Подтверждённые цены/);
    await page.getByRole("link", { name: "Магазины и цены", exact: true }).click();
    assert.match(await page.locator("#stores-summary").innerText(), /полной актуальной корзины: Магнит/);
    assert.match(await page.locator(".store-card").nth(2).innerText(), /Цены устарели/);
    await page.getByRole("link", { name: "Список покупок", exact: true }).click();
    assert.equal(await page.getByLabel("Источник цен").inputValue(), "pyaterochka");
    await page.getByLabel("Источник цен").selectOption("perekrestok");
    assert.match(await page.locator("#shopping-summary").innerText(), /Нужна цена всей корзины/);
    await page.getByLabel("Источник цен").selectOption("estimate");
    assert.match(await page.locator("#shopping-summary").innerText(), /Расчёт по ориентирам/);
  } finally {
    await page.close();
  }
});

test("Magnit shopping shows actual pack math, an estimate source for gaps and a consistent total", { skip: Boolean(published) }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    const answers = restoreAnswers({ store: "magnit", adults: 3, equipment: ["stove", "oven", "blender"] });
    const menu = starterMenu();
    await page.addInitScript(({ settings, plan }) => {
      if (!localStorage.getItem("racion.v1")) {
        localStorage.setItem("racion.v1", JSON.stringify({ answers: settings, draft: settings, menu: plan }));
      }
    }, { settings: answers, plan: menu });
    const updatedAt = new Date(Date.now() - 60000).toISOString();
    const location = { city: "Оренбург", id: "fixture", address: "Тестовая точка", channel: "pickup" };
    const mockOffer = (id, size, price, available = true) => ({
      sku: id + "-fixture", ingredientId: id, name: ingredients[id].name,
      packSize: size, unit: ingredients[id].unit, priceKopecks: price, available, updatedAt,
      terms: { kind: "regular" }, sourceUrl: "https://magnit.ru/",
    });
    await page.route("**/data/prices.json", route => route.fulfill({ json: {
      schemaVersion: 1, city: "Оренбург", stores: [{
        id: "magnit", status: "partial", location, checkedAt: updatedAt, updatedAt,
        offers: [mockOffer("milk", 800, 4999), mockOffer("potato", 1000, 7299, false)],
      }],
    } }));
    await page.goto(address);
    assert.match(await page.locator("#result-store").innerText(), /Магнит.*Цены магазина и ориентиры/);
    const weekly = await page.locator("#budget-summary strong").nth(1).innerText();
    assert.match(weekly, /^≈/);
    await page.getByRole("link", { name: "Список покупок", exact: true }).click();
    const select = page.getByLabel("Источник цен");
    assert.equal(await select.inputValue(), "magnit");
    assert.match(await select.locator("option:checked").innerText(), /с ориентирами/);
    const byRecipe = new Map(recipes.map(recipe => [recipe.id, recipe]));
    const milk = shoppingList(menu, byRecipe, ingredients, 3).find(line => line.id === "milk");
    const packs = Math.ceil(milk.quantity / 800);
    const row = id => page.locator(".shopping-row", { has: page.locator('[data-item="' + id + '"]') });
    assert.match(await row("milk").innerText(), new RegExp(packs + " × 800 мл по 49,99"));
    const currency = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
    assert.equal(await row("milk").locator(".shopping-price").innerText(), currency.format(packs * 49.99));
    assert.match(await row("potato").innerText(), /Ориентир · Нет в наличии в Магните/);
    assert.match(await row("potato").locator(".shopping-price").innerText(), /^≈/);
    await row("potato").getByText("Источник ориентира", { exact: true }).click();
    const reference = row("potato").getByRole("link", { name: /Numbeo/ });
    assert.match(await reference.getAttribute("href"), /numbeo.com/);
    assert.equal(await page.locator("#shopping-summary strong").nth(1).innerText(), weekly);
    await fitViewport(page);

    await page.getByRole("link", { name: "Магазины и цены", exact: true }).click();
    const store = page.locator(".store-card", { has: page.getByRole("heading", { name: "Магнит", exact: true }) });
    assert.match(await store.innerText(), /Часть корзины/);
    assert.equal(await store.locator(".store-cost").innerText(), currency.format(packs * 49.99));
    await store.getByRole("link", { name: "К списку" }).click();
    assert.equal(await select.inputValue(), "magnit");
    assert.equal(await page.locator("#shopping-summary strong").nth(1).innerText(), weekly);

    await page.unroute("**/data/prices.json");
    await page.route("**/data/prices.json", route => route.fulfill({ json: { schemaVersion: 1, city: "Оренбург", stores: [] } }));
    await page.reload();
    assert.equal(await select.inputValue(), "magnit");
    assert.match(await page.locator("#shopping-summary").innerText(), /Расчёт по ориентирам/);
    assert.match(await row("milk").locator(".shopping-price").innerText(), /^≈/);
  } finally {
    await page.close();
  }
});
