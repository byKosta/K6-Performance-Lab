# Stability suite — где остановились

_Обновлено: 2026-11-02_

## Задача
Cypress (≈1 пользователь, часами без перерыва) начинает падать через 1–2 ч: падают и `cy.visit()` (test-web),
и `cy.request()` (test-api). Нужно k6-тестами выяснить, что это: деградация со временем, объём данных,
лимиты инфраструктуры или общая точка отказа. Исходное ТЗ — в описании задачи от команды (soak / dirty vs clean / ramp / spike).

## Сделано
- [x] 4 теста написаны: `itemit-stability-soak.js`, `-data-volume.js`, `-ramp.js`, `-spike.js` + общий `lib/`.
- [x] Теги `name` + `target: api|frontend`, ошибки по типам (`timeout/network/429/5xx/401/4xx`) с минутой первого появления.
- [x] Таблица трендов в stdout (p95/p99 по окнам / шагам / фазам, отношение последнего окна к первому).
- [x] Защита от прода (`web.itemit.com` / `api.itemit.com` → скрипт не стартует).
- [x] Уборка: префикс `k6-stab-`, удаление в итерации + sweep в teardown.
- [x] Проверено только `k6 inspect` (парсинг/опции). **Ни один тест ещё не запускался.**

## Не сделано / блокеры
- [ ] **Сверить эндпоинты в Network** на test-web: collections, locations, reports, bookings, reminders + их поиск
      (`verified: false` в `lib/config.js`). Сейчас это догадки.
- [ ] **Тело PATCH архивации item** из Network → `-e ITEM_ARCHIVE_BODY='...'`.
- [ ] Создание/удаление collections, locations, reports, bookings, reminders — не добавлено (нужны эндпоинты).
- [ ] Отдельный воркспейс для soak/ramp/spike (`WORKSPACE_ID`) и пустой для data-volume (`CLEAN_WORKSPACE_ID`).
- [ ] **Rate limit 100 req/min на API key** (из `security/itemit-rate-limit.js`): ramp 10–20 VU и spike упрутся в 429.
      Договориться с разработчиками о повышении/whitelist на test, иначе меряем лимит, а не сервер.
- [ ] Доступ к серверным метрикам (CPU, память, соединения с БД, рестарты) — спросить у DevOps, где смотреть.
- [ ] Grafana: локальный стек сломан (см. ниже), нужно чинить или переходить на Grafana Cloud.
- [x] Безопасность: API key вынесен из кода в `.env` (gitignored, шаблон `.env.example`), в git его нет.
      Токен убран из remote URL, git ходит через `gh auth`.
- [ ] **Отозвать старый GitHub PAT `ghp_ig2v…`** на github.com → Settings → Developer settings → Tokens (сделать вручную).

## Состояние Grafana (проверено 2026-11-02)
- `docker-compose.yml`: InfluxDB **1.8**, а datasource в `grafana/provisioning` настроен на **Flux** (InfluxDB 2.x) — несовместимо.
- `grafana/provisioning` не примонтирован в контейнер Grafana.
- `dashboards/k6.yml` содержит datasource вместо dashboard-провайдера; `k6-latest.json` пустой (0 панелей).
- Варианты: (a) починить локально — InfluxQL datasource + готовый дашборд k6 (ID 2587 / 14801);
  (b) встроенный `K6_WEB_DASHBOARD=true` (без установки); (c) Grafana Cloud free.

## Следующие шаги (по порядку)
1. Network → поправить `lib/config.js`, `ITEM_ARCHIVE_BODY`.
2. Smoke soak: `-e DURATION_MIN=5 -e WINDOW_MIN=1 -e VUS=1` — проверить, что всё зелёное и мусор убирается.
3. Выбрать и настроить визуализацию (см. «Состояние Grafana»).
4. Полный soak 3 ч в окно без Cypress; параллельно снимать серверные метрики.
5. data-volume → затем ramp и spike (предупредить команду).
