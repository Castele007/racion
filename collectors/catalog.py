from decimal import Decimal
from html.parser import HTMLParser
import json
import re
from urllib.parse import urlsplit

from .http import STOP_CODES, PublicWeb, SourceError, official_url, robots_allows
from .models import (
    CITY, fail, iso_datetime, offer_record, pack_compatible, required_text, scope, text,
)


MAX_PRODUCTS = 160
SIZE_UNITS = {
    "GRM": ("g", 1), "KGM": ("g", 1000), "MLT": ("ml", 1), "LTR": ("ml", 1000),
    "C62": ("pcs", 1), "H87": ("pcs", 1),
    "г": ("g", 1), "кг": ("g", 1000), "мл": ("ml", 1), "л": ("ml", 1000), "шт": ("pcs", 1),
}
NAMED_QUANTITY = re.compile(r"(?<![\d.,])(\d+(?:[,.]\d+)?)\s*(кг|мл|шт\.?|г|л)(?![а-яё])", re.I)
MULTIPACK = re.compile(r"\d+\s*[xх×*]\s*\d+", re.I)
CONDITIONAL_FIELDS = (
    "eligibleQuantity", "eligibleCustomerType", "validForMemberTier", "eligibleTransactionVolume",
    "priceSpecification", "eligibleDuration", "addOn", "priceType", "membershipPointsEarned",
)
IN_STOCK = {"InStock", "OnlineOnly", "InStoreOnly"}
OUT_OF_STOCK = {"OutOfStock", "SoldOut", "Discontinued", "BackOrder", "PreOrder", "PreSale"}


class JsonLd(HTMLParser):
    def __init__(self):
        super().__init__()
        self.documents = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("type") == "application/ld+json":
            self.current = []

    def handle_data(self, data):
        if self.current is not None:
            self.current.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.current is not None:
            try:
                self.documents.append(json.loads("".join(self.current), parse_float=Decimal))
            except (json.JSONDecodeError, RecursionError):
                pass
            self.current = None


def as_list(value):
    return value if isinstance(value, list) else [value]


def schema_name(value):
    return urlsplit(value).path.rsplit("/", 1)[-1] if isinstance(value, str) else ""


def has_type(item, wanted):
    return isinstance(item, dict) and any(schema_name(name) == wanted for name in as_list(item.get("@type")))


def graph_items(values):
    for value in values:
        if isinstance(value, list):
            yield from graph_items(value)
        elif isinstance(value, dict):
            yield value
            if "@graph" in value:
                yield from graph_items(as_list(value["@graph"]))


def actual_pack(product, unit, expected):
    sizes = set()
    for quantity in as_list(product.get("weight")) + as_list(product.get("size")):
        if not isinstance(quantity, dict):
            continue
        token = quantity.get("unitCode") or text(quantity.get("unitText")).lower().rstrip(".")
        if isinstance(token, str) and token in SIZE_UNITS and SIZE_UNITS[token][0] == unit:
            try:
                size = Decimal(str(quantity.get("value")).replace(",", ".")) * SIZE_UNITS[token][1]
                if size.is_finite() and size == int(size) and 0 < size <= 25000:
                    sizes.add(int(size))
            except ArithmeticError:
                pass
    if not sizes:
        name = required_text(product.get("name"))
        if MULTIPACK.search(name):
            fail("pack", "Вес мультиупаковки не подтверждён структурированными данными.")
        for value, token in NAMED_QUANTITY.findall(name):
            dimension, multiplier = SIZE_UNITS[token.lower().rstrip(".")]
            size = Decimal(value.replace(",", ".")) * multiplier
            if dimension == unit and size == int(size):
                sizes.add(int(size))
    if sizes != {expected}:
        fail("pack", "Источник не подтвердил фиксированный размер упаковки.")
    return expected


