"""Check public catalog connectivity from the same runner that updates prices."""
from concurrent.futures import ThreadPoolExecutor
import json
from urllib.parse import urljoin

from .http import SourceError
from .update import COLLECTORS


PUBLIC_LINKS = {
    "magnit": ("https://magnit.ru/categories",),
    "metro": ("https://online.metro-cc.ru/sitemap.xml",),
}


def inspect(collector_type):
    collector = collector_type()
    checks = []
    endpoints = [(urljoin(collector.url, "robots.txt"), collector.probe)]
    endpoints.extend((url, lambda url=url: collector.web.fetch(url))
                     for url in (collector.url, *PUBLIC_LINKS.get(collector.id, ())))
    for url, check in endpoints:
        try:
            response = check()
            checks.append({"url": url, "result": response if isinstance(response, str)
                           else response.content_type})
        except SourceError as error:
            checks.append({"url": url, "result": error.code, "detail": str(error)})
            if error.code in ("access_denied", "proxy_denied", "rate_limited", "robots_unavailable"):
                break
    return {"store": collector.name, "checks": checks}


if __name__ == "__main__":
    with ThreadPoolExecutor(max_workers=len(COLLECTORS)) as pool:
        print(json.dumps(list(pool.map(inspect, COLLECTORS)), ensure_ascii=False, indent=2))
