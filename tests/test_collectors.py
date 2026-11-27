from email.message import Message
import gzip
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from collectors.catalog import page_offer
from collectors.http import PublicWeb, Response, SourceError, official_url, response_text, robots_allows, robots_directives
from collectors.magnit import Magnit
from collectors.models import price_kopecks
from collectors.update import COLLECTORS, atomic_write, load_snapshot, refresh


NOW = "2026-11-27T12:00:00Z"
OLD = "2026-11-27T09:00:00Z"
URL = "https://magnit.ru/catalog/example"
INGREDIENTS = {"milk": {"unit": "ml"}}
LOCATION = {"city": "Оренбург", "id": "fixture-location", "address": "Тестовая точка", "channel": "pickup"}
ENTRY = {"id": "example-sku", "ingredientId": "milk", "packSize": 930, "unit": "ml", "url": URL}
HOSTS = ("magnit.ru",)


def html_offer(**changes):
    offer = {
        "@type": "Offer",
        "price": 94.50,
        "priceCurrency": "RUB",
        "availability": "https://schema.org/InStock",
        "availableAtOrFrom": {
            "@type": "Place", "identifier": LOCATION["id"],
            "address": {"addressLocality": LOCATION["city"], "streetAddress": LOCATION["address"]},
        },
        **changes,
    }
    product = {"@type": "Product", "sku": ENTRY["id"], "name": "Молоко 930 мл", "offers": offer}
    return Response(URL, "text/html", '<script type="application/ld+json">' + json.dumps(product) + "</script>")


def config(format_type):
    return {
        "format": format_type, "location": LOCATION,
        "authorization": {"url": "https://magnit.ru/", "note": "Тестовая запись разрешения", "verifiedAt": OLD},
    }


class FakeWeb:
    def __init__(self, result=None):
        self.result = result
        self.calls = []

    def robots(self, url):
        self.calls.append(url)
        return []

    def fetch(self, url):
        self.calls.append(url)
        if isinstance(self.result, SourceError):
            raise self.result
        return self.result


