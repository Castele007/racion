import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from tools.audit_open_prices import Observation, summarize, verify_webtruffle


class OpenPriceAuditTest(unittest.TestCase):
    def test_manifest_rejects_a_file_with_the_same_size_and_a_different_hash(self):
        with TemporaryDirectory() as directory:
            csv_path = Path(directory) / "retail-product-prices.csv"
            manifest_path = Path(directory) / "manifest.json"
            contents = b"a,b\n"
            csv_path.write_bytes(contents)
            manifest = {
                "dataset_id": "retail-product-catalog-prices",
                "schema_version": "1.0",
                "files": {csv_path.name: {"bytes": len(contents), "sha256": hashlib.sha256(contents).hexdigest()}},
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            self.assertEqual(verify_webtruffle(manifest_path, csv_path), manifest)
            csv_path.write_bytes(b"b,a\n")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                verify_webtruffle(manifest_path, csv_path)

    def test_geography_currency_and_chain_are_counted_independently(self):
        date = "2026-11-01"
        rows = [
            Observation("01", date, "RUB", "RU", "г. Оренбург", None, "Пятёрочка"),
            Observation("01", date, "RUB", "RU", "Оренбург", "Пятёрочка", "Пятёрочка"),
            Observation("02", date, "RUB", "RU", "Орск", "Магнит", "Магнит", postcode="462400"),
            Observation("03", date, "RUB", "RU", "Москва", None, "Магнит Косметик", "Оренбургская улица, Москва"),
            Observation("04", date, "RUB", "RU", "Екатеринбург", None, "Зелёный перекрёсток"),
            Observation("05", date, "EUR", "RU", "Оренбург", None, "Лента"),
            Observation("06", date, "RUB", "KZ", "Оренбург", None, "Магнит"),
        ]
        report = summarize(rows)
        self.assertEqual(report["world"]["observations"], 7)
        self.assertEqual(report["russia"]["observations"], 6)
        self.assertEqual(report["russia_rub"]["observations"], 5)
        self.assertEqual(report["orenburg_oblast"]["observations"], 3)
        self.assertEqual(report["orenburg"]["observations"], 2)
        self.assertEqual(report["orenburg"]["distinct_barcodes"], 1)
        self.assertEqual(report["orenburg_by_chain"]["Пятёрочка"]["observations"], 2)
        self.assertEqual(report["orenburg_by_chain"]["Магнит"]["observations"], 0)
        self.assertEqual(report["russia_rub_by_chain"]["Перекрёсток"]["observations"], 0)
        self.assertIsNone(report["ingredients_covered_in_orenburg"])
        self.assertEqual(summarize(rows[2:])["ingredients_covered_in_orenburg"], 0)
