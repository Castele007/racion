from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import gzip
from http.client import HTTPException
from io import BytesIO
import re
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


BOT = "RacionPriceBot"
AGENT = f"{BOT}/1.0 (https://github.com/Castele007/racion)"
MAX_BYTES = 4 * 1024 * 1024
REDIRECT_CODES = {301, 302, 303, 307, 308}
STOP_CODES = {"proxy_denied", "access_denied", "rate_limited", "network", "robots_unavailable"}


class SourceError(Exception):
    def __init__(self, code, message, retry_at=None):
        super().__init__(message)
        self.code = code
        self.retry_at = retry_at


def official_url(url, hosts):
    try:
        parts = urlsplit(url)
        allowed = (
            parts.scheme == "https" and parts.hostname in hosts
            and parts.username is None and parts.password is None and not parts.fragment
            and parts.port in (None, 443)
            and 0 < len(url) <= 2500 and not any(char.isspace() for char in url)
        )
    except (ValueError, TypeError, AttributeError):
        allowed = False
    if not allowed:
        raise SourceError("url_scope", "URL вне разрешённых HTTPS-доменов магазина.")
    return url


def comparable_path(text):
    """RFC 9309 uses percent-encoded UTF-8 and decodes encoded unreserved bytes."""
    path = quote(text, safe="/?&=~!$'()*+,;:@-%")

    def normalize(match):
        code = int(match[0][1:], 16)
        character = chr(code)
        unreserved = character.isascii() and (character.isalnum() or character in "-._~")
        return character if unreserved else match[0].upper()

    return re.sub(r"%[0-9a-fA-F]{2}", normalize, path)


def robots_directives(text):
    groups = []
    agents, rules = [], []
    for raw in text.splitlines():
        key, sep, value = raw.split("#", 1)[0].partition(":")
        if not sep:
            continue
        key, value = key.strip().lower(), value.strip()
        if key == "user-agent" and value:
            if rules:
                groups.append((agents, rules))
                agents, rules = [], []
            agents.append(value.lower())
        elif agents and key in {"allow", "disallow", "crawl-delay"} and value:
            rules.append((key, value))
    if agents:
        groups.append((agents, rules))
    specific = [rules for agents, rules in groups if BOT.lower() in agents]
    return [rule for group in (specific or [rules for agents, rules in groups if "*" in agents]) for rule in group]


def retry_time(value):
    if not value:
        return None
    try:
        if value.isdecimal():
            date = datetime.now(timezone.utc) + timedelta(seconds=int(value))
        else:
            date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            return None
        return date.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    except (ValueError, TypeError, OverflowError):
        return None


def response_text(raw, headers):
    encoding = headers.get("Content-Encoding", "").lower()
    if encoding == "gzip" or raw.startswith(b"\x1f\x8b"):
        try:
            with gzip.GzipFile(fileobj=BytesIO(raw)) as archive:
                raw = archive.read(MAX_BYTES + 1)
        except (OSError, EOFError) as error:
            raise SourceError("format", "Не удалось распаковать ответ источника.") from error
    elif encoding not in ("", "identity"):
        raise SourceError("format", "Источник использует неподдерживаемый формат сжатия.")
    if len(raw) > MAX_BYTES:
        raise SourceError("size", "Ответ источника превышает допустимый размер.")
    try:
        return raw.decode(headers.get_content_charset("utf-8"), errors="strict").lstrip("\ufeff")
    except (LookupError, UnicodeDecodeError) as error:
        raise SourceError("format", "Не удалось прочитать текст ответа источника.") from error


def robots_allows(rules, url):
    parts = urlsplit(url)
    path = comparable_path((parts.path or "/") + (f"?{parts.query}" if parts.query else ""))
    longest = (0, True)
    for directive, raw_pattern in rules:
        if directive not in ("allow", "disallow"):
            continue
        pattern = comparable_path(raw_pattern)
        anchored = pattern.endswith("$")
        if anchored:
            pattern = pattern[:-1]
        matcher = "^" + ".*".join(re.escape(segment) for segment in pattern.split("*"))
        if anchored:
            matcher += "$"
        if re.search(matcher, path):
            longest = max(longest, (len(pattern.replace("*", "")), directive == "allow"))
    return longest[1]


