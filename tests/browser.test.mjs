import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { STORES, exclusionIds } from "../site/js/planner.mjs";

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

test("desktop supports recipes, persistent settings, replacement, shopping and unavailable stores", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    // Load the actual published asset first. It must boot with or without real prices.
    await page.goto(address);
    await page.getByRole("tab", { name: /понедельник/ }).waitFor();
    assert.equal(await page.getByRole("tab").count(), 7);
    assert.equal(await page.locator(".meal-card").count(), 3);
    await fitViewport(page);
    await screenshot(page, "desktop");
    const imagesReady = await page.locator(".meal-card img").evaluateAll(images =>
      images.length === 3 && images.every(image => image.complete && image.naturalWidth > 0));
    assert.ok(imagesReady);
    await page.getByRole("button", { name: "Рецепт", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    assert.equal(await dialog.locator(".ingredient-list li").first().innerText(), "Овсяные хлопья\n150 г");
    assert.equal(await dialog.locator(".steps li").count(), 3);
    await dialog.getByRole("button", { name: "Закрыть" }).click();

    await page.getByRole("button", { name: "Увеличить число человек" }).click();
    await page.getByLabel("Бюджет на неделю").fill("4800");
    await page.getByLabel("Исключить продукты").fill("Лук, грибы");
    await page.getByLabel("Исключить продукты").press("Enter");
    assert.equal(await page.locator(".chip").count(), 2);
    await page.getByRole("button", { name: "Составить меню" }).click();
    const newPlan = await state(page);
    assert.deepEqual(newPlan.settings, { people: 4, budget: 4800, exclusions: ["Лук", "грибы"] });
    const removed = exclusionIds(ingredients, newPlan.settings.exclusions);
    for (const id of newPlan.menu) {
      const recipe = recipes.find(item => item.id === id);
      assert.ok(Object.keys(recipe.ingredients).every(ingredient => !removed.has(ingredient)));
    }

    await page.getByRole("tab", { name: /понедельник/ }).press("ArrowRight");
    assert.match(await page.getByRole("tab", { selected: true }).getAttribute("aria-label"), /вторник/);
    const slot = 3;
    const before = await page.locator(".meal-card h3").first().textContent();
    await page.getByRole("button", { name: "Заменить", exact: true }).first().click();
    const choice = dialog.locator(".replacement-option").first();
    const replacementId = await choice.getAttribute("data-alternative");
    await choice.click();
    await dialog.waitFor({ state: "hidden" });
    const edited = await state(page);
    assert.notEqual(edited.menu[slot], newPlan.menu[slot]);
    assert.deepEqual(edited.menu, newPlan.menu.map((id, i) => i === slot ? replacementId : id));
    assert.notEqual(await page.locator(".meal-card h3").first().textContent(), before);

    await page.getByRole("link", { name: "Список покупок" }).click();
    const first = page.getByRole("checkbox").first();
    await first.check();
    await page.reload();
    await first.waitFor();
    assert.equal(await first.isChecked(), true);
    await page.getByRole("button", { name: "Снять отметки" }).click();
    assert.equal(await first.isChecked(), false);
    assert.deepEqual((await state(page)).settings, newPlan.settings);
    assert.equal((await state(page)).menu[slot], replacementId);
    await screenshot(page, "shopping");

    if (published) {
      assert.deepEqual(errors, []);
      return;
    }

    // Verify the documented empty-state behavior independent of today's catalog contents.
    const empty = { ...realCatalog, stores: realCatalog.stores.map(store => ({
      ...store, status: "unavailable", updatedAt: null, offers: [], error: { message: "Подтверждённых цен пока нет." },
    })) };
    await page.route("**/data/prices.json", route => route.fulfill({ json: empty }));
    await page.getByRole("link", { name: "Магазины и цены", exact: true }).click();
    await page.reload();
    await page.locator(".store-card").first().waitFor();
    assert.equal(await page.locator(".store-card").count(), 5);
    assert.equal(await page.getByText("Источник недоступен", { exact: true }).count(), 5);
    assert.deepEqual(await page.locator(".store-actions a.text-link").evaluateAll(links => links.map(link => link.href)),
      STORES.map(store => store.url));
    assert.deepEqual(errors, []);
    await screenshot(page, "stores");
  } finally {
    await page.close();
  }
});

