from .catalog import StoreCollector


class Magnit(StoreCollector):
    id = "magnit"
    name = "Магнит"
    url = "https://magnit.ru/"
    hosts = ("magnit.ru", "www.magnit.ru")