@dataclass(frozen=True)
class Response:
    url: str
    content_type: str
    text: str


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class PublicWeb:
    def __init__(self, hosts):
        self.hosts = frozenset(hosts)
        self.opener = build_opener(NoRedirect())
        self.rules = {}
        self.last_request = 0
        self.delay = 1.0

    def _get(self, url, *, product_request=False):
        for _ in range(4):
            official_url(url, self.hosts)
            if product_request:
                rules = self.robots(url)
                if not robots_allows(rules, url):
                    raise SourceError("robots_denied", "Путь к данным закрыт для автоматических запросов в robots.txt.")
            time.sleep(max(0, self.delay - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()
            request = Request(url, headers={"User-Agent": AGENT, "Cache-Control": "no-cache", "Accept-Encoding": "gzip"})
            try:
                with self.opener.open(request, timeout=12) as remote:
                    raw = remote.read(MAX_BYTES + 1)
                    if len(raw) > MAX_BYTES:
                        raise SourceError("size", "Ответ источника превышает допустимый размер.")
                    body = response_text(raw, remote.headers)
                    return Response(url, remote.headers.get_content_type(), body)
            except HTTPError as error:
                status = error.code
                location = error.headers.get("Location")
                retry_at = retry_time(error.headers.get("Retry-After"))
                error.close()
                if status in REDIRECT_CODES and location:
                    url = urljoin(url, location)
                    continue
                if status in (401, 403, 451):
                    raise SourceError("access_denied", f"Источник ограничил доступ (HTTP {status}).") from error
                if status == 429:
                    raise SourceError("rate_limited", "Источник ограничил частоту запросов (HTTP 429).", retry_at) from error
                if status == 503 and retry_at:
                    raise SourceError("rate_limited", "Источник временно недоступен (HTTP 503 с Retry-After).", retry_at) from error
                raise SourceError(f"http_{status}", f"Источник ответил HTTP {status}.") from error
            except (URLError, TimeoutError, socket.timeout, OSError, HTTPException) as error:
                if "tunnel connection failed: 403" in str(error).lower():
                    raise SourceError("proxy_denied", "Прокси среды отклонил CONNECT (403) до связи с магазином.") from error
                raise SourceError("network", "Не удалось установить проверенное HTTPS-соединение с магазином.") from error
        raise SourceError("redirect", "Источник вернул слишком много перенаправлений.")

    def robots(self, url):
        endpoint = urlsplit(official_url(url, self.hosts))
        host = endpoint.hostname
        if host in self.rules:
            return self.rules[host]
        try:
            result = self._get(f"https://{host}/robots.txt")
        except SourceError as error:
            if error.code in ("http_404", "http_410"):
                # No robots file. A reviewed authorization is still required by the collector.
                self.rules[host] = []
                return self.rules[host]
            if error.code in STOP_CODES:
                raise
            raise SourceError("robots_unavailable", "Не удалось проверить правила robots.txt магазина.") from error
        if result.content_type not in ("text/plain", "application/octet-stream") or result.text.lstrip().startswith("<"):
            raise SourceError("robots_unavailable", "Вместо robots.txt магазин вернул ответ другого формата.")
        directives = robots_directives(result.text)
        for name, value in directives:
            if name == "crawl-delay":
                try:
                    delay = float(value)
                    if not 0 <= delay <= 30:
                        raise ValueError("crawl delay outside the scheduled budget")
                except ValueError as error:
                    raise SourceError("robots_unavailable", "Crawl-delay источника нельзя соблюсти в расписании.") from error
                self.delay = max(self.delay, delay)
        self.rules[host] = directives
        return self.rules[host]

    def fetch(self, url):
        return self._get(url, product_request=True)
