from .catalog import StoreCollector


class Lenta(StoreCollector):
    id = "lenta"
    name = "Лента"
    url = "https://lenta.com/"
    hosts = ("lenta.com", "www.lenta.com")
