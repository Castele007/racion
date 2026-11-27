# Открытые источники розничных цен для «Рациона»

Проверка от 27 ноября 2026 года. В доступных выгрузках по Оренбургу и Оренбургской области найдено **0 наблюдений с подтверждённой географией**, в том числе по каждой из пяти сетей. Покрытие Оренбурга составляет **0 из 81 ингредиента**. Импорт в приложение не добавлен. Исходная ревизия `main` (`99b8068`) использует резервную базу с ориентирами Numbeo. Интеграция Оренбургстата в этой ревизии отсутствует. [Резервная база цен](../README.md#ориентировочные-цены)

## Результаты по источникам

| Источник | Что опубликовано | Результат проверки |
| --- | --- | --- |
| WebTruffle | Датированные релизы с CSV, JSON, JSONL и `manifest.json`. База под ODbL 1.0. | Последний доступный релиз `2026-09-01` скачан в CSV и проверен по размеру и SHA-256. Содержит наблюдения из Open Prices с метаданными Open Food Facts и OpenStreetMap. Поля наличия и срока действия предложения отсутствуют. [Релиз](https://github.com/webtruffle/retail-product-catalog-prices/releases/tag/2026-09-01) · [Лицензия базы](https://github.com/webtruffle/retail-product-catalog-prices/blob/fc5f75640873243c6eea0c9bc6d37b3ef2b44611/LICENSE-DATA.md) |
| Open-Inflation `pyaterochka_api` | Библиотека MIT. В репозитории есть тестовые снимки JSON с ответами и схемами. Готовой розничной выгрузки нет. | Каталог использует `5d.5ka.ru/api`, для новостей и акций есть отдельный `api.5ka.ru/api`. Для запуска каталога код подготавливает браузерную сессию. [Адреса и сессия](https://github.com/Open-Inflation/pyaterochka_api/blob/237658a2efe4cc62b020cc9479f9913f485d8813/pyaterochka_api/manager.py#L45) · [Лицензия](https://github.com/Open-Inflation/pyaterochka_api/blob/237658a2efe4cc62b020cc9479f9913f485d8813/LICENSE) |
| dreamcatchered `pyaterochka-mcp-tool` | MCP-сервер MIT. Готовых выгрузок и релизов с данными нет. | Использует тот же `5d.5ka.ru/api`. Документация описывает браузерную сессию или загрузку cookies. [Клиент](https://github.com/dreamcatchered/pyaterochka-mcp-tool/blob/16612026b73834b20cc99934dd5c38c7ddb01a71/pyaterochka_store_api.py#L31) · [Документация](https://github.com/dreamcatchered/pyaterochka-mcp-tool/blob/16612026b73834b20cc99934dd5c38c7ddb01a71/README.md#-cookies-нужны-ли-и-зачем) · [Лицензия](https://github.com/dreamcatchered/pyaterochka-mcp-tool/blob/16612026b73834b20cc99934dd5c38c7ddb01a71/LICENSE) |
| shi-kirill `pyaterochka-mcp` | MCP-клиент MIT. В релизах Python-пакеты. JSON в репозитории содержит пример конфигурации. | Каталог также использует `5d.5ka.ru/api`. Документированы пользовательская сессия X5ID и HTTP 403 при прямом доступе. [Конфигурация](https://github.com/shi-kirill/pyaterochka-mcp/blob/91a5db429966289b0c1409d65113dc703e1d31cf/src/pyaterochka_mcp/config.py#L14) · [Документация](https://github.com/shi-kirill/pyaterochka-mcp/blob/91a5db429966289b0c1409d65113dc703e1d31cf/README.md#L193) · [Условия лицензии](https://github.com/shi-kirill/pyaterochka-mcp/blob/91a5db429966289b0c1409d65113dc703e1d31cf/docs/LICENSING.md) |
| BZKDP `retail-price-parsers` | Код парсеров с записью JSONL/CSV. Готовых выгрузок и релизов нет. Явная лицензия на код и данные не найдена. | Для Пятёрочки заметки указывают тот же `5d.5ka.ru` и библиотеку Open-Inflation. Парсер Магнита читает HTML-карточки из карты сайта и использует региональный контекст сессии. Документация описывает обход антибот-защиты. Парсеры не запускались. [Описание](https://github.com/BZKDP/retail-price-parsers/blob/e221a3c95b0bd89870055397f989afac45923afc/README.md) · [Заметки по сетям](https://github.com/BZKDP/retail-price-parsers/blob/e221a3c95b0bd89870055397f989afac45923afc/grocery/STORE_NOTES.md) |
| Open Food Facts Open Prices API | Публичные GET в JSON и ежедневные выгрузки JSONL.gz по ценам, точкам и товарам. Код сервера AGPL-3.0, наблюдения ODbL 1.0, фото подтверждений CC BY-SA 4.0. | API без авторизации и выгрузки доступны. Запросы по названию города и радиусу 15 км дали 0 записей. Архивы цен и точек также дали 0 подтверждённых наблюдений в области. Наблюдения могут происходить из чеков, ценников или импорта, без подтверждения текущего наличия. [API](https://prices.openfoodfacts.org/api/docs) · [Выгрузки и лицензия](https://openfoodfacts.github.io/open-prices/guides/data/) · [Код экспорта](https://github.com/openfoodfacts/open-prices/blob/347c752a764135bf86ad34bb78501afc5d6e4a42/open_prices/common/export_data.py) |
| Hugging Face `openfoodfacts/open-prices` | Публичный `prices.parquet` под ODbL 1.0. В дереве датасета нет дополнительных CSV, JSON или JSONL с ценами. | Снимок того же проекта Open Prices. Доступен без входа, SHA-256 совпал с LFS `oid`. По региону записей нет. Наблюдения в пересекающихся выгрузках учитываются как данные одного источника. [Карточка датасета](https://huggingface.co/datasets/openfoodfacts/open-prices) · [Проверенная ревизия](https://huggingface.co/datasets/openfoodfacts/open-prices/tree/b243714295718f14e339e347734459650cdef0e3) |
| Шопоклик | Публичный JSON-пример. Полная городская выгрузка JSON.gz, CSV по запросу. Бесплатно для личных проектов, исследований, учёбы и СМИ с подписью «Цены: Шопоклик» и ссылкой. Передача файла третьим лицам запрещена. | Оренбург отсутствует среди заявленных 18 городов. Регулярная выдача требует заявки по электронной почте. Публичный пример относится к Новосибирску, в нём 30 товаров, 150 наблюдений и 16 названий магазинов. Есть Пятёрочка, Магнит, Лента и METRO. Перекрёстка в примере нет. [Условия и города](https://shopoclick.ru/dannye) · [Пример JSON](https://shopoclick.ru/content/dannye/primer.json) |

Три клиента Пятёрочки используют общий хост каталога `5d.5ka.ru` и поиск `/api/catalog/v3/stores/{store}/search`. Предыдущая проверка проекта зафиксировала HTTP 403 для `5ka.ru/robots.txt`. При новой проверке 403 вернули `5ka.ru/robots.txt` и `5d.5ka.ru/robots.txt`. Для `api.5ka.ru/robots.txt` пришла HTML-страница `Request Rejected` со статусом 200. Запросы к товарным маршрутам после отказа не выполнялись. MIT распространяется на код клиентов, разрешение на автоматическое получение и публикацию цен Пятёрочки не подтверждено. [Прежний запуск](https://github.com/Castele007/racion/actions/runs/46012350046) · [robots.txt каталога](https://5d.5ka.ru/robots.txt)

## География, даты и покрытие

В таблицах сначала указано число наблюдений, затем число уникальных непустых штрихкодов. Одну цену могли наблюдать несколько раз. Open Prices публикует также записи о весовых товарах без штрихкода. Сканирование использовало код страны `RU` и отдельно выделяло записи в `RUB`. Для области проверены название города, текст адреса и индексы `460xxx–462xxx`. WebTruffle публикует город и страну. Для проверки области все 453 российские строки WebTruffle сопоставлены с Open Prices по идентификатору наблюдения, затем проверены адреса точек. API дополнительно проверен по `Оренбург`, `Orenburg` и координатам центра города. [Схема WebTruffle](https://github.com/webtruffle/retail-product-catalog-prices/blob/fc5f75640873243c6eea0c9bc6d37b3ef2b44611/SCHEMA.md) · [Параметры API](https://prices.openfoodfacts.org/api/docs)

| Снимок | Мир | Россия `RU` | Россия `RU` и `RUB` | Даты наблюдений в РФ | Оренбургская область | Оренбург |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| WebTruffle `2026-09-01` | 288 006 / 135 238 | 453 / 400 | 451 / 398 | 22.12.2021–29.08.2026 | 0 / 0 | 0 / 0 |
| Open Prices JSONL.gz, скачан 27.11.2026 | 350 428 / 152 383 | 604 / 492 | 602 / 490 | 22.12.2021–23.11.2026 | 0 / 0 | 0 / 0 |
| Hugging Face Parquet, ревизия от 23.11.2026 | 349 024 / 151 837 | 602 / 491 | 600 / 489 | 22.12.2021–21.11.2026 | 0 / 0 | 0 / 0 |

В мировых снимках последние даты наблюдений соответственно 01.09.2026, 26.11.2026 и 22.11.2026. Разница в счётчиках соответствует разным датам снимков. Метаданные релиза WebTruffle описывают ежедневные выпуски. На момент проверки API GitHub помечал последним выпуск `2026-09-01`, опубликованный 02.09.2026. [Последний релиз по API](https://api.github.com/repos/webtruffle/retail-product-catalog-prices/releases/latest)

| Сеть | WebTruffle, РФ в рублях | Open Prices JSONL.gz, РФ в рублях | Hugging Face, РФ в рублях | Оренбург, любой снимок |
| --- | ---: | ---: | ---: | ---: |
| Пятёрочка | 7 / 4 | 11 / 8 | 11 / 8 | 0 / 0 |
| Магнит | 41 / 35 | 53 / 44 | 53 / 44 | 0 / 0 |
| Лента | 2 / 2 | 2 / 2 | 2 / 2 | 0 / 0 |
| Перекрёсток | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| METRO | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

Сети определены по совпадению имени или бренда с известными названиями и форматами продовольственных магазинов. 27 московских наблюдений от 28.09.2025 с вывеской «Зелёный перекрёсток» и пустым полем бренда учтены отдельно. «Магнит Косметик» исключён из продовольственного «Магнита».

## Примеры наблюдений

Все примеры относятся к указанному городу и дате. Цена в день проверки и наличие товара требуют подтверждения у магазина.

| Товар | Цена | Магазин, город и дата | Источник |
| --- | ---: | --- | --- |
| Сметана 18% | 75,79 ₽ | Магнит, Котлас, 24.08.2025 | [WebTruffle / Open Prices № 135089](https://prices.openfoodfacts.org/api/v1/prices/135089) |
| Молоко безлактозное, 930 мл | 89,00 ₽ | Пятёрочка, Голицыно, 05.10.2026 | [Open Prices № 341617](https://prices.openfoodfacts.org/api/v1/prices/341617) |
| Яйца первой категории, 10 шт. | 84,00 ₽ | Чижик, Екатеринбург, 23.11.2026 | [Open Prices № 367799](https://prices.openfoodfacts.org/api/v1/prices/367799) |
| Рис «Агро-Альянс Экстра Элитный», 900 г | 129,99 ₽ | Пятёрочка, Новосибирск, 23.11.2026 | [Цены: Шопоклик](https://shopoclick.ru/content/dannye/primer.json) |
| Молоко «Белый замок» 2,5%, 900 г | 92,99 ₽ | Магнит Экспресс, Новосибирск, 25.11.2026 | [Цены: Шопоклик](https://shopoclick.ru/content/dannye/primer.json) |

## Воспроизведение

Workflow **Open retail price audit** бесплатно скачивает публичные выгрузки на GitHub Actions. Он запускается для изменений самой проверки и вручную. Задача проверяет CSV по `manifest.json`, печатает сводку CSV и JSONL и сравнивает SHA-256 Parquet с метаданными LFS для конкретной ревизии Hugging Face. Задача использует права чтения. Потребительские аккаунты и ключи сторонних сервисов отсутствуют. У пригодных для скачивания источников пока нет подтверждённого локального покрытия, поэтому автопубликация цен из них не включена. [Workflow](../.github/workflows/open-price-audit.yml)

Проверенный CSV WebTruffle имеет размер **252 752 476 байт** и SHA-256 `a8f3be9bc3c9a8a309dce447acf42292f416a6d73af332796b41e85444032a47`. Размер и SHA-256 совпали с `manifest.json`, значения также совпали с метаданными GitHub Release. Хеш скачанного Parquet `7090383c19fb274a99de160d5d2cbf65777fc84705407cd6fb78d5113fb9a8cc` совпал с LFS `oid` ревизии `b243714295718f14e339e347734459650cdef0e3`. [Манифест WebTruffle](https://github.com/webtruffle/retail-product-catalog-prices/releases/download/2026-09-01/manifest.json) · [Parquet](https://huggingface.co/datasets/openfoodfacts/open-prices/blob/b243714295718f14e339e347734459650cdef0e3/prices.parquet)

Для локальной сводки сохраните `manifest.json`, `retail-product-prices.csv`, `locations.jsonl.gz` и `prices.jsonl.gz` в одну папку и выполните `python3 tools/audit_open_prices.py /путь/к/папке`. Сводка ограничена наблюдениями с известными географическими полями. Если в будущем появятся строки по Оренбургу, значение `ingredients_covered_in_orenburg` будет `null` до проверки соответствия ингредиентам и фасовок. [Скрипт проверки](../tools/audit_open_prices.py)

Сводка содержит данные Open Prices и Open Food Facts под ODbL 1.0, географические данные © OpenStreetMap contributors под ODbL и записи в обработке WebTruffle. Изображения чеков и ценников не использовались. [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) · [OpenStreetMap](https://www.openstreetmap.org/copyright) · [Уведомления WebTruffle об источниках](https://github.com/webtruffle/retail-product-catalog-prices/blob/fc5f75640873243c6eea0c9bc6d37b3ef2b44611/SOURCE_NOTICES.md)