def is_location(offer, location, nodes):
    for place in as_list(offer.get("availableAtOrFrom")):
        if not isinstance(place, dict):
            continue
        place_id = place.get("@id")
        if len(place) == 1 and isinstance(place_id, str) and place_id in nodes:
            place = nodes[place_id]
        address = place.get("address")
        if not isinstance(address, dict):
            continue
        if (place.get("identifier") == location["id"] or place.get("@id") == location["id"]) and (
            address.get("addressLocality") == CITY and text(address.get("streetAddress")) == location["address"]
        ):
            return True
    return False


def observed_terms(offer):
    restriction = next((field for field in CONDITIONAL_FIELDS if field in offer), None)
    if restriction:
        return {"kind": "conditional", "note": "На странице указаны дополнительные условия цены."}
    starts, ends = offer.get("validFrom"), offer.get("priceValidUntil") or offer.get("validThrough")
    if starts or ends:
        try:
            if iso_datetime(starts) < iso_datetime(ends):
                return {"kind": "public", "startsAt": starts, "endsAt": ends}
        except ValueError:
            pass
        return {"kind": "conditional", "note": "Полный срок действия цены не подтверждён."}
    return {"kind": "regular"}


def page_offer(response, entry, location, ingredients, hosts, checked_at):
    if response.content_type not in ("text/html", "application/xhtml+xml"):
        fail("format", "На странице товара ожидался HTML с Product и Offer.")
    parser = JsonLd()
    try:
        parser.feed(response.text)
        items = list(graph_items(parser.documents))
    except (ValueError, RecursionError) as error:
        raise SourceError("format", "Не удалось прочитать структурированные данные товара.") from error
    nodes = {item["@id"]: item for item in items if isinstance(item.get("@id"), str)}
    products = [item for item in items if has_type(item, "Product") and str(item.get("sku")) == entry["id"]]
    if len(products) != 1:
        fail("product", "Карточка не подтвердила нужный SKU товара.")
    product = products[0]
    product_id = product.get("sku")
    if not isinstance(product_id, (str, int)) or isinstance(product_id, bool):
        fail("product", "Некорректный SKU товара.")

    regional_offers = []
    for offer in as_list(product.get("offers")):
        if isinstance(offer, dict) and len(offer) == 1 and isinstance(offer.get("@id"), str):
            offer = nodes.get(offer["@id"])
        if has_type(offer, "Offer") and is_location(offer, location, nodes):
            regional_offers.append(offer)
    # A documented single-unit public-price field is needed for this format.
    # An aggregate or several offers with ambiguous conditions is not used.
    if len(regional_offers) != 1:
        fail("region", "Страница не подтвердила одну цену для указанного магазина в Оренбурге.")
    offer = regional_offers[0]
    availability = schema_name(offer.get("availability"))
    if availability not in IN_STOCK | OUT_OF_STOCK:
        fail("stock", "Страница не подтвердила наличие нужной упаковки.")
    if (availability == "OnlineOnly" and location["channel"] == "in-store") or (
        availability == "InStoreOnly" and location["channel"] == "delivery"
    ):
        fail("region", "Цена страницы относится к другому каналу продажи.")
    return offer_record({
        **entry,
        "name": product.get("name"),
        "packSize": actual_pack(product, entry["unit"], entry["packSize"]),
        "price": offer.get("price"),
        "currency": offer.get("priceCurrency"),
        "available": availability in IN_STOCK,
        "terms": observed_terms(offer),
        "sourceUrl": response.url,
        "updatedAt": checked_at,
    }, ingredients, hosts, checked_at)


def validate_config(config, hosts, checked_at):
    if not isinstance(config, dict):
        fail("config", "Конфигурация каталога должна быть объектом JSON.")
    if config.get("format") not in ("json-ld", "regional-json"):
        fail("config", "Формат разрешённого источника не указан.")
    authorization = config.get("authorization")
    if not isinstance(authorization, dict):
        fail("unverified_source", "Условия использования источника не подтверждены.")
    official_url(authorization.get("url"), hosts)
    required_text(authorization.get("note"))
    try:
        if iso_datetime(authorization.get("verifiedAt")) > iso_datetime(checked_at):
            raise ValueError("future verification")
    except ValueError as error:
        raise SourceError("unverified_source", "Отсутствует дата проверки разрешения на автоматический сбор.") from error
    return scope(config.get("location"))