test("mobile fits narrow screens and displays complete, partial and historical baskets separately", { skip: Boolean(published) }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(address);
    await page.getByRole("tab", { name: /понедельник/ }).waitFor();
    await fitViewport(page);
    await screenshot(page, "mobile");
    await page.setViewportSize({ width: 320, height: 720 });
    await fitViewport(page);
    await page.setViewportSize({ width: 390, height: 844 });

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
    await page.reload();
    await page.getByRole("link", { name: "Магазины и цены", exact: true }).click();
    await page.locator(".store-card").first().waitFor();
    assert.match(await page.locator("#stores-summary").innerText(), /Самая низкая цена полной актуальной корзины: Магнит/);
    assert.match(await page.locator(".store-card").nth(2).innerText(), /Цены устарели/);
    assert.match(await page.locator(".store-card").nth(3).innerText(), /Часть корзины/);
    await fitViewport(page);

    await page.locator(".store-card").nth(1).getByRole("link", { name: "К списку" }).click();
    await page.getByRole("checkbox").first().waitFor();
    assert.equal(await page.getByLabel("Источник цен").inputValue(), "magnit");
    const remainder = page.locator(".shopping-summary .summary-card").last();
    assert.match(await remainder.innerText(), /(Остаток бюджета|Сверх бюджета)\s+[\d\s,]+₽/u);
    assert.match(await page.locator(".pack-details").first().innerText(), /\d+ × /);
    await page.getByText("Товары и источник", { exact: true }).first().click();
    const source = page.locator(".pack-details details[open] a").first();
    assert.equal(await source.getAttribute("href"), "https://magnit.ru/");
    await fitViewport(page);
    await page.getByLabel("Источник цен").selectOption("perekrestok");
    assert.match(await remainder.innerText(), /Нужна цена всей корзины/);
    await page.getByLabel("Источник цен").selectOption("lenta");
    assert.match(await remainder.innerText(), /Ориентировочно/);
  } finally {
    await page.close();
  }
});

test("all 108 recipe WebPs decode, and totals and the price editor work with the served data", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(address);
    await page.getByRole("tab", { name: /понедельник/ }).waitFor();
    const assets = await page.evaluate(async () => {
      const response = await fetch("./data/recipes.json", { cache: "no-cache" });
      const recipes = await response.json();
      const names = recipes.map(recipe => recipe.image);
      for (let i = 0; i < names.length; i += 12) {
        await Promise.all(names.slice(i, i + 12).map(async name => {
          const image = new Image();
          image.src = "./assets/" + name + ".webp";
          await image.decode();
          if (!image.naturalWidth) throw new Error("Empty image: " + name);
        }));
      }
      return names;
    });
    assert.equal(assets.length, 108);
    assert.equal(new Set(assets).size, 108);
    assert.deepEqual(assets, recipes.map(recipe => recipe.image));

    const kopecks = text => Math.round(Number(text.replace(/[^\d,]/g, "").replace(",", ".")) * 100);
    let week = 0;
    for (const day of await page.getByRole("tab").all()) {
      await day.click();
      const mealAmounts = await page.locator(".meal-cost").allTextContents();
      assert.equal(mealAmounts.length, 3);
      const subtotal = kopecks(await page.locator("#day-cost").textContent());
      assert.equal(mealAmounts.reduce((sum, value) => sum + kopecks(value), 0), subtotal);
      week += subtotal;
    }
    assert.equal(week, kopecks(await page.locator("#budget-summary strong").nth(1).textContent()));
    await page.getByLabel("Бюджет на неделю").fill("1");
    await page.getByRole("button", { name: "Составить меню" }).click();
    assert.match(await page.locator("#budget-warning").innerText(), /бюджет/);
    assert.match(await page.locator("#budget-summary").innerText(), /Сверх бюджета/);
    assert.equal(new Set((await state(page)).menu).size, 21);

    await page.getByRole("link", { name: "Список покупок", exact: true }).click();
    await page.getByLabel("Источник цен").selectOption("estimate");
    const firstIngredient = await page.getByRole("checkbox").first().getAttribute("data-item");
    const subtotal = page.locator("#shopping-summary strong").nth(1);
    const original = await subtotal.textContent();
    assert.match(original, /^≈/);
    await page.getByRole("link", { name: "Магазины и цены", exact: true }).click();
    assert.equal(await page.locator(".store-card").count(), 5);
    await page.getByText("Настроить ориентировочные цены", { exact: true }).click();
    await page.locator("#estimate-" + firstIngredient).fill("10000");
    await page.getByRole("button", { name: "Сохранить цены" }).click();
    await page.getByRole("link", { name: "Список покупок", exact: true }).click();
    assert.ok(kopecks(await subtotal.textContent()) > kopecks(original));
    await page.reload();
    await subtotal.waitFor();
    assert.equal((await state(page)).overrides[firstIngredient], 1000000);
    await fitViewport(page);
  } finally {
    await page.close();
  }
});
