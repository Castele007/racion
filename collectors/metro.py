from .catalog import StoreCollector


class Metro(StoreCollector):
    id = "metro"
    name = "METRO"
    url = "https://online.metro-cc.ru/"
    hosts = ("online.metro-cc.ru", "metro-cc.ru", "www.metro-cc.ru")
