"""Summarize public price observations without publishing a store catalog."""

import argparse
import csv
import gzip
import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path


CHAINS = {
    "Пятёрочка": {"пятерочка", "pyaterochka", "pyatyorochka"},
    "Магнит": {"магнит", "магнит у дома", "магнит семейный", "магнит экстра", "магнит экспресс", "magnit"},
    "Лента": {"лента", "супер лента", "лента гипер", "гипер лента", "lenta"},
    "Перекрёсток": {"перекресток", "perekrestok"},
    "METRO": {"метро", "metro", "metro cash carry", "metro cash and carry", "метро кэш энд керри"},
}
CITY_NAMES = {"оренбург", "г оренбург", "город оренбург", "orenburg", "city of orenburg"}
OBLAST = re.compile(r"\b(?:оренбургская (?:область|обл)|orenburg (?:oblast|region))\b")
POSTCODE = re.compile(r"46[0-2][0-9]{3}")


def normalized(value):
    return " ".join(re.findall(r"[^\W_]+", (value or "").casefold().replace("ё", "е")))


def local_scope(city, address="", postcode=""):
    if any(normalized(part) in CITY_NAMES for part in [city, *(address or "").split(",")]):
        return "orenburg"
    if OBLAST.search(normalized(f"{city or ''} {address or ''}")) or POSTCODE.fullmatch(postcode or ""):
        return "orenburg_oblast"
    return None


@dataclass
class Counts:
    observations: int = 0
    barcodes: set = field(default_factory=set)
    first_date: str | None = None
    last_date: str | None = None

    def add(self, barcode, date):
        self.observations += 1
        if barcode:
            self.barcodes.add(barcode)
        if date:
            self.first_date = min(self.first_date or date, date)
            self.last_date = max(self.last_date or date, date)

    def summary(self):
        return {
            "observations": self.observations,
            "distinct_barcodes": len(self.barcodes),
            "first_observed_date": self.first_date,
            "last_observed_date": self.last_date,
        }


@dataclass(frozen=True)
class Observation:
    barcode: str | None
    date: str
    currency: str
    country_code: str | None
    city: str | None
    retailer_brand: str | None
    retailer_name: str | None
    address: str | None = None
    postcode: str | None = None


def summarize(rows):
    scopes = {name: Counts() for name in ("world", "russia", "russia_rub", "orenburg_oblast", "orenburg")}
    russian_chains = {name: Counts() for name in CHAINS}
    local_chains = {name: Counts() for name in CHAINS}
    for row in rows:
        identity = (row.barcode, row.date)
        scopes["world"].add(*identity)
        if (row.country_code or "").upper() != "RU":
            continue
        scopes["russia"].add(*identity)
        if row.currency != "RUB":
            continue
        scopes["russia_rub"].add(*identity)
        scope = local_scope(row.city, row.address, row.postcode)
        if scope:
            scopes["orenburg_oblast"].add(*identity)
        if scope == "orenburg":
            scopes["orenburg"].add(*identity)

        brand, name = normalized(row.retailer_brand), normalized(row.retailer_name)
        chain = next((key for key, names in CHAINS.items() if brand in names or name in names), None)
        if chain:
            russian_chains[chain].add(*identity)
            if scope == "orenburg":
                local_chains[chain].add(*identity)

    return {
        **{name: count.summary() for name, count in scopes.items()},
        "russia_rub_by_chain": {name: count.summary() for name, count in russian_chains.items()},
        "orenburg_by_chain": {name: count.summary() for name, count in local_chains.items()},
        # An observation alone cannot certify an ingredient match or a usable package.
        "ingredients_covered_in_orenburg": 0 if scopes["orenburg"].observations == 0 else None,
    }


def checksum(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def verify_webtruffle(manifest_path, csv_path):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest["dataset_id"] != "retail-product-catalog-prices" or manifest["schema_version"] != "1.0":
        raise ValueError("Неподдерживаемая схема manifest.json WebTruffle.")
    asset = manifest["files"]["retail-product-prices.csv"]
    if csv_path.stat().st_size != asset["bytes"] or checksum(csv_path) != asset["sha256"]:
        raise ValueError("Размер или SHA-256 CSV не совпадает с manifest.json WebTruffle.")
    return manifest


def json_lines(path):
    with gzip.open(path, mode="rt", encoding="utf-8") as handle:
        for line in handle:
            yield json.loads(line)


def audit(directory, ingredients):
    csv_path = directory / "retail-product-prices.csv"
    manifest = verify_webtruffle(directory / "manifest.json", csv_path)
    prices_path = directory / "prices.jsonl.gz"
    locations_path = directory / "locations.jsonl.gz"

    locations = {
        record["id"]: record for record in json_lines(locations_path)
        if (record.get("osm_address_country_code") or "").upper() == "RU"
    }
    russian_locations_by_price_id = {}

    def open_prices_rows():
        for row in json_lines(prices_path):
            location = locations.get(row["location_id"], {})
            if location:
                russian_locations_by_price_id[str(row["id"])] = location
            yield Observation(
                row["product_code"], row["date"], row["currency"], location.get("osm_address_country_code"),
                location.get("osm_address_city"), location.get("osm_brand"), location.get("osm_name"),
                location.get("osm_display_name"), location.get("osm_address_postcode"),
            )

    def webtruffle_rows():
        with csv_path.open(encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                location = russian_locations_by_price_id.get(row["source_price_id"], {})
                yield Observation(
                    row["product_code"], row["observed_date"], row["currency"], row["country_code"],
                    row["city"], row["retailer_brand"], row["retailer_name"],
                    location.get("osm_display_name"), location.get("osm_address_postcode"),
                )

    open_prices = summarize(open_prices_rows())
    webtruffle = summarize(webtruffle_rows())
    if webtruffle["world"]["observations"] != manifest["record_count"]:
        raise ValueError("Число записей CSV не совпадает с manifest.json WebTruffle.")
    return {
        "recipe_ingredients": len(json.loads(ingredients.read_text(encoding="utf-8"))),
        "webtruffle": {
            "edition_date": manifest["target_date"],
            "csv_sha256": manifest["files"]["retail-product-prices.csv"]["sha256"],
            **webtruffle,
        },
        "open_prices": {
            "prices_sha256": checksum(prices_path),
            "locations_sha256": checksum(locations_path),
            **open_prices,
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="Directory with downloaded CSV, manifest and JSONL files.")
    args = parser.parse_args()
    ingredients = Path(__file__).resolve().parents[1] / "site" / "data" / "ingredients.json"
    report = audit(args.directory, ingredients)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
