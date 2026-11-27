from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import re

from .http import SourceError, official_url


CITY = "Оренбург"
CHANNELS = {"pickup", "delivery", "in-store"}
VALID_TERMS = {"regular", "public", "conditional"}


def fail(code, message):
    raise SourceError(code, message)


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def iso_datetime(value):
    if not isinstance(value, str) or "T" not in value:
        raise ValueError("an ISO 8601 timestamp with timezone is required")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("timezone is required")
    return result.astimezone(timezone.utc)


def canonical_time(value):
    return iso_datetime(value).isoformat(timespec="seconds").replace("+00:00", "Z")


def text(value, limit=300):
    return " ".join(value.split())[:limit] if isinstance(value, str) else ""


def required_text(value, limit=300):
    result = text(value, limit)
    if not result:
        fail("format", "В данных источника отсутствует обязательное текстовое поле.")
    return result


def scope(value):
    if not isinstance(value, dict) or value.get("city") != CITY or value.get("channel") not in tuple(CHANNELS):
        fail("region", "Нужны подтверждённые город Оренбург и канал продажи.")
    return {
        "city": CITY,
        "channel": value["channel"],
        "id": required_text(value.get("id"), 150),
        "address": required_text(value.get("address")),
    }


def price_kopecks(value, currency):
    if currency != "RUB" or isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        fail("price", "Источник не указал точную цену упаковки в RUB.")
    if isinstance(value, str) and not re.fullmatch(r"\d+(?:[.,]\d{1,2})?", value.strip()):
        fail("price", "Источник не указал точную цену упаковки в RUB.")
    try:
        amount = Decimal(str(value).strip().replace(",", ".")) * 100
        if not amount.is_finite() or not 0 < amount <= 100000000 or amount != int(amount):
            raise InvalidOperation
    except (InvalidOperation, ValueError) as error:
        raise SourceError("price", "Цена упаковки имеет неподдерживаемый формат.") from error
    return int(amount)


def pack_compatible(ingredient_id, pack_size, unit, ingredients):
    item = ingredients.get(ingredient_id) if isinstance(ingredient_id, str) else None
    if not item or item["unit"] != unit or type(pack_size) is not int or not 0 < pack_size <= 25000:
        fail("pack", "Размер или единица измерения упаковки не подтверждены.")


def sale_terms(value):
    if not isinstance(value, dict) or value.get("kind") not in tuple(VALID_TERMS):
        fail("terms", "Источнику нужно явно указать условия цены.")
    kind = value["kind"]
    note = text(value.get("note"))
    if kind == "regular":
        return {"kind": kind}
    if kind == "conditional":
        return {"kind": kind, "note": note or "Условия необходимо проверить в каталоге магазина."}
    try:
        starts = canonical_time(value.get("startsAt"))
        ends = canonical_time(value.get("endsAt"))
        if starts >= ends:
            raise ValueError("backwards dates")
    except ValueError as error:
        raise SourceError("terms", "Для открытой акции нужны подтверждённые даты начала и окончания.") from error
    return {"kind": kind, "startsAt": starts, "endsAt": ends, "note": note or "Акция без карты и порога покупки."}


def offer_record(item, ingredients, hosts, checked_at):
    if not isinstance(item, dict):
        fail("format", "Неподдерживаемая запись товара.")
    ingredient_id = item.get("ingredientId")
    pack_size, unit = item.get("packSize"), item.get("unit")
    pack_compatible(ingredient_id, pack_size, unit, ingredients)
    if type(item.get("available")) is not bool:
        fail("stock", "Наличие товара не подтверждено источником.")
    try:
        updated = canonical_time(item.get("updatedAt"))
        if iso_datetime(updated) > iso_datetime(checked_at):
            raise ValueError("future date")
    except ValueError as error:
        raise SourceError("date", "Дата цены отсутствует или находится в будущем.") from error
    return {
        "sku": required_text(item.get("id"), 150),
        "ingredientId": ingredient_id,
        "name": required_text(item.get("name")),
        "packSize": pack_size,
        "unit": unit,
        "priceKopecks": price_kopecks(item.get("price"), item.get("currency")),
        "available": item["available"],
        "terms": sale_terms(item.get("terms")),
        "sourceUrl": official_url(item.get("sourceUrl"), hosts),
        "updatedAt": updated,
    }