class StoreCollector:
    id: str
    name: str
    url: str
    hosts: tuple

    def __init__(self, web=None):
        self.web = web if web is not None else PublicWeb(self.hosts)

    def probe(self):
        rules = self.web.robots(self.url)
        if not robots_allows(rules, self.url):
            fail("robots_denied", "Автоматические запросы к главной странице ограничены в robots.txt.")
        return "robots.txt проверен. Доступ к ценам и условия сбора нужно подтвердить отдельно."

    def collect(self, config, ingredients, checked_at):
        if config is None:
            self.probe()
            fail("unconfigured", "Разрешённый источник цен для конкретного магазина Оренбурга пока не подтверждён.")
        location = validate_config(config, self.hosts, checked_at)
        if config["format"] == "regional-json":
            offers = self.regional_feed(config, location, ingredients, checked_at)
            return location, offers, set(), []
        offers, failed_ids, errors = self.product_pages(config, location, ingredients, checked_at)
        return location, offers, failed_ids, errors

    def regional_feed(self, config, location, ingredients, checked_at):
        response = self.web.fetch(official_url(config.get("url"), self.hosts))
        if response.content_type != "application/json" and not response.content_type.endswith("+json"):
            fail("format", "Источник не вернул региональный каталог JSON.")
        try:
            payload = json.loads(response.text, parse_float=Decimal)
        except (json.JSONDecodeError, RecursionError) as error:
            raise SourceError("format", "Неподдерживаемый ответ каталога JSON.") from error
        if not isinstance(payload, dict) or scope(payload.get("location")) != location:
            fail("region", "Ответ каталога относится к другому магазину или каналу продажи.")
        products = payload.get("products")
        if not isinstance(products, list) or not 1 <= len(products) <= MAX_PRODUCTS:
            fail("format", "Региональный каталог пуст или превышает предел записей.")
        offers = [offer_record(item, ingredients, self.hosts, checked_at) for item in products]
        if len({offer["sku"] for offer in offers}) != len(offers):
            fail("product", "Региональный каталог содержит неоднозначные идентификаторы товаров.")
        return offers

    def product_pages(self, config, location, ingredients, checked_at):
        if config.get("priceMode") != "documented-single-unit":
            fail("terms", "Для карточек товаров нужна документация о цене одной упаковки и условиях акции.")
        products = config.get("products")
        if not isinstance(products, list) or not 1 <= len(products) <= MAX_PRODUCTS:
            fail("config", "Укажите разрешённые карточки товаров в пределах лимита.")
        entries = {}
        for raw in products:
            if not isinstance(raw, dict):
                fail("config", "Неподдерживаемая конфигурация карточки товара.")
            identifier = required_text(raw.get("id"), 150)
            if identifier in entries:
                fail("config", "Идентификатор карточки товара повторяется в конфигурации.")
            pack_compatible(raw.get("ingredientId"), raw.get("packSize"), raw.get("unit"), ingredients)
            entries[identifier] = {**raw, "id": identifier, "url": official_url(raw.get("url"), self.hosts)}
        offers, failed_ids, errors = [], set(), []
        for identifier, entry in entries.items():
            try:
                response = self.web.fetch(entry["url"])
                offers.append(page_offer(response, entry, location, ingredients, self.hosts, checked_at))
            except SourceError as error:
                failed_ids.add(identifier)
                errors.append(error)
                if error.code in STOP_CODES:
                    failed_ids.update(set(entries) - {offer["sku"] for offer in offers})
                    break
        return offers, failed_ids, errors