class CollectorsTest(unittest.TestCase):
    def test_all_stores_check_their_own_official_host(self):
        self.assertEqual(len(COLLECTORS), 5)
        self.assertEqual(len({kind.id for kind in COLLECTORS}), 5)
        for kind in COLLECTORS:
            with self.subTest(store=kind.id):
                web = FakeWeb()
                collector = kind(web)
                self.assertEqual(official_url(collector.url, collector.hosts), collector.url)
                self.assertIn("robots.txt проверен", collector.probe())
                self.assertEqual(web.calls, [collector.url])

    def test_missing_approval_probes_robots_without_reading_offers(self):
        web = FakeWeb()
        collector = Magnit(web)
        with self.assertRaises(SourceError) as error:
            collector.collect(None, INGREDIENTS, NOW)
        self.assertEqual(error.exception.code, "unconfigured")
        self.assertEqual(web.calls, [collector.url])
        with self.assertRaises(SourceError) as error:
            collector.collect({"format": "regional-json"}, INGREDIENTS, NOW)
        self.assertEqual(error.exception.code, "unverified_source")
        self.assertEqual(web.calls, [collector.url])

    def test_robots_and_same_origin_rules(self):
        rules = robots_directives("""
User-agent: *
Crawl-delay: 3
Disallow: /
Allow: /catalog/
Disallow: /catalog/*?private=
Disallow: /каталог/
""")
        self.assertFalse(robots_allows(rules, "https://magnit.ru/api/"))
        self.assertTrue(robots_allows(rules, "https://magnit.ru/catalog/example"))
        self.assertFalse(robots_allows(rules, "https://magnit.ru/catalog/example?private=1"))
        self.assertFalse(robots_allows(rules, "https://magnit.ru/%D0%BA%D0%B0%D1%82%D0%B0%D0%BB%D0%BE%D0%B3/item"))
        for url in ("http://magnit.ru/", "https://other.example/", "https://@magnit.ru/", "https://magnit.ru:8443/"):
            with self.subTest(url=url), self.assertRaises(SourceError):
                official_url(url, HOSTS)

    def test_robots_deny_stops_before_product_request(self):
        public = PublicWeb(HOSTS)
        public.rules["magnit.ru"] = [("disallow", "/catalog/")]
        with self.assertRaises(SourceError) as error:
            public.fetch(URL)
        self.assertEqual(error.exception.code, "robots_denied")

    def test_gzip_and_price_are_parsed_without_losing_kopecks(self):
        headers = Message()
        headers["Content-Type"] = "text/plain; charset=utf-8"
        headers["Content-Encoding"] = "gzip"
        value = "User-agent: *\nDisallow: /каталог/\n"
        self.assertEqual(response_text(gzip.compress(value.encode()), headers), value)
        self.assertEqual(price_kopecks("94,50", "RUB"), 9450)
        for invalid in (True, "от 100", "35.525", "-3", "1e3", "NaN"):
            with self.subTest(price=invalid), self.assertRaises(SourceError):
                price_kopecks(invalid, "RUB")

    def test_json_ld_verifies_sku_weight_and_regional_outlet(self):
        result = page_offer(html_offer(), ENTRY, LOCATION, INGREDIENTS, HOSTS, NOW)
        self.assertEqual((result["packSize"], result["priceKopecks"], result["sourceUrl"]), (930, 9450, URL))
        self.assertEqual(result["terms"], {"kind": "regular"})
        self.assertTrue(result["available"])
        for entry, location, response, reason in [
            ({**ENTRY, "id": "unknown"}, LOCATION, html_offer(), "product"),
            ({**ENTRY, "packSize": 1000}, LOCATION, html_offer(), "pack"),
            (ENTRY, {**LOCATION, "id": "other"}, html_offer(), "region"),
            (ENTRY, LOCATION, html_offer(availability="LimitedAvailability"), "stock"),
        ]:
            with self.subTest(reason=reason), self.assertRaises(SourceError) as error:
                page_offer(response, entry, location, INGREDIENTS, HOSTS, NOW)
            self.assertEqual(error.exception.code, reason)

    def test_json_ld_separates_qualified_promotion_and_unavailable_inventory(self):
        with_card = page_offer(html_offer(validForMemberTier={"name": "Карта"}), ENTRY, LOCATION, INGREDIENTS, HOSTS, NOW)
        self.assertEqual(with_card["terms"]["kind"], "conditional")
        missing = page_offer(html_offer(availability="https://schema.org/OutOfStock"), ENTRY, LOCATION, INGREDIENTS, HOSTS, NOW)
        self.assertFalse(missing["available"])

    def test_regional_feed_rejects_foreign_location_and_future_records(self):
        product = {**ENTRY, "name": "Молоко 930 мл", "price": "94.50", "currency": "RUB",
                   "sourceUrl": URL, "available": True, "updatedAt": OLD, "terms": {"kind": "regular"}}
        source = {**config("regional-json"), "url": "https://magnit.ru/prices-example.json"}

        def collector(region, item):
            response = Response(source["url"], "application/json", json.dumps({"location": region, "products": [item]}))
            return Magnit(FakeWeb(response))

        _, offers, _, _ = collector(LOCATION, product).collect(source, INGREDIENTS, NOW)
        self.assertEqual(offers[0]["updatedAt"], OLD)
        with self.assertRaises(SourceError) as error:
            collector({**LOCATION, "city": "Орск"}, product).collect(source, INGREDIENTS, NOW)
        self.assertEqual(error.exception.code, "region")
        with self.assertRaises(SourceError) as error:
            collector(LOCATION, {**product, "updatedAt": "2026-11-28T12:00:00Z"}).collect(source, INGREDIENTS, NOW)
        self.assertEqual(error.exception.code, "date")

    def test_failure_preserves_last_date_and_prices_and_honors_server_delay(self):
        offer = page_offer(html_offer(), ENTRY, LOCATION, INGREDIENTS, HOSTS, OLD)
        old = {"offers": [offer], "location": LOCATION, "updatedAt": OLD}
        response = SourceError("rate_limited", "Тест", "2026-11-28T12:00:00Z")
        web = FakeWeb(response)
        collector = Magnit(web)
        source = {**config("json-ld"), "priceMode": "documented-single-unit", "products": [ENTRY]}
        stale = refresh(collector, old, source, INGREDIENTS, NOW)
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(stale["updatedAt"], OLD)
        self.assertEqual(stale["offers"], [{**offer, "stale": True}])
        self.assertEqual(refresh(collector, stale, source, INGREDIENTS, "2026-11-27T15:00:00Z"), stale)
        self.assertEqual(web.calls, [URL])

    def test_partial_update_keeps_only_failed_products_from_the_same_store_address(self):
        success = page_offer(html_offer(), ENTRY, LOCATION, INGREDIENTS, HOSTS, NOW)
        failure = {**success, "sku": "failed", "updatedAt": OLD}
        old = {"offers": [failure, {**failure, "sku": "removed"}], "location": LOCATION, "updatedAt": OLD}

        class Partial(Magnit):
            def collect(self, *_args):
                return LOCATION, [success], {"failed"}, [SourceError("format", "Тест")]

        store = refresh(Partial(FakeWeb()), old, {}, INGREDIENTS, NOW)
        self.assertEqual(store["status"], "partial")
        self.assertEqual(store["offers"], [success, {**failure, "stale": True}])
        other = refresh(Partial(FakeWeb()), {**old, "location": {**LOCATION, "id": "old"}}, {}, INGREDIENTS, NOW)
        self.assertEqual(other["offers"], [success])

    def test_snapshot_write_and_wrong_schema_rejection(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary, "prices.json")
            payload = {"schemaVersion": 1, "city": "Оренбург", "stores": [{"id": "magnit", "offers": []}]}
            atomic_write(path, payload)
            self.assertEqual(load_snapshot(path), {"magnit": {"id": "magnit", "offers": []}})
            atomic_write(path, {**payload, "city": "Другой город"})
            with self.assertRaises(ValueError):
                load_snapshot(path)


if __name__ == "__main__":
    unittest.main()
