"""Update the public regional price snapshot with verified observations only."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import tempfile

from .http import SourceError
from .lenta import Lenta
from .magnit import Magnit
from .metro import Metro
from .models import CITY, iso_now
from .perekrestok import Perekrestok
from .pyaterochka import Pyaterochka


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "site" / "data"
COLLECTORS = (Pyaterochka, Magnit, Lenta, Perekrestok, Metro)
SCHEMA_VERSION = 1


def failure(error):
    return {"code": error.code, "message": str(error), **({"retryAt": error.retry_at} if error.retry_at else {})}


def refresh(collector, previous, config, ingredients, checked_at):
    retry_at = (previous.get("error") or {}).get("retryAt")
    if retry_at and retry_at > checked_at:
        return previous
    store = {"id": collector.id, "name": collector.name, "url": collector.url, "checkedAt": checked_at}
    old_offers = previous.get("offers", [])
    try:
        location, offers, failed_ids, errors = collector.collect(config, ingredients, checked_at)
        if not offers:
            if errors:
                raise errors[0]
            raise SourceError("empty", "Источник не вернул ни одной подтверждённой цены.")
    except SourceError as error:
        return {
            **store,
            "location": previous.get("location"),
            "status": "stale" if old_offers else "unavailable",
            "updatedAt": previous.get("updatedAt"),
            "error": failure(error),
            "offers": [{**offer, "stale": True} for offer in old_offers],
        }

    retain = [{**offer, "stale": True} for offer in old_offers if offer["sku"] in failed_ids]
    if previous.get("location") != location:
        retain = []
    combined = sorted(offers + retain, key=lambda offer: offer["sku"])
    retry_error = next((error for error in errors if error.retry_at), None)
    problem = failure(retry_error or errors[0]) if errors else None
    if problem and len(failed_ids) > 1:
        problem["message"] += f" Позиций без обновления: {len(failed_ids)}."
    return {
        **store,
        "location": location,
        "status": "partial" if errors else "fresh",
        "updatedAt": max(offer["updatedAt"] for offer in offers),
        "error": problem,
        "offers": combined,
    }


def load_snapshot(path):
    if not path.exists():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schemaVersion") != SCHEMA_VERSION or value.get("city") != CITY:
        raise ValueError("existing snapshot has the wrong schema or city")
    stores = value.get("stores")
    if not isinstance(stores, list) or any(not isinstance(store, dict) or not isinstance(store.get("offers"), list) for store in stores):
        raise ValueError("existing snapshot has malformed store data")
    result = {store["id"]: store for store in stores}
    if len(result) != len(stores):
        raise ValueError("existing snapshot contains duplicate stores")
    return result


def atomic_write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.close()
            temporary.chmod(0o644)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def probe(collector):
    try:
        return {"id": collector.id, "url": collector.url, "status": "needs_verification", "reason": collector.probe()}
    except SourceError as error:
        return {"id": collector.id, "url": collector.url, "status": "unavailable", "error": failure(error)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true", help="check robots.txt without writing prices")
    parser.add_argument("--sources", type=Path, help="authorized source definitions in JSON")
    parser.add_argument("--output", type=Path, default=DATA / "prices.json")
    args = parser.parse_args(argv)
    collectors = [kind() for kind in COLLECTORS]
    try:
        with ThreadPoolExecutor(max_workers=len(collectors)) as pool:
            if args.probe:
                results = list(pool.map(probe, collectors))
                print(json.dumps(results, ensure_ascii=False, indent=2))
                return 0
            config_text = args.sources.read_text(encoding="utf-8") if args.sources else os.environ.get("CATALOG_SOURCES_JSON", "{}")
            configs = json.loads(config_text or "{}")
            if not isinstance(configs, dict) or set(configs) - {collector.id for collector in collectors}:
                raise ValueError("catalog configuration has an unknown store")
            ingredients = json.loads((DATA / "ingredients.json").read_text(encoding="utf-8"))
            old = load_snapshot(args.output)
            checked_at = iso_now()

            def fetch(collector):
                return refresh(collector, old.get(collector.id, {}), configs.get(collector.id), ingredients, checked_at)

            stores = list(pool.map(fetch, collectors))
        atomic_write(args.output, {"schemaVersion": SCHEMA_VERSION, "city": CITY, "stores": stores})
    except (ValueError, OSError, KeyError) as error:
        print(f"Price snapshot not written: {type(error).__name__}. Check the source definitions and existing JSON.", file=sys.stderr)
        return 1
    for store in stores:
        error = store["error"]
        print(f'{store["name"]}: {store["status"]}, {len(store["offers"])} offers' +
              (f' ({error["code"]}: {error["message"]})' if error else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
