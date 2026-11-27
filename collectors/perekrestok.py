from .catalog import StoreCollector


class Perekrestok(StoreCollector):
    id = "perekrestok"
    name = "Перекрёсток"
    url = "https://www.perekrestok.ru/"
    hosts = ("perekrestok.ru", "www.perekrestok.ru")
