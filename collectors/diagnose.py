"""Check public catalog connectivity from the same runner that updates prices."""
from concurrent.futures import ThreadPoolExecutor
import json
from urllib.parse import urljoin

from .catalog import JsonLd, graph_items, has_type
from .http import SourceError
from .update import COLLECTORS


PUBLIC_LINKS = {
    "magnit": ("https://magnit.ru/categories", "https://magnit.ru/shops"),
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
            if isinstance(response, str):
                checks.append({"url": url, "result": response})
                continue
            observation = {"url": url, "result": response.content_type}
            if response.content_type == "text/html":
                parser = JsonLd()
                parser.feed(response.text)
                nodes = list(graph_items(parser.documents))
                observation["productNodes"] = sum(has_type(node, "Product") for node in nodes)
                observation["mentionsOrenburg"] = "оренбург" in response.text.casefold()
            checks.append(observation)
        except SourceError as error:
            checks.append({"url": url, "result": error.code, "detail": str(error)})
            if error.code in ("access_denied", "proxy_denied", "rate_limited", "robots_unavailable"):
                break
    return {"store": collector.name, "checks": checks}


if __name__ == "__main__":
    with ThreadPoolExecutor(max_workers=len(COLLECTORS)) as pool:
        print(json.dumps(list(pool.map(inspect, COLLECTORS)), ensure_ascii=False, indent=2))
