# «Телеметрия Поездки» — Техническая документация

**Продукт:** Телеметрия Поездки (Telemetria Poedzok) — PWA-платформа записи и анализа телеметрии автомобильных поездок.
**Продакшен:** https://telemetria-poedzok.onrender.com
**Репозиторий:** https://github.com/markovsaratov-crypto/telemetria-poedzok (ветка `main`)
**Версия приложения:** 2.19.0 (единый источник — `package.json`; `/health` всегда отдаёт её)
**Документ:** полная техническая документация для передачи в управление технической поддержке и администратору. Описывает текущее состояние системы «как есть», без истории изменений.

---

## Содержание

1. [Общие сведения](#1-общие-сведения)
2. [Функциональные возможности](#2-функциональные-возможности)
3. [Архитектура системы](#3-архитектура-системы)
4. [Технологический стек](#4-технологический-стек)
5. [Развёртывание (production)](#5-развёртывание-production)
6. [Конфигурация: переменные окружения](#6-конфигурация-переменные-окружения)
7. [База данных](#7-база-данных)
8. [Безопасность и авторизация](#8-безопасность-и-авторизация)
9. [Справочник HTTP API](#9-справочник-http-api)
10. [Конвейеры обработки данных](#10-конвейеры-обработки-данных)
11. [Метрики и методология](#11-метрики-и-методология)
12. [Фронтенд](#12-фронтенд)
13. [Наблюдаемость](#13-наблюдаемость)
14. [Резервное копирование и восстановление](#14-резервное-копирование-и-восстановление)
15. [Runbook: типовые операции и инциденты](#15-runbook-типовые-операции-и-инциденты)
16. [Локальная разработка и тестовый контур](#16-локальная-разработка-и-тестовый-контур)
17. [Известные ограничения и осознанные решения](#17-известные-ограничения-и-осознанные-решения)
18. [Структура репозитория](#18-структура-репозитория)
19. [Глоссарий](#19-глоссарий)

---

## 1. Общие сведения

«Телеметрия Поездки» — веб-платформа для сбора, хранения и анализа телеметрии автомобильных поездок. Источник данных — мобильное приложение **Sensor Logger** (iOS), которое отправляет батчи GPS-точек (и показания других сенсоров) на HTTP-эндпоинт инжеста. Сервер сохраняет точки, строит по ним производные метрики (дистанция, активное окно поездки, скоростной профиль, плавность вождения, план-факт против маршрутизации 2GIS/OSRM и др.) и отображает их в аналитическом UI.

Ключевые свойства:

- **Single-user продукт по умолчанию**: один вход по паролю (LOGIN_PASSWORD); multi-user-аккаунты поддерживаются архитектурно (bcrypt + per-user apiKey), но регистрация закрыта (`REGISTRATION_ENABLED=false`).
- **Идемпотентный инжест**: повторные HTTP-ретраи мобильного приложения не создают дубликатов ни сессий, ни GPS-точек.
- **Асинхронный пайплайн маршрутизации**: для каждой поездки создаётся задача TrafficJob, которую обрабатывает встроенный воркер (цепочка провайдеров 2GIS → OSRM → гаверсинус с кэшем и circuit breaker).
- **Развёртывание**: один Render-сервис (Next.js) + 5 cron-сервисов Render + управляемая БД Turso (libSQL). Внешняя инфраструктура минимальна.
- **PWA**: офлайн-страница, service worker, мобильная версия `/m`.

## 2. Функциональные возможности

### Приём данных (ingest)

- POST-эндпоинты для двух форматов: канонический JSON (`/api/ingest`) и нативный формат Sensor Logger (`/api/ingest/sensorlogger`).
- Толерантный парсер: распознаёт координаты в контейнерах `location`/`coords`/`position`/`gps`, массивы точек в корне/`points`/`data`/`records`/`samples`/`locations`/`entries`/`batches`/`payload`, время в наносекундах/миллисекундах/секундах/ISO-строках, маркеры «нет GPS-фикса» (`lat=-1, lon=-1`) отбрасываются.
- Фильтр качества: точки с `accuracy > 100 м` отбрасываются с подсчётом.
- Диагностика канала приёма: каждая авторизованная попытка логируется в трейс (последняя + 20 последних), исходы `accepted/empty/no_gps/dropped_all/invalid/duplicate`, образец структуры и полный дамп нераспознанного батча (до 64 КБ, TTL 24 ч) — видно в админ-панели (L1) и `GET /api/stats`.

### Аналитика

- Дашборд: всего поездок/точек/маршрутов, «сегодня» в таймзоне клиента, спарклайн 7 дней, тепловая карта 12 недель, рекорд скорости, лидерборд устройств, облако тегов.
- Период-агрегат «Аналитика → период»: батч-запросы статов/events/track по всем сессиям периода (3 запроса вместо десятков).
- «Поездки»: список записей с курсорной пагинацией, карточки с KPI, геокодированные адреса конечных точек, склейка кусков одной поездки в UI-группы.
- 62 метрики методологии (см. §11 и `docs/METHODOLOGY.md`): дистанция/длительность (сырая и активная), MovingTime state machine, спидограмма, EcoScore с корпусной калибровкой, G-G-физика (манёвры/резкие события), план-факт (маршрутизация), сравнительные метрики маршрутов (Theil-Sen тренд, P75-хотспоты, trafficPattern).

### Управление данными

- Заметки и теги на сессию; глобальный поиск по deviceId/notes/tags.
- Soft-delete сессий (deletedAt) + retention (grace 30 дней → purge).
- Экспорт сессии: GPX / KML / JSON (синхронно до 5000 точек, асинхронно свыше — ExportJob со статусом и скачиванием в течение 24 ч).
- Импорт: CSV (до 20 МБ на файл) и ZIP-архивы с защитой от zip-бомб (по фактическому размеру распаковки).
- Публичные share-ссылки на поездку: HMAC-токен, срок 1 ч – 1 год (по умолчанию 7 дней), страница `/shared/<token>`.

### Администрирование

- Вкладка «АДМИН»: L1 «Состояние системы» (health, метрики, канал приёма, джобы, бэкапы, алерты), настройки (allow-list), requeue dead-джобов, ручной бэкап (в GitHub-релиз), changelog.
- Полный аудит действий (`AuditLog`).
- Алерты: 6 правил, оценка каждые 5 минут, Slack-вебхук (опционально).

## 3. Архитектура системы

### 3.1. Компонентная схема

```
                    ┌────────────────────────────────────────────────┐
                    │                  RENDER (web)                   │
 Sensor Logger ────►│  Next.js 16 (App Router)                       │
 (iOS, батчи GPS)   │  ├── src/proxy.ts — гейт всех запросов          │
                    │  │   (payload guard, CORS, rate-limit, auth,    │
                    │  │    security headers, requestId, метрики)     │
                    │  ├── /api/* — 45+ REST-эндпоинтов               │
                    │  └── instrumentation.ts → worker-runtime.ts     │
                    │        (in-process воркер, один процесс)         │
                    └───────┬────────────────────────────┬────────────┘
                            │ Prisma + @libsql/client    │ fetch (routing)
                            ▼                            ▼
                    ┌──────────────────┐        ┌──────────────────────┐
                    │  Turso (libSQL)  │        │ Внешние провайдеры:   │
                    │  tele-…turso.io  │        │ 2GIS (или через CF    │
                    │  11 таблиц       │        │ Worker-прокси), OSRM, │
                    └──────────────────┘        │ Nominatim (геокод)    │
                                                └──────────────────────┘
                    ┌────────────────────────────────────────────────┐
                    │   RENDER cron (5 сервисов, Bearer CRON_SECRET)  │
                    │  retention 03:00 UTC · alerts */5 · backup 03:30│
                    │  github-backup ВС 04:00 · finalize-sessions */5 │
                    └────────────────────────────────────────────────┘
                    ┌────────────────────────────────────────────────┐
                    │  GitHub: репозиторий (деплой по push в main) +  │
                    │  draft-релизы (бэкапы БД и кода — приватные)    │
                    └────────────────────────────────────────────────┘
```

### 3.2. Поток данных поездки

1. **Инжест.** Sensor Logger шлёт батч → `/api/ingest/sensorlogger` (токен INGEST_TOKEN). Создаётся/продолжается сессия `recording`; точки пишутся в `GpsPoint` (BigInt timestamp в мс).
2. **Финализация.** Разрыв > 60 с между батчами → предыдущая сессия закрывается (`completed`), атомарно создаётся `TrafficJob` (pending). Ту же работу делают cron finalize-sessions (каждые 5 мин) и «жнец» в воркере — финализация идемпотентна.
3. **Маршрутизация.** In-process воркер опрашивает `TrafficJob` каждые 5 с, атомарно захватывает (UPDATE…RETURNING), прогоняет цепочку 2GIS → OSRM → гаверсинус(40 км/ч), кладёт результат (полилайн, длительность по трафику) в `TrafficJob.result` (кэш — `RouteCache`).
4. **Метрики.** `GET /api/sessions/[id]/stats` (и батч-вариант `/api/stats/batch`) считаются на лету по точкам + план-факт из результата TrafficJob. Единый конвейер `src/lib/session-stats.ts` — идентичен для поштучного и батч-роута.
5. **UI.** React/TanStack Query: префетч батча на корне лейаута → мгновенное открытие «Поездок» из кэша; TTL-кэш 30 с на сервере для батчей.

### 3.3. Состав процесса продакшена

Ровно один Node-процесс (web-сервис Render): Next.js-сервер + in-process воркер + общий реестр метрик (globalThis). Отдельный внешний воркер (`mini-services/worker`, Bun, порт 3001) существует в репозитории как альтернатива для self-hosted развёртываний — в продакшене НЕ используется.

## 4. Технологический стек

| Слой | Технология |
|---|---|
| Фреймворк | Next.js 16 (App Router, proxy.ts в Node-runtime) |
| Язык | TypeScript 5 (strict, `noImplicitAny: true`) |
| UI | React 19, Tailwind CSS 4, shadcn/ui (New York), Lucide, Framer Motion, Sonner |
| Карта/графики | Leaflet + react-leaflet 5, Recharts 2 |
| Серверное состояние клиента | TanStack Query 5 (staleTime 30 с, батч-хуки, посев кэша) |
| БД | Turso (libSQL, SQLite-диалект), Prisma 6.19.2 + `@prisma/adapter-libsql` + `@libsql/client` 0.17 (прямые SQL там, где Prisma-обёртка ограничена) |
| Валидация | Zod 4 (все тела/квери-параметры API) |
| Крипто | WebCrypto HMAC (cookie/share), node:crypto (timing-safe, sha256 бэкапов), bcryptjs 3 |
| Воркер | in-process (instrumentation.ts), p-limit 7 для конкурентности |
| PWA | service worker (`public/sw.js`), manifest, offline.html |
| Инфраструктура | Render (web + 5 cron), GitHub (код, бэкап-релизы), Turso |
| Опционально | Cloudflare Worker как прокси к 2GIS (`cloudflare-worker/worker.js`, PROXY_SECRET) |

## 5. Развёртывание (production)

### 5.1. Сервисы Render (см. `render.yaml`)

| Сервис | Тип/план | Расписание (UTC) | Что делает |
|---|---|---|---|
| `telemetria-poedzok` | web, node, free, frankfurt | — | приложение; health `/health`; autoDeploy: true |
| `telemetria-retention-cron` | cron, starter | `0 3 * * *` | POST `/api/cron/retention` (чистка по retention/grace) |
| `telemetria-alerts-cron` | cron, starter | `*/5 * * * *` | POST `/api/cron/alerts` (оценка алертов) |
| `telemetria-backup-cron` | cron, starter | `30 3 * * *` | POST `/api/admin/backup` (логический дамп) |
| `telemetria-github-backup-cron` | cron, starter | `0 4 * * 0` (вс) | POST `/api/admin/backup/github` (дамп → draft-релиз GitHub) |
| `telemetria-finalize-sessions-cron` | cron, starter | `*/5 * * * *` | POST `/api/cron/finalize-sessions` |

Все кроны шлют `Authorization: Bearer $CRON_SECRET` и требуют `BASE_URL` (значения задаются в дашборде Render, `sync: false`).

### 5.2. Процесс деплоя

1. Изменения коммитятся в `main` репозитория `markovsaratov-crypto/telemetria-poedzok`.
2. Push → Render авто-деплой (autoDeploy: true), ~3–5 минут: `npm install && DATABASE_URL="file:./db/local.db" npm run build`, затем `npx next start -p $PORT`.
3. Проверка: `GET /health` → `{"status":"ok","db":"ok","worker":"ok","version":"…"}`; далее smoke-проверка UI (логин, вкладки).

Сборка использует локальную SQLite-заглушку (`file:./db/local.db`) — на этапе build БД не нужна; в рантайме используется Turso.

### 5.3. Особенности free-плана

- Холодный старт: после ~15 мин простоя инстанс засыпает; первый запрос ждёт пробуждения до ~50 с. Смягчение: внешний пинг на `/api/keepalive` (публичный) или повышение плана.
- `/tmp` (в т.ч. каталог бэкапов `/tmp/backups`) эфемерен — очищается при каждом деплое/рестарте.

## 6. Конфигурация: переменные окружения

Централизованный доступ — `src/lib/env.ts` (Zod-схема, lenient-фолбэк по-полевой, `APP_VERSION` всегда из `package.json`).

### 6.1. Секреты (задаются в дашборде Render, в репозитории их НЕТ)

| Переменная | Назначение |
|---|---|
| `LOGIN_PASSWORD` | пароль single-user входа (timing-safe сравнение) |
| `SESSION_SECRET` | HMAC-ключ сессионных cookie **и share-токенов** |
| `API_KEY` | Bearer для scope `api` (API-клиенты) |
| `INGEST_TOKEN` | Bearer для инжеста (Sensor Logger) |
| `CRON_SECRET` | Bearer для `/api/cron/*`, `/api/worker/*` и POST бэкапов от кронов |
| `ADMIN_TOKEN` | Bearer для scope `admin` |
| `TURSO_AUTH_TOKEN` | токен доступа к Turso |
| `GH_TOKEN` | токен GitHub для бэкап-релизов (write-доступ к репо) |
| `TWO_GIS_API_KEY` | ключ 2GIS (routing) |
| `SLACK_WEBHOOK_URL` | вебхук Slack для алертов (пусто = только журнал/метрики) |

**Fail-closed:** в `NODE_ENV=production` приложение умышленно падает на старте, если любой секрет равен документированному дефолту (`change-me-please-…` и т.п.) — прод с публично известными секретами не поднимается.

### 6.2. Публичные параметры (значения продакшена — в `render.yaml`)

| Переменная | Прод | Назначение |
|---|---|---|
| `DATABASE_URL` | `libsql://tele-markovsaratov-crypto.aws-ap-south-1.turso.io` | БД |
| `RATE_LIMIT_MAX_INGEST` | 120 | лимит инжеста, запросов/мин |
| `RATE_LIMIT_MAX_DEFAULT` | 60 | дефолтный лимит, запросов/мин |
| `RATE_LIMIT_MAX_READ` | 240 | read-скоп UI, запросов/мин |
| `RATE_LIMIT_MAX_AUTH` | 5 | логин, попыток/мин |
| `RATE_LIMIT_MAX_ADMIN` | 1 | тяжёлые admin-мутации, раз/час |
| `RATE_LIMIT_MAX_REQUEUE` | 10 | requeue, запросов/мин |
| `RATE_LIMIT_BACKEND` | memory | движок rate-limit (только memory) |
| `MAX_PAYLOAD_BYTES` | 262144 (256 КБ) | общий payload-лимит |
| `WORKER_ID` | worker-render-01 | идентификатор воркера |
| `WORKER_POLL_INTERVAL_MS` | 5000 (дефолт) | период poll TrafficJob |
| `WORKER_BATCH_SIZE` | 10 (дефолт) | джобов за poll |
| `WORKER_MAX_CONCURRENCY` | 5 (дефолт) | параллелизм обработки |
| `OSRM_BASE_URL` | https://router.project-osrm.org | OSRM-провайдер |
| `TWO_GIS_PROXY_URL` | "" (пусто) | URL Cloudflare-прокси для 2GIS |
| `CIRCUIT_BREAKER_THRESHOLD` | 5 | ошибок до размыкания |
| `CIRCUIT_BREAKER_TIMEOUT_SEC` | 30 | полупериод размыкания |
| `RETENTION_DAYS` | 3650 (10 лет) | срок хранения сессий |
| `GRACE_PERIOD_DAYS` | 30 | grace после soft-delete до purge |
| `AUDIT_RETENTION_DAYS` | 3650 | срок хранения аудита |
| `EXPORT_ASYNC_THRESHOLD` | 5000 | точек: свыше — асинхронный экспорт |
| `EXPORT_URL_TTL_HOURS` | 24 (дефолт) | срок жизни ссылки экспорта |
| `BACKUP_STORAGE_DIR` | /tmp/backups | каталог дампов (эфемерный) |
| `BACKUP_VERIFICATION_ENABLED` | true | перечитать дамп и сверить sha256 |
| `BACKUP_MAX_ATTEMPTS` / `BACKUP_RETRY_INTERVAL_HOURS` | 3 / 1 | ретраи бэкапа |
| `TARGET_LOAD_RPM` | 100 | целевая нагрузка (блок capacity в /api/stats) |
| `REGISTRATION_ENABLED` | false | саморегистрация пользователей |
| `MOVING_TIME_HYSTERESIS_HIGH_KMH` / `_LOW_KMH` | 5 / 2 | гистерезис state machine §4.6 |
| `MOVING_TIME_DEBOUNCE_SEC` / `MOVING_TIME_GAP_SEC` | 5 / 30 | debounce и gap state machine |
| `ECO_SCORE_CAP_BASELINE` / `_PENALTY_EXPONENT` | "" / 1.5 | EcoScore CAP §7.3 |
| `ECO_SCORE_MIN_CALIBRATION_CORPUS` | 30 | мин. корпус калибровки EcoScore |
| `ECO_SCORE_MIN_BASELINE_VALUE` / `_MIN_ACTIVE_DISTANCE_KM` / `_MIN_ACTIVE_DURATION_SEC` | 0.05 / 5 / 300 | пороги применимости EcoScore |
| `HMM_EMISSION_SIGMA_M` / `HMM_TRANSITION_BETA_M` | 5 / 5 | HMM map-matching §17.2 |
| `ROUTE_TREND_BOOTSTRAP_THRESHOLD` / `_SAMPLES` | 200 / 200 | Theil-Sen bootstrap §10.5 |
| `HOTSPOT_SEGMENTS_PERCENTILE` / `_THRESHOLD` | 75 / 0.5 | P75-хотспоты §10.6 |
| `ROUTE_ID_SNAP_GRID_DEG` | 0.0005 (~55 м) | snap-to-grid routeHash §10.0 |
| `NODE_ENV` | production | — |
| `APP_VERSION` | 2.19.0 | информационно; фактически `/health` берёт версию из package.json |

## 7. База данных

**СУБД:** Turso (libSQL, диалект SQLite), инстанс `tele-markovsaratov-crypto` (aws-ap-south-1). Доступ: `DATABASE_URL` + `TURSO_AUTH_TOKEN` (HTTP-протокол Turso, конвейерные батч-запросы `/v2/pipeline`).

**Схема:** `prisma/schema.prisma` (Prisma 6.19.2). Идентификаторы — cuid. Доступ в коде: `import { db, libsql } from "@/lib/db"` (db — типизированные обёртки с unwrapping `{type,value}` Turso; libsql — прямые SQL-запросы).

### 7.1. Таблицы

**User** — аккаунты multi-user (используется администратором; регистрация закрыта).
`id`, `email` (unique), `passwordHash` (bcrypt), `role` (`user`|`admin`), `apiKey` (unique, per-user Bearer), `createdAt`, `updatedAt`. Индекс `role`.

**Session** — запись телеметрии (батч/кусок поездки; «поездка» в UI — склейка записей).
`id`, `userId`?, `deviceId`, `clientId`?, `deviceName`?, `startTime`, `endTime`?, `pointCount`, `payloadBytes`, `status` (`active`|`recording`|`completed`), `deletedAt`? (soft-delete), `purgedAt`?, `routeId`? (FK → admin-маршрут Route), `routeHash`? (детерминированный хеш §10.0, группировка концептуально одинаковых маршрутов), `topologyHash`?, `trafficJobId`?, `notes`?, `tags`?, таймстемпы.
Unique `@@unique([deviceId, clientId])` — идемпотентность `/api/ingest`. Индексы: `(status,endTime)`, `routeId`, `routeHash`, `topologyHash`, `deletedAt`, `startTime`.

**GpsPoint** — GPS-точка.
`id`, `sessionId` (FK, Cascade), `lat`, `lon`, `speed`?, `altitude`?, `accuracy`?, `timestamp` (**BigInt, мс epoch**), `bearing`?. Индексы: `sessionId`, `(sessionId, timestamp)`.

**Route** — админ-справочник маршрутов (для план-факта). `id`, `userId`?, `name`, `description`?, `startLat/startLon/endLat/endLon`, таймстемпы. Индекс `userId`.

**RouteCache** — кэш результатов маршрутизации: `hash` (unique), `result` (JSON), `todBucket` (time-of-day bucket), `routeId`?, `expiresAt`. Индексы `(todBucket, expiresAt)`, `routeId`.

**TrafficJob** — задача маршрутизации поездки.
`id`, `sessionId` (Cascade), `status` (`pending`→`running`→`completed`/`failed`/`dead`), `attempts`, `priority`, `scheduledFor`, `lockedBy`?, `lockedAt`?, `result`? (JSON: полилайн/длительность провайдера), `error`?, таймстемпы. Индексы `(status, scheduledFor, priority)`, `sessionId`.

**AuditLog** — журнал действий. `id`, `userId`?, `action` (`backup.create`, `backup.github.upload`, `backup.failed`, `session.delete`, `share.create`, `admin.requeue`, `import.*`, …), `targetId`, `targetType`, `actorType` (`user`|`owner`|`cron`|`backup-cron`|`system`), `actorId`?, `metadata` (JSON-строка), `sessionId`?, `createdAt`. Индексы: `(action, createdAt)`, `(targetId, targetType)`, `(actorType, actorId)`, `sessionId`, `userId`.

**ExportJob** — задача экспорта. `id`, `sessionId`, `format` (`gpx`|`kml`|`json`), `status`, `fileUrl`? (фиктивный), `fileSize`?, `expiresAt`?, `attempts`, `lockedBy`?, `completedAt`?, `error`?, `createdAt`. Индексы `(status, createdAt)`, `sessionId`.

**BackupJob** — задание бэкапа. `id`, `status`, `type` (`full`), `filePath`?, `fileSize`?, `checksum`? (sha256), `attempts`, `lockedBy`?, `completedAt`?, `error`?, `createdAt`. Индекс `(status, createdAt)`.

**Setting** — key-value хранилище: переопределяемые настройки (2GIS и т.п.), кэш геокодов, диагностический трейс инжеста (`diag.ingest.trace`), сырой дамп (`diag.ingest.raw` — **исключается из бэкапов**), служебное состояние алертов (`_AlertState`). `key` (PK), `value`, `updatedAt`, `updatedBy`?.

**IngestMessage** — идемпотентность инжеста Sensor Logger: PK `(deviceId, messageId)`, `firstSeenAt` (индекс). HTTP-ретраи приложения не создают дубликатов точек.

### 7.2. Жизненный цикл сессии (state machine)

```
[ingest /api/ingest]                [sensorlogger поток]
      │                                     │
      ▼                                     ▼
  completed  ──────────────►  recording ────┼── gap > 60 c ──► finalize ──► completed
  (однократный батч)         (живой поток)  │   (атомарно + TrafficJob)
                                            │
                          parking > 30 c ───┤  cron finalize-sessions (*/5)
                                            │  жнец в воркере (тот же код)
                                            ▼
                                       completed
```

- Финализаторы (инжест-gap, cron, жнец) идемпотентны и защищены от дублей TrafficJob одним SQL: `INSERT … SELECT … WHERE NOT EXISTS (pending/running job)`.
- «Поездка» в UI — это одна или несколько записей (Session), склеенных по времени/девайсу; статы поездки = агрегат по кусочкам.

### 7.3. Миграции

Схема управляется через `prisma db push` (без миграционных файлов). Изменение схемы: правка `prisma/schema.prisma` → на стенде `npm run db:push` → для прода выполнить push с прод-кредами (`DATABASE_URL`+`TURSO_AUTH_TOKEN`) в expand-режиме (только добавление полей/таблиц — бэк-заполнение ленивое). Перед push — свежий бэкап (см. §14).

## 8. Безопасность и авторизация

### 8.1. Гейт запросов (`src/proxy.ts`)

Все запросы (кроме статики) проходят `proxy` (Next.js 16, Node-runtime):

1. **Payload guard** (до чтения body): `Content-Length` > 256 КБ → 413 (импортные роуты `/api/import/zip|csv` — 100 МБ; внутренние бизнес-лимиты в самих роутах).
2. **CORS preflight**: отражается только same-origin.
3. **Rate limit** (sliding window, in-memory): см. §8.4.
4. **Auth-гейт по классу пути** (см. §8.2–8.3).
5. **Security-заголовки** + `X-Request-Id` (сквозной, во всех ответах) + счётчик `http_requests_total{route}` (uuid-сегменты нормализуются в `:id`).

Заголовки: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=()`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, CSP (`default-src 'self'`, тайлы Leaflet + Google Fonts — allow-list, `frame-ancestors 'none'`).

### 8.2. Механизмы авторизации

| Механизм | Где | Описание |
|---|---|---|
| **Сессионная cookie** | браузер | `payload.sig`: base64url JSON `{sub:"owner"}` (single-user) или `{userId,email,role}`, подпись HMAC-SHA256(SESSION_SECRET). httpOnly, SameSite=Strict, Secure + префикс `__Host-` в проде. TTL 24 ч, автопродление при exp < 1 ч. Роль при авторизации читается из СВЕЖЕЙ строки User (смена роли действует сразу) |
| **Bearer API_KEY** | API-клиенты | scope `api`; альтернативно per-user `apiKey` из User |
| **Bearer INGEST_TOKEN** | Sensor Logger | заголовок Authorization или `?token=`; scope `ingest` |
| **Bearer CRON_SECRET** | кроны Render, воркер | scope `cron` (+ worker-роуты; + POST бэкапных путей для крона) |
| **Bearer ADMIN_TOKEN** | админ-скрипты | scope `admin` |
| **Share-токен** | публичная ссылка | `sessionId.exp36.sig32`: HMAC-SHA256(SESSION_SECRET), проверка timing-safe + срок; проверяется в самом роуте `/api/share` |

Публичные пути (без авторизации): `/api/keepalive`, `/api/auth/login|register|logout|me`, `/health`, `/api/metrics`, `/api/share`.
Вход: `POST /api/auth/login` — single-user пароль (LOGIN_PASSWORD, timing-safe) → owner-cookie; или email+bcrypt-пользователь. Логин — rate limit 5/мин по IP.

Проверка токенов — **timing-safe по значению** и в прокси, и повторно в чувствительных роутах (defense-in-depth, напр. ingest).

### 8.3. Скоупы путей

| Префикс/путь | Требуемая авторизация |
|---|---|
| `/api/ingest*` | INGEST_TOKEN |
| `/api/cron/*` | CRON_SECRET |
| `/api/worker/*` | CRON_SECRET |
| `/api/admin/*` | ADMIN_TOKEN (Bearer) ИЛИ admin-cookie; для POST `/api/admin/backup` и `/api/admin/backup/github` дополнительно принимается CRON_SECRET (бэкап-кроны) |
| `/api/share` | публичный (валидный share-токен в `?token=`) |
| остальные `/api/*` | cookie ИЛИ Bearer (API_KEY / per-user apiKey); полная проверка в роуте через `authorizeRequest` |

### 8.4. Rate limiting (скользящее окно, per-instance, memory)

| Скоуп | Лимит | Ключ | Пути |
|---|---|---|---|
| `ingest` | 120/мин | IP + первые 16 симв. токена | `/api/ingest*` |
| `auth:login` | 5/мин | IP | `POST /api/auth/login` |
| `admin:heavy` | 1/час | Bearer-префикс или IP | POST `/api/admin/backup`, `/api/admin/backup/github`, `/api/admin/restore` |
| `admin:requeue` | 10/мин | Bearer-префикс или IP | POST `/api/admin/requeue` |
| `read` | 240/мин | IP | GET `/api/sessions`, `/api/sessions/{id}/(stats\|events\|track)`, `/api/stats/batch`, `/api/events/batch`, `/api/track/batch`, `/api/geocode/reverse`; POST `/api/sessions/batch` |
| `default` | 60/мин | IP | прочие `/api/*` |

Ответ 429 содержит `X-RateLimit-*`, `Retry-After`; счётчик `rate_limit_exceeded_total`.

### 8.5. Ротация секретов (процедура для администратора)

Контекст и рекомендации по компрометации — `docs/OPERATIONS.md` §0. Процедура ротации (значения — только в дашборде Render):

| Секрет | Где обновить | Побочный эффект |
|---|---|---|
| `LOGIN_PASSWORD` | Render env web-сервиса | новый пароль для входа; сессии живут |
| `SESSION_SECRET` | Render env web-сервиса | **разлогин всех** + инвалидация ВСЕХ активных share-ссылок |
| `API_KEY` / `ADMIN_TOKEN` | Render env web-сервиса | обновить API-клиенты/скрипты |
| `INGEST_TOKEN` | Render env web-сервиса | **обновить URL в Sensor Logger** (на всех устройствах) — до обновления инжест будет 401 |
| `CRON_SECRET` | Render env web-сервиса И всех 5 cron-сервисов | кроны и воркер продолжат работу после синхронной замены |
| `TURSO_AUTH_TOKEN` | дашборд Turso (создать новый токен) → Render env | при отзыве старого — смена владельца токена |
| `GH_TOKEN` | GitHub (новый PAT с repo-write) → Render env web + github-backup-cron | бэкапы в релизы продолжатся |
| `TWO_GIS_API_KEY` | кабинет 2GIS → Render env ИЛИ админ-настройки (`/api/admin/settings`, allow-list) | — |

## 9. Справочник HTTP API

Общие правила: JSON везде; каждый ответ несёт `X-Request-Id`; ошибки — `{error, reason?/details?}` с соответствующим кодом; 401/413/429 на уровне прокси. Формат дат — ISO 8601. `timestamp` точек в ответах — число (мс epoch).

### 9.1. Системные

| Метод и путь | Auth | Описание |
|---|---|---|
| `GET /health` | публичный | `{status, db, worker, workerUptimeSec, circuits, rateLimiter{buckets,backend}, version, uptime, targetLoadRpm, rateLimitMaxIngest}` — healthcheck Render |
| `GET /api/metrics` | публичный | метрики Prometheus (текстовый формат), см. §13.2 |
| `GET /api/keepalive` | публичный | пустой пинг для прогрева free-инстанса |
| `GET/POST /api` | — | 404 (индексной страницы API нет) |
| `GET /api/test-2gis` | api | проверка достижимости 2GIS из инстанса |

### 9.2. Авторизация

| Метод и путь | Auth | Тело | Ответ |
|---|---|---|---|
| `POST /api/auth/login` | публичный (5/мин) | `{password}` (+`email?` для multi-user) | `{ok, …}` + Set-Cookie (24 ч). 401 при неверном |
| `POST /api/auth/logout` (и GET) | публичный | — | снятие cookie |
| `GET /api/auth/me` | публичный (по cookie) | — | текущая сущность |
| `POST /api/auth/register` | — | `{email, password≥8}` | 403 пока `REGISTRATION_ENABLED≠true` |

### 9.3. Инжест

| Метод и путь | Auth | Описание |
|---|---|---|
| `POST /api/ingest` | INGEST_TOKEN | Канонический формат: `{deviceId (1–64), clientId (1–64, [A-Za-z0-9_-]), deviceName? (≤128), points: [{lat, lon, speed? (м/с 0–83.33), altitude?, accuracy?, bearing?, timestamp (нс\|мс\|с)}]}` (1–1000 точек). Таймстемпы нормализуются; сортировка; точки сохраняются все (gap>30 c только размечается). Транзакция: Session(status `completed`) + GpsPoint.createMany + TrafficJob(pending). Ответ 201: `{sessionId, pointsAccepted, trafficJobId, duplicate:false}`. Повтор того же `(deviceId, clientId)` → 200 `{sessionId, duplicate:true}` (идемпотентность, включая гонку) |
| `POST /api/ingest/sensorlogger` | INGEST_TOKEN | Нативный формат Sensor Logger: `{messageId, sessionId, deviceId, payload: [{name, time (нс), values}]}` — точки из записей `name:"location"`. Идемпотентность по `(deviceId, messageId)` (IngestMessage). Поток: создаёт/продолжает `recording`-сессию устройства; gap > 60 c — финализация прежней и новая сессия. Точки с accuracy > 100 м отбрасываются (счётчик dropped). Толерантный парсер сторонних форматов (см. §2). Трейс каждой попытки — в Setting `diag.ingest.trace` |
| `GET /api/ingest/sensorlogger` | INGEST_TOKEN | справка по формату (для настройки приложения) |

### 9.4. Сессии и данные

| Метод и путь | Auth | Описание |
|---|---|---|
| `GET /api/sessions` | api (read-скоп) | Курсорная пагинация: `?cursor=&limit=1..100 (20)&olderThan=&before=&routeId=&status=&deviceId=`. Ответ `{sessions: [{id, deviceId, deviceName, startTime, endTime, pointCount, pointCountActual, endLat, endLon, payloadBytes, status, routeId, route{id,name}}], nextCursor}` |
| `POST /api/sessions/batch` | api (read-скоп) | `{ids: [≤10]}` → `{sessions: [… + gpsPoints[]]}` (полные точки; для компаратора маршрутов) |
| `GET /api/sessions/search` | api | `?q=` — поиск по deviceId/notes/tags |
| `GET /api/sessions/{id}` | api | полная мета сессии |
| `DELETE /api/sessions/{id}` | api | soft-delete (`deletedAt`) + аудит `session.delete` |
| `PATCH /api/sessions/{id}/notes` | api | `{notes?, tags?}` |
| `POST /api/sessions/{id}/share` | api | `{expiresInHours? (1–8760, по умолчанию 168)}` → `{token, expiresAt}`; ссылка `/shared/<token>` |
| `POST /api/sessions/{id}/export` | api | `{format: gpx\|kml\|json}` → ExportJob; ≤5000 точек — синхронно, свыше — `{jobId}` async |
| `GET /api/exports/{jobId}` | api | статус ExportJob |
| `GET /api/exports/{jobId}/download` | api | контент экспорта (генерируется на лету; TTL 24 ч; сессия с `deletedAt` → 404) |
| `POST /api/import/csv` | api | multipart CSV (≤20 МБ); один `clientId` на файл → одна сессия |
| `POST /api/import/zip` | api | multipart ZIP (≤100 МБ на прокси; zip-бомбы отсекаются по факту распаковки) |
| `GET /api/geocode/reverse` | api (read-скоп) | `?lat=&lon=` — Nominatim реверс-геокод, кэш 30 суток в Setting; ответ с `short`-подписью |

### 9.5. Статистика и аналитика

| Метод и путь | Auth | Описание |
|---|---|---|
| `GET /api/stats` | api | Дашборд: `{totalSessions, totalPoints, totalRoutes, totalTrafficJobs, deadJobs, pendingJobs, todaySessions, totalPayloadBytes, heatmapSessions, capacity{…}, version, ingestTrace{last, recent≤20}}`; `?tzOffsetMin=` — «сегодня» в TZ клиента; `?ingestRaw=1` — добавить дамп нераспознанного батча |
| `GET /api/stats/batch?ids=` | api (read-скоп) | Батч статов: ids ≤ 50, формат id `[A-Za-z0-9_-]{1,64}`, дедуп. Ответ `{stats: SessionStats[], missing: [id]}` — каждая запись побайтно идентична `/api/sessions/{id}/stats`. Загрузка чанками по 8 id параллельно; серверный TTL-кэш 30 с (хит — заголовок `X-Cache: ttl`) |
| `GET /api/events/batch?ids=` | api (read-скоп) | Батч событий (G-G-физика): `{events: […], missing: []}`; TTL 30 с |
| `GET /api/track/batch?ids=` | api (read-скоп) | Батч треков для карты: `{tracks: […], missing: []}`; TTL 30 с |
| `GET /api/sessions/{id}/stats` | api (read-скоп) | Полный конвейер метрик сессии (SessionStats): базовые, скоростные, поведенческие, спидограмма speedProfile, EcoScore, план-факт из TrafficJob |
| `GET /api/sessions/{id}/events` | api (read-скоп) | События сессии: манёвры/резкие события (G-G, центральная разность), rawPoints |
| `GET /api/sessions/{id}/track` | api (read-скоп) | Трек сессии для карты (точки + мета) |
| `GET /api/sessions/{id}/route-comparison` | api | Сравнение с каноническим полилайном routeHash-группы (§10.6) |
| `GET /api/stats/devices` | api | Лидерборд устройств (один SQL) |
| `GET /api/stats/tags` | api | Агрегация тегов (облако) |
| `GET /api/stats/speed-record` | api | Рекорд скорости за всё время (анти-джиттер конвейер; кэш 5 мин) |
| `GET /api/routes/grouped` | api | Группы routeHash + агрегаты; `?period=today\|week\|d30\|all` |
| `GET /api/routes/heavy-segments` | api | Тяжёлые участки (P75-хотспоты) по всем группам; `?period=` |
| `GET /api/routes/{id}/trend` | api | `[id]` = routeHash или UUID Route: Theil-Sen-тренд activeDuration + trafficPattern (8×3 ч) + dayOfWeekPattern |

### 9.6. Публичный доступ

| Метод и путь | Auth | Описание |
|---|---|---|
| `GET /api/share?token=` | share-токен | Публичные данные поездки: трек (lat, lon, speed, altitude, timestamp) + серверные KPI: `distanceM` (активная), `rawDistanceM`, `activeDurationSec`, `preTripIdleSec`, `postTripIdleSec`, `hasActiveTrip`, `maxSpeedMs`, `expiresAt`. Подделка подписи → 403; истёк/удалён → 403/404 |

### 9.7. Админ

| Метод и путь | Auth | Описание |
|---|---|---|
| `GET /api/admin/settings` | admin | Список переопределяемых настроек |
| `PUT /api/admin/settings` | admin | `{key, value}` — строго по allow-list |
| `GET /api/admin/jobs?status=&limit=` | admin | Список TrafficJob (+session-инфо, без result-блоба), лимиты clamped |
| `POST /api/admin/requeue` | admin | `{jobId, force?}` — dead → pending, аудит `admin.requeue` |
| `POST /api/admin/backup` | admin ИЛИ CRON_SECRET (POST) | Полный логический дамп: BackupJob + файл `/tmp/backups/backup-<ts>-<id>.json` (sha256 + верификация перечитыванием). Ответ `{backupId, filePath, checksum, fileSize, tableCounts}`. 1/час |
| `GET /api/admin/backup` | admin (default-скоп) | Последние 50 BackupJob |
| `POST /api/admin/backup/github` | admin ИЛИ CRON_SECRET (POST) | Дамп → **draft**-релиз GitHub (приватный) с ассетом; тело релиза содержит sha256. Ответ `{backupId, releaseId, releaseUrl, assetUrl, assetSize, checksum, draft:true}` |
| `GET /api/admin/backup/github` | admin | Список бэкап-релизов |
| `POST /api/admin/restore` | admin (1/час) | **Заглушка**: 202 `Restore queued…` — восстановление ручное (см. §14.3) |
| `GET /api/admin/alerts` | admin | Текущее состояние 6 правил алертов |

### 9.8. Воркер и кроны

| Метод и путь | Auth | Описание |
|---|---|---|
| `POST /api/worker/poll` | CRON_SECRET | `{workerId, batchSize}` → атомарный захват pending-джобов (RETURNING) + session.gpsPoints |
| `POST /api/worker/complete` | CRON_SECRET | `{jobId, workerId, status: completed\|failed, result?\|error?}` — сохранение результата; failed → requeue (backoff) при attempts < 3; чужой workerId → 409 |
| `GET /api/worker/health` | CRON_SECRET | статистика воркера |
| `POST /api/cron/retention` | CRON_SECRET | чистка по retention/grace (ежедневно) |
| `POST /api/cron/finalize-sessions` (+GET→POST) | CRON_SECRET | закрытие стоянок > 30 с, endTime, идемпотентно (каждые 5 мин) |
| `POST /api/cron/alerts` | CRON_SECRET | оценка правил алертов (каждые 5 мин) |

## 10. Конвейеры обработки данных

### 10.1. Инжест Sensor Logger (основной поток)

```
батч {messageId, deviceId, payload:[{name,time,values}]}
  │ 1. auth INGEST_TOKEN (прокси + роут, timing-safe)
  │ 2. идемпотентность: IngestMessage (deviceId,messageId) → duplicate
  │ 3. извлечение location-записей; accuracy>100 м — drop (счётчик)
  │ 4. time: нс → мс; правдоподобие (±24 ч)
  │ 5. склейка: живая recording-сессия deviceId и gap ≤ 60 c → дописать точки
  │    иначе → finalizeSession(старая) + новая recording-сессия
  ▼
Session(recording) + GpsPoint[] ──(gap>60c / cron / жнец)──► finalize:
  status→completed; TrafficJob(pending) вставка WHERE NOT EXISTS
```

### 10.2. Воркер (in-process, `src/lib/worker-runtime.ts`)

Запускается через `src/instrumentation.ts` при старте Next.js (только Node-runtime, не build). Циклы:

- **Poll TrafficJob** (5 с): реклейм застрявших `running > 60 c` (attempts+1; после 10 реклеймов — `dead`); атомарный захват `LIMIT 10` (`UPDATE…RETURNING`); обработка с `p-limit(5)`.
- **Маршрутизация** (`src/lib/routing/chain.ts`): 2GIS carrouting (приоритет; опционально через Cloudflare-прокси `TWO_GIS_PROXY_URL` для обхода региональных блокировок) → OSRM demo → гаверсинус 40 км/ч (последний рубеж). Circuit breaker по провайдеру (5 ошибок → разомкнут на 30 c). Кэш `RouteCache` (hash + time-of-day bucket).
- **Результат** → `TrafficJob.result` = JSON маршрутизации (полилайн, длительность в трафике) — источник план-факта.
- **Жнец recording-сессий**: та же `finalizeSession` — зависшие сессии закрываются, дубли TrafficJob исключены атомарной вставкой.
- **Прогрев corpus-калибровки EcoScore** (первый цикл + каждые 4 мин, fire-and-forget) — холодный свип ~15–20 с не платится первым пользователем.
- **Экспорт-джобы** (async > 5000 точек) и **ретраи бэкапов** (3 попытки / 1 ч).

### 10.3. Расчёт метрик (`src/lib/session-stats.ts` — единый конвейер)

Поштучный роут и батч-роут делят один код (гарантия паритета ответов):

1. Загрузка точек (батч: меты одним IN-запросом ≤ 50, точки — параллельные SELECT чанками по 8 id, хронология внутри id сохраняется).
2. Активное окно §4.11: `computeMovingTime` (state machine гистерезис 5/2 км/ч, debounce 5 c, gap 30 c) + `computeActiveTrip` (pre/post trip idle).
3. Методология §12: дистанция (гаверсинус, только активное окно), скорости (нормализация anti-jitter + пересчёт по геометрии для битых полей), спидограмма (buckets), EcoScore (CAP §7.3, корпусная калибровка `src/lib/eco-corpus.ts` — общий кэш с воркером).
4. План-факт: `TrafficJob.result` по сессии (IN-запрос для батча).
5. Сборка `SessionStats` (включая `speedProfile`, route-инфо, `missing`-обработка для батча).
6. TTL-кэш 30 с (LRU ≤ 32 записей на globalThis; ключ — отсортированные ids; хит помечается `X-Cache: ttl`). Инвалидация не нужна: живые `recording`-сессии опрашиваются поштучным роутом с интервалом 15 c, минуя кэш.

### 10.4. События (G-G-физика)

`src/lib/session-events.ts`: центральная разность по скоростям/времени → продольные/поперечные ускорения, пороги манёвров/резких событий (согласованы с §7.x методологии). Это отдельная «линза» сырых данных — осознанно не совпадает с state-machine-метриками (см. §17).

### 10.5. Retention

Cron 03:00 UTC: сессии старше `RETENTION_DAYS` → soft-delete; после `GRACE_PERIOD_DAYS` — `purgedAt` (данные недоступны, строки сохраняются до ручной чистки). Аудит пишется.

## 11. Метрики и методология

Полная методология — **`docs/METHODOLOGY.md`** (62 метрики, 8 групп, формулы, ограничения, приёмка). Краткая карта:

| Группа | Примеры | Ключевые модули |
|---|---|---|
| 1. Базовые (13) | длительность, дистанция (сырая/активная), точек, байтов | active-trip.ts, geo.ts |
| 2. Скоростные (6) | avg/max (anti-jitter), рекорд, спидограмма | kpi.ts, speed-buckets.ts |
| 3. План-фактные (8) | план против факта по маршрутизации, Δ времени | session-stats.ts (TrafficJob.result) |
| 4. Поведенческие (10) | манёвры, резкие события (G-G), EcoScore, плавность | session-events.ts, eco-corpus.ts |
| 5. Географические (6) | bbox, высотный профиль, адреса (геокод) | geo.ts |
| 6. Трафик-метрики (5) | длительность в трафике, tod-buckets | routing/chain.ts |
| 7. Сравнительные (8) | routeHash-группы, Theil-Sen тренд, P75-хотспоты | route-comparison.ts |
| 8. Качество данных (6) | покрытие, accuracy, gaps | ingest-trace.ts |

Окна: **активное окно поездки** (§4.11) — все пользовательские KPI считаются по нему (idle до/после исключаются). Спидограмма — гистограмма распределения скоростей по времени. EcoScore — CAP-методика с корпусной калибровкой (мин. корпус 30 сессий; иначе метрика не выдаётся).

## 12. Фронтенд

- **Страницы**: `/` — основное приложение (вкладки: Аналитика, Поездки, АДМИН); `/m` — мобильная запись; `/shared/<token>` — публичная поездка; офлайн — `offline.html`.
- **PWA**: `public/sw.js` (кэш статики, фоновое обновление с тостом), `manifest.webmanifest`, иконки.
- **Серверное состояние**: TanStack Query; staleTime 30 c; live-сессии — поллинг 15 c (поштучные роуты); параллелизм GET-запросов ограничен клиентским семафором (6).
- **Батч-архитектура**: префетч `stats/batch` на корне лейаута; ответ «просеивается» в per-id кэш (`setQueryData`), поэтому карточки «Поездок» рендерятся без сетевых запросов; период-агрегат аналитики — `stats+events+track` батчи (3 запроса).
- **Карта**: Leaflet, слои OSM/OpenTopoMap/Esri/CartoDB (CSP allow-list), полилайн трека, мини-карты.
- **UX**: командная палитра (Ctrl+K), глобальный поиск, тёмная тема (next-themes), тосты Sonner, skeleton-состояния, 25 c watchdog на гейт батча с фолбэком на поштучные запросы.

## 13. Наблюдаемость

### 13.1. Health

`GET /health` — Render healthcheck: `status/db/worker` (`ok`), версии, uptime воркера, состояние circuit breakers (`circuits`), счётчик бакетов rate-limiter. Проверка «живости»: этот эндпоинт + логин + вкладки.

### 13.2. Метрики (`GET /api/metrics`, Prometheus)

Реестр на `globalThis` — общий для API и воркера (in-process). Основные семейства: `http_requests_total{route}` (пути нормализованы `:id`/`:param` — кардинальность ограничена), `ingest_total`, `ingest_duplicate_total`, `ingest_unauthorized_total`, `ingest_attempts_total`, `ingest_{empty|no_gps|dropped_all|invalid|duplicate}_total{route}`, `rate_limit_exceeded_total{scope}`, `alert_firing_current` (gauge), `alert_firing_total`. Буферы p95-латентности и исходов инжеста — в памяти инстанса.

### 13.3. Логи

Структурированный JSON в stdout (Render log drain): `{time, level, msg, requestId, …}`. Ошибки роутов всегда с `requestId` (совпадает с `X-Request-Id` ответа).

### 13.4. Алерты (оценка каждые 5 мин: cron → `src/lib/alerts.ts`)

| Правило | Условие | Источник |
|---|---|---|
| `ingest_error_rate` | errors/total > 5 % за 5 мин | кольцевой буфер исходов (401 прокси не в счёте) |
| `traffic_job_dead_rate` | dead/total > 10 % за 1 ч | SQL по TrafficJob |
| `backup_failure` | 3 failed подряд | последние 3 BackupJob |
| `db_size_growth` | рост > 100 МБ/день | PRAGMA page_count × page_size (state в `_AlertState`) |
| `api_latency_p95` | p95 > 2 c за 5 мин | буфер latency.ts (`trackLatency`) |
| `worker_stuck` | pending > 50 в течение 10 мин | серия снапшотов pending |

Просмотр: `GET /api/admin/alerts` (JSON). Срабатывание: `logger.warn` + метрики + Slack (`SLACK_WEBHOOK_URL`). Ограничения — §17.

### 13.5. Диагностика инжеста (канал приёма)

- Трейс всех авторизованных попыток: Setting `diag.ingest.trace` (последняя + 20). Исходы: `accepted` (канал работает), `no_gps` (приходит без координат — включить Location в приложении), `dropped_all` (слабый GPS, всё отброшено по accuracy), `invalid` (формат), `empty`, `duplicate` (идемпотентный ретрай).
- `sample` — образец структуры нераспознанного батча + гистограмма сенсоров (`payload-массив[230] сенсоры: accelerometer×200, … location×1`).
- Полный дамп: `GET /api/stats?ingestRaw=1` → `ingestRaw` (до 64 КБ, TTL 24 ч, в бэкапы НЕ попадает).
- Неавторизованные попытки в БД не пишутся (анти-абьюз) — только счётчик `ingest_unauthorized_total`.

## 14. Резервное копирование и восстановление

### 14.1. Уровни

| Уровень | Что | Где | Расписание |
|---|---|---|---|
| 1. Turso snapshots | платформенные снапшоты БД | дашборд Turso | платформа |
| 2. Логический дамп | JSON всех строк всех таблиц + sha256 + tableCounts | `/tmp/backups` (эфемерно!) + строка BackupJob в БД | ежедневно 03:30 UTC |
| 3. GitHub draft-релиз | дамп-файл как ассет приватного draft-релиза `backup-<date>-<time>` (checksum в теле релиза) | репозиторий GitHub | еженедельно ВС 04:00 UTC + вручную |

Дамп содержит: все таблицы (Session, GpsPoint, Route, RouteCache, TrafficJob, AuditLog, ExportJob, BackupJob, Setting), пользователей — **без** passwordHash (информационно), `BigInt` — как строки `"BIGINT:<значение>"`. `diag.ingest.raw` исключён.

Draft-релиз = приватный: ассеты видны/скачиваются только collaborators с write-доступом. Публичные релизы для бэкапов запрещены.

### 14.2. Ручной бэкап (админ)

```bash
# полный дамп + загрузка в GitHub (лимит 1/час)
curl -X POST https://telemetria-poedzok.onrender.com/api/admin/backup/github \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
# → {backupId, releaseId, releaseUrl, assetUrl, assetSize, checksum, draft:true}

# только дамп без GitHub
curl -X POST https://telemetria-poedzok.onrender.com/api/admin/backup \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
# список последних бэкапов
curl https://telemetria-poedzok.onrender.com/api/admin/backup \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Верификация: sha256 из ответа = checksum в BackupJob и в теле релиза; бэкап дополнительно самопроверяется перечитыванием (BACKUP_VERIFICATION_ENABLED).

### 14.3. Восстановление из дампа (RTO 30–60 мин)

`POST /api/admin/restore` — заглушка (202, ручная операция). Процедура:

1. Скачать дамп-ассет из draft-релиза (GitHub UI или API с токеном) — файл `backup-<ts>.json`.
2. Сверить `sha256sum backup-…json` с checksum из тела релиза.
3. Развернуть в новую БД Turso (или локальный libSQL): создать таблицы по `prisma/schema.prisma`, вставить строки (BigInt-строки `"BIGINT:…"` → обратно в числа; таблица User восстанавливается частично — passwordHash в дампах нет, аккаунты пересоздаются паролем, id сессий сохраняются).
4. Сменить `DATABASE_URL`/`TURSO_AUTH_TOKEN` в Render на восстановленную БД → деплой-рестарт.
5. Проверка: `/health` → db ok; сверка `totalSessions`/`totalPoints` с `tableCounts` дампа; smoke-тест UI.
6. На время restore БД недоступна для записи (ingest вернёт 5xx) — делать в окно низкой нагрузки. Дисциплина: не чаще 1 раза/час.

### 14.4. RPO/RTO

- RPO: дамп-уровень durable — еженедельный GitHub-релиз; ежедневный уровень живёт в эфемерном `/tmp` (строка BackupJob — в БД). Перед рискованными операциями (миграции, массовые удаления) — ручной `POST /api/admin/backup/github`.
- RTO: 30–60 мин (ручная процедура §14.3).

## 15. Runbook: типовые операции и инциденты

### 15.1. Ежедневная проверка (5 мин)

```
1. GET /health                     → status/db/worker = ok, version совпадает с package.json
2. GET /api/metrics                → нет роста error-семейств; ingest_total растёт при активном приложении
3. UI: логин → вкладка АДМИН → L1  → джобы/бэкапы/алерты/канал приёма без красного
4. AuditLog                        → backup.create присутствует за сегодня (03:30 UTC)
```

### 15.2. Типовые инциденты

| Симптом | Причина | Действие |
|---|---|---|
| Первый запрос висит ~50 с | cold start free-плана | организовать пинг `/api/keepalive` или поднять план |
| «Слишком много запросов» (429) в UI | всплеск чтений превысил read-скоп 240/мин (обычно — старый клиент без батчей) | убедиться, что UI актуальной версии; временно повторить через минуту |
| Sensor Logger «отправлено», данных нет | см. трейс L1: `no_gps` → включить Location в приложении; `dropped_all` → слабый GPS; `invalid` → прислать `?ingestRaw=1` дамп на анализ; пустой трейс → неверный URL/токен (см. 401-счётчик) | диагностика §13.5 |
| 401 на инжест | INGEST_TOKEN изменён/неверен в приложении | сверить токен; после ротации обновить URL во ВСЕХ приложениях |
| `dead` TrafficJob растёт | провайдер маршрутизации недоступен/истощена квота | `GET /api/test-2gis`; при недоступности 2GIS из региона — развернуть Cloudflare-прокси (`cloudflare-worker/worker.js`) и задать `TWO_GIS_PROXY_URL`; dead-джобы вернуть: `POST /api/admin/requeue {jobId}` |
| Бэкап не появился в 03:30 | сбой (аудит `backup.failed`) | `POST /api/admin/backup/github` вручную; учесть лимит 1/час |
| 5xx на инжест/списке | деградация Turso | `/health` → db; статус Turso; при восстановлении — записи, попавшие в окно, придут ретраями приложения (идемпотентность) |
| Красный `worker_stuck`/pending > 50 | воркер не стартовал (см. лог `worker runtime started`) | рестарт деплоя; проверить логи instrumentation |
| Алерт `backup_failure` | 3 failed подряд | аудит `backup.failed` (метаданные error); починить причину, ручной прогон |
| «Поездки» показывают «—» | первый батч ещё в полёте (гейт 25 с) | подождать; watchdog сам отрисует фолбэком |

### 15.3. Развёртывание изменений

1. Стенд (§16): `tsc` 0 ошибок, `eslint` 0, сборка ок, smoke API.
2. Коммит в `main`, push (нужен GH-токен с write).
3. Render авто-деплой ~3–5 мин → `/health` version.
4. Прод-smoke: логин, «Аналитика» (цифры дашборда), «Поездки» (карточки), «АДМИН» (L1), консоль без ошибок.
5. Обновить доки (`docs/`), если менялись контракты/поведение.

### 15.4. Чек-лист передачи администратору/техподдержке

- Доступы: GitHub-репозиторий (collaborator, write — для draft-релизов), Render-дашборд (web + 5 cron), Turso-дашборт, этот документ.
- Секреты: значения берутся у владельца / из дашборда Render (`sync: false`); в репозитории их нет и быть не должно.
- Регламент: §15.1 ежедневно; §15.2 — инциденты; §8.5 — ротация; §14 — бэкапы.

## 16. Локальная разработка и тестовый контур

```bash
# зависимости и схема
npm install
DATABASE_URL="file:./db/local.db" npm run db:push   # локальная SQLite/libSQL
npm run db:generate                                  # prisma client

# dev-сервер (порт 3000)
npm run dev

# качество
npx tsc --noEmit   # 0 ошибок
npm run lint       # 0 предупреждений
npm run build      # сборка (используется на Render)
```

- Секреты локально: `.env` (в `.gitignore`; дефолты env.ts — только для NODE_ENV≠production).
- **Тестовый контур (QA-стенд)**: отдельная БД `local.db` (копия схемы; тестовые сессии), приложение поднимается на нестандартном порту (напр. `PORT=3199 npm run build && PORT=3199 npx next start`); прод-секреты на стенде НЕ использовать.
- Регресс-проверки батч-конвейеров: паритет ответов батч/поштучный (deep-equality) — основной инвариант при правках `session-stats/session-events/session-track`.
- Мини-сервис внешнего воркера: `mini-services/worker` (`bun run dev`, порт 3001) — опциональная изоляция воркера отдельным процессом; в проде не используется.

## 17. Известные ограничения и осознанные решения

1. **Single-instance память.** Rate-limiter, метрики, буферы алертов/латентности — in-memory: рестарт обнуляет окна; горизонтальное масштабирование требует внешнего хранилища (Redis/Prometheus).
2. **Restore ручной** (RTO 30–60 мин), эндпоинт-заглушка; ежедневный дамп живёт в эфемерном `/tmp` — durable-копия это GitHub draft-релиз (еженедельно + вручную).
3. **G-G-линза events ≠ state-machine-метрики.** События считаются центральной разностью по сырым точкам (отдельная линза физики), пороги согласованы с методологией §7.x; расхождение с MovingTime-метриками — по построению, не баг.
4. **`POST /api/sessions/batch`** отдаёт полные точки до 10 сессий без point-cap — используется компаратором маршрутов, только авторизованный доступ.
5. **Часть роутов вне p95-буфера** (покрытие `trackLatency` — основные роуты).
6. **Slack-алерты без дедупликации** — повторяются каждые 5 мин, пока правило горит.
7. **Free-план Render**: cold start ~50 c, эфемерный `/tmp`.
8. **Регистрация закрыта** (single-user); multi-user механика присутствует, но не активируется.
9. **Тайлы карты** — внешние сервисы (OSM и др.): зависимость доступности UI-карты от них.
10. **Автотестов в репозитории нет** — регресс держится на стенде + паритетных проверках; при переносе в CI рекомендуется vitest (зависимость уже объявлена).

## 18. Структура репозитория

```
prisma/schema.prisma          # схема БД (11 таблиц)
render.yaml                   # сервисы Render (web + 5 cron)
src/proxy.ts                  # гейт всех запросов (payload/CORS/rate/auth/headers)
src/instrumentation.ts        # старт in-process воркера
src/app/                      # маршруты Next.js
  page.tsx | m/page.tsx | shared/[token]/page.tsx | health/route.ts
  api/**                      # 45+ REST-эндпоинтов (см. §9)
src/lib/
  env.ts db.ts auth.ts http-utils.ts rate-limit.ts token-check.ts cookie-name.ts
  validation.ts logger.ts metrics.ts latency.ts alerts.ts audit.ts idempotency.ts
  ingest-trace.ts settings.ts retention.ts share.ts
  session-stats.ts session-events.ts session-track.ts session-finalize.ts
  active-trip.ts kpi.ts speed-buckets.ts eco-corpus.ts metrics-methodology.ts
  batch-points.ts ttl-cache.ts route-comparison.ts geo.ts format.ts export.ts
  offline-summary.ts routing/chain.ts routing/circuit-breaker.ts
  worker-runtime.ts github-backup.ts backup.ts user-db.ts
src/components/               # UI: v4/ (аналитика, поездки, админ, лейаут) + виджеты
public/                       # PWA (sw.js, manifest, offline.html), иконки
docs/                         # TECHNICAL.md (этот документ), METHODOLOGY.md, ADMIN_SPEC.md, OPERATIONS.md
mini-services/worker/         # внешний воркер (альтернатива, не для прода)
cloudflare-worker/worker.js   # прокси 2GIS (опционально)
```

## 19. Глоссарий

| Термин | Значение |
|---|---|
| **Запись (Session)** | непрерывный кусок телеметрии одного устройства; атомарная единица хранения |
| **Поездка** | UI-концепт: одна или несколько записей, склеенных по времени (gap-логика); все KPI пользователя — на уровне поездки/активного окна |
| **Активное окно** (§4.11) | интервал от начала движения до окончания (исключает idle до/после); по нему считаются дистанция/скорость |
| **MovingTime state machine** (§4.6) | гистерезис 5/2 км/ч + debounce 5 c + gap 30 c — классификация движения/стоянки |
| **Инжест** | приём батчей GPS от Sensor Logger |
| **TrafficJob** | асинхронная задача маршрутизации поездки (план) |
| **Жнец** | фоновое закрытие зависших `recording`-сессий в воркере |
| **routeHash** (§10.0) | детерминированный хеш маршрута (snap-to-grid 0.0005°) для группировки «концептуально одинаковых» поездок |
| **План-факт** | сравнение фактической поездки с маршрутизацией 2GIS/OSRM (Δ времени, полилайн) |
| **Спидограмма** | распределение скоростей по времени (buckets) |
| **EcoScore** (§7.3) | оценка плавности вождения CAP-методикой с корпусной калибровкой |
| **G-G-физика** | линза продольных/поперечных ускорений (центральная разность) для манёвров/резких событий |
| **TTL-кэш батча** | серверный 30-секундный LRU-кэш ответов батч-роутов (`X-Cache: ttl`) |
| **Draft-релиз** | приватный черновик GitHub Release — хранилище бэкапов (виден только write-collaborators) |
| **Read-скоп** | rate-limit-скоп 240/мин для GET-чтений собственного UI |
| **PWA** | Progressive Web App (service worker, офлайн, установка на домашний экран) |

---

*Документ сопровождается вместе с кодом: при изменении контрактов API, схемы БД или инфраструктуры обновлять соответствующие разделы. Сопутствующие документы: `docs/METHODOLOGY.md` (методика метрик), `docs/ADMIN_SPEC.md` (спецификация администратора), `docs/OPERATIONS.md` (операционные заметки).*
