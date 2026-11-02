# itemit stability suite (почему падает Cypress через 1–2 часа)

> 📌 Текущий статус и следующие шаги — [STATUS.md](STATUS.md)

> ⚠️ **Только test-web / test-api.** Скрипты сами откажутся стартовать на `web.itemit.com` / `api.itemit.com`.
> Перед ramp и spike предупредите команду и убедитесь, что Cypress в это время не запущен.

| Файл | Сценарий | Длительность | Что отвечает |
|---|---|---|---|
| `itemit-stability-soak.js` | 1–3 VU, типичный Cypress-тест в цикле | 3 ч | Растёт ли время ответа со временем, с какой минуты начинаются ошибки |
| `itemit-stability-data-volume.js` | Одни и те же списки/поиск в «грязном» и пустом воркспейсе | 20 мин | Виноват ли объём данных |
| `itemit-stability-ramp.js` | 1 → 5 → 10 → 20 VU по 10 мин | 40 мин | Запас прочности: при какой нагрузке начинается деградация |
| `itemit-stability-spike.js` | 1 VU → 25 VU на 2 мин → 1 VU | 22 мин | Восстанавливается ли сервер сам |

Рекомендуемый порядок: **soak → data-volume → ramp → spike**.

## Одна итерация (soak / ramp / spike)

login → `/items` (HTML + JS/CSS) → items/item-profiles lists → поиск items → `/reports` → reports list →
`/collections` → collections list → поиск → `/locations` → locations list → поиск → `/bookings` →
bookings pending + reminders → создать item → открыть → PATCH (архивация) → DELETE.
Пауза 1–3 с между шагами. Все созданные items имеют префикс `k6-stab-`; в teardown остатки удаляются.

## Перед первым запуском: сверить эндпоинты

В `lib/config.js` пути с `verified: false` (collections, locations, reports, bookings, reminders, их поиск) —
**догадки**. Сверьте их с вкладкой Network на test-web и поправьте. Если путь неверный (404/405),
setup выведет предупреждение и пропустит этот запрос, тест не сломается.

Тело запроса архивации тоже возьмите из Network и передайте: `-e ITEM_ARCHIVE_BODY='{"archived":true}'`.
Без него PATCH просто обновляет description.

## Запуск

Для трендов поднимите InfluxDB + Grafana (`docker-compose up -d`) и добавьте `--out influxdb=http://localhost:8086/k6`.

```bash
# 1. Soak: 2 VU × 3 ч, логин на каждой итерации (как в Cypress)
k6 run --out influxdb=http://localhost:8086/k6 \
  -e EMAIL=... -e PASSWORD=... -e WORKSPACE_ID=<отдельный воркспейс> \
  tests/itemit/stability/itemit-stability-soak.js
#   VUS=1..3, DURATION_MIN=180, WINDOW_MIN=30, LOGIN_MODE=iteration|vu
#   Smoke-проверка скрипта: -e DURATION_MIN=5 -e WINDOW_MIN=1 -e VUS=1

# 2. Грязный vs чистый воркспейс (только чтение)
k6 run -e EMAIL=... -e PASSWORD=... \
  -e DIRTY_WORKSPACE_ID=<Team> -e CLEAN_WORKSPACE_ID=<пустой> \
  [-e CLEAN_EMAIL=... -e CLEAN_PASSWORD=...] \
  tests/itemit/stability/itemit-stability-data-volume.js

# 3. Ramp: STEPS=1,5,10,20  STEP_MIN=10
k6 run --out influxdb=http://localhost:8086/k6 -e EMAIL=... -e PASSWORD=... -e WORKSPACE_ID=... \
  tests/itemit/stability/itemit-stability-ramp.js

# 4. Spike: SPIKE_VUS=25  SPIKE_MIN=2  BASELINE_MIN=5
k6 run --out influxdb=http://localhost:8086/k6 -e EMAIL=... -e PASSWORD=... -e WORKSPACE_ID=... \
  tests/itemit/stability/itemit-stability-spike.js
```

Общие переменные: `BASE_URL` (по умолчанию `https://test-api.itemit.com`), `FRONT_URL` (`https://test-web.itemit.com`),
`HTTP_TIMEOUT` (`30s`, как `responseTimeout` в Cypress), `FE_ASSETS=false` — не качать JS/CSS-бандлы,
`SEARCH_TERMS` (`test name,a,k6`).

## Что смотреть в результатах

- **Таблица трендов** в конце stdout: p95/p99 API и фронтенда по окнам (soak), шагам (ramp) или фазам (spike),
  а также отношение «последнее окно / первое окно». Рост ×1.5 и больше — повод идти к разработчикам.
- **Ошибки по типам**: `errors{type:timeout|network|429|5xx|401|4xx}` и отдельно `errors{target:api|frontend}`.
  Первые случаи каждого типа логируются с минутой теста: `[+73m] VU1 TIMEOUT items_list ...`.
- **По каждому запросу**: `http_req_duration{name:...}` (p95/p99) в summary и в Grafana.
- Отчёты: `reports/itemit-stability-*.html` и `.json`.

Как читать:
- API и frontend деградируют **одновременно** → общая точка отказа (БД, сеть, машина).
- Только `429` → rate limit. По `itemit-rate-limit.js` лимит 100 req/min на API key; ramp на 10–20 VU
  почти наверняка в него упрётся. Обсудите с разработчиками повышение лимита на test, иначе ramp измерит лимит, а не сервер.
- `timeout`/`network` без 5xx → idle-таймауты прокси/балансировщика или исчерпание пула соединений.
- Soak с 1–3 VU воспроизвёл проблему → падает даже при нагрузке одного пользователя. Это главный аргумент.

## Метрики сервера за то же время (без них непонятно «почему»)

Запишите время старта/конца теста и снимите за этот интервал:
- CPU и память API- и фронт-контейнеров (растёт ли память монотонно);
- активные соединения к БД / размер пула, медленные запросы БД;
- рестарты контейнеров/подов (`kubectl get pods` → RESTARTS, `docker ps` → uptime);
- логи прокси/балансировщика: 502/504, idle timeout.
