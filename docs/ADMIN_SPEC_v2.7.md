# Спецификация администратора — «Телеметрия поездок»

> **Сервис:** Телеметрия поездок v2.7 · **Версия документа:** 2.7 · **Дата:** 2026-08-29
> **Объём:** 21 раздел · архитектура, деплой, токены, API, бэкапы, STRIDE, наблюдаемость
> Формат: Markdown (эквивалент DOCX-издания от 2026-08-28, приведено к релизу v2.7)

## Содержание

- [1. Введение](#1-введение)
- [2. Обзор системы](#2-обзор-системы)
  - [2.1. Архитектура](#21-архитектура)
  - [2.2. Технологический стек](#22-технологический-стек)
  - [2.3. Производственные гарантии](#23-производственные-гарантии)
- [3. Установка и развёртывание](#3-установка-и-развёртывание)
  - [3.1. Требования к окружению](#31-требования-к-окружению)
  - [3.2. Установка зависимостей](#32-установка-зависимостей)
  - [3.3. Запуск в режиме разработки](#33-запуск-в-режиме-разработки)
  - [3.4. Сборка для продакшена](#34-сборка-для-продакшена)
  - [3.5. Конфигурация render.yaml](#35-конфигурация-renderyaml)
- [4. Переменные окружения](#4-переменные-окружения)
  - [4.1. Авторизация и секреты](#41-авторизация-и-секреты)
  - [4.2. База данных и хранилище](#42-база-данных-и-хранилище)
  - [4.3. Лимиты запросов](#43-лимиты-запросов)
  - [4.4. Ворчер](#44-ворчер)
  - [4.5. Маршрутизация](#45-маршрутизация)
  - [4.6. Retention и удаление](#46-retention-и-удаление)
- [5. Авторизация и токены](#5-авторизация-и-токены)
  - [5.1. Механизмы авторизации](#51-механизмы-авторизации)
  - [5.2. Cookie с HMAC-подписью](#52-cookie-с-hmac-подписью)
  - [5.3. Ротация токенов](#53-ротация-токенов)
  - [5.4. Endpoint'ы авторизации](#54-endpointы-авторизации)
- [6. Управление данными](#6-управление-данными)
  - [6.1. Схема базы данных](#61-схема-базы-данных)
  - [6.2. Идемпотентность ingest](#62-идемпотентность-ingest)
  - [6.3. Soft-delete и grace period](#63-soft-delete-и-grace-period)
  - [6.4. Retention policy (10 лет)](#64-retention-policy-10-лет)
  - [6.5. Миграции БД](#65-миграции-бд)
- [7. API администратора](#7-api-администратора)
  - [7.1. POST /api/admin/backup](#71-post-apiadminbackup)
  - [7.2. POST /api/admin/restore](#72-post-apiadminrestore)
  - [7.3. POST /api/admin/requeue](#73-post-apiadminrequeue)
  - [7.4. GET /api/admin/jobs](#74-get-apiadminjobs)
  - [7.5. POST /api/admin/settings](#75-post-apiadminsettings)
  - [7.6. GET /api/audit](#76-get-apiaudit)
  - [7.7. POST /api/admin/backup/github](#77-post-apiadminbackupgithub)
- [8. Резервное копирование и восстановление](#8-резервное-копирование-и-восстановление)
  - [8.1. Уровень 1: Turso managed snapshots](#81-уровень-1-turso-managed-snapshots)
  - [8.2. Уровень 2: Logical dump (JSON)](#82-уровень-2-logical-dump-json)
  - [8.3. Уровень 3: GitHub backup](#83-уровень-3-github-backup)
  - [8.4. BackupJob lifecycle](#84-backupjob-lifecycle)
  - [8.5. Процедура ручного бэкапа](#85-процедура-ручного-бэкапа)
- [9. Журнал аудита](#9-журнал-аудита)
  - [9.1. Логируемые действия](#91-логируемые-действия)
  - [9.2. Структура записи AuditLog](#92-структура-записи-auditlog)
- [10. Лимиты запросов (Rate Limiting)](#10-лимиты-запросов-rate-limiting)
- [11. Безопасность](#11-безопасность)
  - [11.1. STRIDE threat model (кратко)](#111-stride-threat-model-кратко)
  - [11.2. Security headers](#112-security-headers)
  - [11.3. CORS](#113-cors)
  - [11.4. Payload-лимиты](#114-payload-лимиты)
- [12. Маршрутизация и цепочка провайдеров](#12-маршрутизация-и-цепочка-провайдеров)
  - [12.1. 2ГИС carrouting 6.0.0](#121-2гис-carrouting-600)
  - [12.2. OSRM Demo Server](#122-osrm-demo-server)
  - [12.3. Гаверсинус (40 км/ч)](#123-гаверсинус-40-кмч)
  - [12.4. Circuit breaker](#124-circuit-breaker)
  - [12.5. Snap-to-grid кэш](#125-snap-to-grid-кэш)
- [13. Ворчер (Worker)](#13-ворчер-worker)
  - [13.1. Архитектура](#131-архитектура)
  - [13.2. Атомарный захват задач](#132-атомарный-захват-задач)
  - [13.3. Обработка задачи](#133-обработка-задачи)
  - [13.4. Health endpoint](#134-health-endpoint)
  - [13.5. Graceful shutdown](#135-graceful-shutdown)
- [14. Наблюдаемость](#14-наблюдаемость)
  - [14.1. Prometheus-метрики](#141-prometheus-метрики)
  - [14.2. Health-check](#142-health-check)
  - [14.3. Структурированное логирование](#143-структурированное-логирование)
  - [14.4. AlertManager правила](#144-alertmanager-правила)
- [15. Управление настройками](#15-управление-настройками)
  - [15.1. TWO_GIS_API_KEY](#151-two_gis_api_key)
  - [15.2. TWO_GIS_PROXY_URL](#152-two_gis_proxy_url)
  - [15.3. OSRM_BASE_URL](#153-osrm_base_url)
  - [15.4. RETENTION_DAYS и GRACE_PERIOD_DAYS](#154-retention_days-и-grace_period_days)
- [16. Процедуры эксплуатации](#16-процедуры-эксплуатации)
  - [16.1. Создание резервной копии](#161-создание-резервной-копии)
  - [16.2. Восстановление из бэкапа](#162-восстановление-из-бэкапа)
  - [16.3. Повторная постановка зависшей задачи](#163-повторная-постановка-зависшей-задачи)
  - [16.4. Просмотр журнала аудита](#164-просмотр-журнала-аудита)
  - [16.5. Просмотр метрик](#165-просмотр-метрик)
  - [16.6. Проверка здоровья](#166-проверка-здоровья)
  - [16.7. Обновление API-ключа 2ГИС](#167-обновление-api-ключа-2гис)
  - [16.8. Резервное копирование в GitHub](#168-резервное-копирование-в-github)
- [17. Мониторинг и алерты](#17-мониторинг-и-алерты)
- [18. Развёртывание в продакшен](#18-развёртывание-в-продакшен)
  - [18.1. Чек-лист перед деплоем](#181-чек-лист-перед-деплоем)
  - [18.2. Миграция SQLite → Turso](#182-миграция-sqlite--turso)
- [19. Устранение неполадок](#19-устранение-неполадок)
- [20. Приложения](#20-приложения)
- [Приложение А. Полный список API endpoint'ов](#приложение-а-полный-список-api-endpointов)
- [Приложение Б. Глоссарий](#приложение-б-глоссарий)
- [21. Приёмка и критерии готовности](#21-приёмка-и-критерии-готовности)

---
## 1. Введение

Настоящий документ является исчерпывающей спецификацией администратора системы «Телеметрия поездок» версии 2.7. Документ предназначен для специалистов, отвечающих за развёртывание, настройку, мониторинг и сопровождение системы в производственной среде.

Целевая аудитория: системные администраторы, DevOps-инженеры, технические специалисты с опытом работы с Next.js, Prisma, SQLite/Turso и контейнерными технологиями. Документ предполагает базовое понимание HTTP API, принципов авторизации и баз данных.

Область применения: все компоненты системы — API-сервер на Next.js 16, ворчер-мини-сервис на Bun, база данных SQLite/Turso, фронтенд (веб-панель и мобильный интерфейс), а также интеграции с внешними сервисами (2ГИС, OSRM, GitHub, Vercel/Render).

Документ дополняет архитектурную спецификацию v2.7 и техническое задание «Метрики и мобильный интерфейс» v1.0, фокусируясь на эксплуатационных аспектах: установка, настройка, резервное копирование, мониторинг, устранение неполадок.

## 2. Обзор системы

«Телеметрия поездок» — это сервис непрерывного сбора, хранения и анализа GPS-данных автомобильных поездок с план-фактным анализом. Система ориентирована на личное использование (однопользовательская модель) и предназначена для владельца-водителя, записывающего поездки через приложение Sensor Logger на iPhone.

### 2.1. Архитектура

Система построена по клиент-серверной модели с четырьмя основными компонентами:

- Мобильный клиент — приложение Sensor Logger на iPhone, отправляющее GPS-точки через HTTP API.

- API-сервер — Next.js 16 (App Router) с API Routes, обрабатывающий ingest, CRUD сессий и маршрутов, экспорт, администрирование.

- Ворчер — отдельный процесс на Bun (порт 3001), опрашивающий очередь TrafficJob и обрабатывающий задачи маршрутизации (2ГИС → OSRM → гаверсинус).

- Веб-клиент — React-фронтенд с Leaflet-картой, 5 вкладок (Обзор, Поездки, Маршруты, Импорт, Администрирование) и мобильным интерфейсом на /m.

### 2.2. Технологический стек

| **Слой**                  | **Технология**                       | **Назначение**                               |
|---------------------------|--------------------------------------|----------------------------------------------|
| Фронтенд                  | Next.js 16 (App Router)              | SSR/SSG, React Server Components, API Routes |
| Стилизация                | Tailwind CSS 4 + OKLCH               | Адаптивная вёрстка, CSS-переменные темы      |
| Карта                     | React-Leaflet + Leaflet              | Интерактивная карта с GPS-треком             |
| Валидация                 | Zod                                  | Схемы валидации всех API-запросов            |
| ORM                       | Prisma 6.x                           | Типобезопасные запросы к БД                  |
| БД (прод)                 | Turso / LibSQL                       | Реплицируемая SQLite                         |
| БД (dev)                  | SQLite (локальный)                   | Локальная разработка                         |
| Маршрутизация             | 2ГИС carrouting 6.0.0                | Построение маршрутов и пробки                |
| Маршрутизация (резерв)    | OSRM Demo Server                     | Fallback при отказе 2ГИС                     |
| Маршрутизация (последний) | Гаверсинус (40 км/ч)                 | Прямая дистанция                             |
| Ворчер                    | Bun (порт 3001)                      | Асинхронная обработка TrafficJob             |
| Логирование               | Pino (JSON)                          | Структурированные логи с requestId           |
| Метрики                   | prom-client                          | Prometheus text exposition на /api/metrics   |
| Лимиты                    | In-memory LRU / Redis sliding window | Защита от перегрузки                         |
| Деплой                    | Render / Vercel Pro                  | Контейнеризация или serverless               |

### 2.3. Производственные гарантии

Система спроектирована с учётом production-grade требований. Ключевые гарантии: безопасность (STRIDE threat model, 18 угроз), надёжность (изолированный ворчер, верифицируемый захват задач через UPDATE ... RETURNING id, circuit breaker для 2ГИС), сохранность данных (retention 10 лет, soft-delete с grace period 30 дней, 3 уровня резервного копирования с RPO 1 час / RTO 30 минут), наблюдаемость (Prometheus-метрики, AlertManager, структурированные логи).

## 3. Установка и развёртывание

### 3.1. Требования к окружению

| **Компонент**      | **Минимальная версия** | **Рекомендация**                  |
|--------------------|------------------------|-----------------------------------|
| Node.js            | 20.x                   | 24.x LTS                          |
| Bun                | 1.1.x                  | 1.2.x (для ворчера)               |
| Оперативная память | 512 МБ                 | 2 ГБ (для dev с Turbopack)        |
| Диск               | 1 ГБ                   | 10 ГБ (с учётом retention 10 лет) |
| SQLite / Turso     | LibSQL 0.17+           | Turso для продакшена              |

### 3.2. Установка зависимостей

```
# Клонирование репозитория git clone <repo-url> telemetria cd telemetria # Установка зависимостей bun install # Генерация Prisma клиента bun run db:generate # Применение схемы к БД bun run db:push
```

### 3.3. Запуск в режиме разработки

```
# Запуск dev-сервера (порт 3000) bun run dev # Запуск ворчера в отдельном терминале (порт 3001) cd mini-services/worker bun --hot index.ts
```

В песочнице ворчер запускается автоматически через instrumentation.ts (in-process). В продакшене — как отдельный сервис.

### 3.4. Сборка для продакшена

```
# Сборка Next.js bun run build # Запуск продакшен-сервера bun run start # node .next/standalone/server.js
```

### 3.5. Конфигурация render.yaml

Для развёртывания на Render используется конфигурация render.yaml. В ней определены два сервиса: web (Next.js) и worker (Bun), с переменными окружения и health-check.

```
services: - type: web name: telemetria-web env: node buildCommand: bun install && bun run build startCommand: bun run start healthCheckPath: /health envVars: - key: DATABASE_URL sync: false - key: LOGIN_PASSWORD sync: false # ... остальные env vars - type: worker name: telemetria-worker env: bun buildCommand: bun install startCommand: cd mini-services/worker && bun index.ts envVars: - key: CRON_SECRET sync: false
```

## 4. Переменные окружения

Все переменные окружения централизованно определены в src/lib/env.ts через Zod-схему с мягкой валидацией и значениями по умолчанию. При отсутствии переменной используется дефолт, система не падает.

### 4.1. Авторизация и секреты

| **Переменная** | **По умолчанию**        | **Описание**                                    |
|----------------|-------------------------|-------------------------------------------------|
| LOGIN_PASSWORD | change-me-please-...    | Пароль входа (≥32 символа, timing-safe compare) |
| SESSION_SECRET | super-secret-...        | Секрет для HMAC-подписи cookie (≥32 символа)    |
| API_KEY        | api-key-server-side-... | Bearer-токен для server-side чтения (≥32)       |
| INGEST_TOKEN   | ingest-token-...        | Bearer-токен для /api/ingest (≥32)              |
| CRON_SECRET    | cron-secret-...         | Bearer-токен для ворчера (≥32)                  |
| ADMIN_TOKEN    | admin-token-...         | Bearer-токен для админ-операций (≥32)           |

**⚠️ Критично: в продакшене ВСЕ секреты должны быть заменены на сильные случайные значения длиной не менее 32 символов. Значения по умолчанию — только для разработки.**

### 4.2. База данных и хранилище

| **Переменная**              | **По умолчанию**    | **Описание**                                   |
|-----------------------------|---------------------|------------------------------------------------|
| DATABASE_URL                | file:./db/custom.db | URL БД (file: для SQLite, libsql:// для Turso) |
| TURSO_AUTH_TOKEN            | (нет)               | Токен аутентификации Turso (для libsql://)     |
| EXPORT_STORAGE_DIR          | /tmp/exports        | Директория для файлов экспорта                 |
| EXPORT_ASYNC_THRESHOLD      | 5000                | Порог асинхронного экспорта (точек)            |
| EXPORT_URL_TTL_HOURS        | 24                  | Срок действия ссылки на файл экспорта (часы)   |
| EXPORT_MAX_FILE_BYTES       | 104857600           | Максимальный размер файла экспорта (100 МБ)    |
| BACKUP_STORAGE_DIR          | /tmp/backups        | Директория для резервных копий                 |
| BACKUP_MAX_ATTEMPTS         | 3                   | Максимальное число попыток бэкапа              |
| BACKUP_VERIFICATION_ENABLED | true                | Верификация контрольной суммой                 |

### 4.3. Лимиты запросов

| **Переменная**         | **По умолчанию** | **Описание**                                        |
|------------------------|------------------|-----------------------------------------------------|
| RATE_LIMIT_BACKEND     | memory           | memory (single-instance) или redis (multi-instance) |
| RATE_LIMIT_MAX_INGEST  | 120              | Лимит /api/ingest (запросов/60с)                    |
| RATE_LIMIT_MAX_DEFAULT | 60               | Лимит по умолчанию для /api/*                      |
| RATE_LIMIT_MAX_AUTH    | 5                | Лимит /api/auth/login (защита от брутфорса)         |
| RATE_LIMIT_MAX_PLAN    | 5                | Лимит /api/plan                                     |
| RATE_LIMIT_MAX_AUDIT   | 60               | Лимит /api/audit                                    |
| RATE_LIMIT_MAX_ADMIN   | 1                | Лимит /api/admin/backup и /restore (в час)          |
| MAX_PAYLOAD_BYTES      | 262144           | Максимальный размер payload (256 КБ)                |
| TARGET_LOAD_RPM        | 100              | Целевая нагрузка (сессий/мин)                       |

### 4.4. Ворчер

| **Переменная**          | **По умолчанию**      | **Описание**                          |
|-------------------------|-----------------------|---------------------------------------|
| WORKER_ID               | worker-local          | Идентификатор инстанса ворчера        |
| WORKER_PORT             | 3001                  | Порт HTTP API ворчера                 |
| WORKER_POLL_INTERVAL_MS | 5000                  | Интервал опроса очереди (мс)          |
| WORKER_BATCH_SIZE       | 10                    | Размер батча захвата задач            |
| WORKER_MAX_CONCURRENCY  | 5                     | Максимальная конкурентность (p-limit) |
| WORKER_API_BASE         | http://localhost:3000 | Базовый URL API (для ворчера)         |

### 4.5. Маршрутизация

| **Переменная**              | **По умолчанию**                | **Описание**                          |
|-----------------------------|---------------------------------|---------------------------------------|
| TWO_GIS_API_KEY             | (пусто)                         | API-ключ 2ГИС (для carrouting 6.0.0)  |
| TWO_GIS_PROXY_URL           | (пусто)                         | URL прокси для обхода блокировок 2ГИС |
| OSRM_BASE_URL               | https://router.project-osrm.org | URL OSRM-сервера                      |
| CIRCUIT_BREAKER_THRESHOLD   | 5                               | Порог отказов для размыкания цепи     |
| CIRCUIT_BREAKER_TIMEOUT_SEC | 30                              | Таймаут разомкнутого состояния (сек)  |

### 4.6. Retention и удаление

| **Переменная**            | **По умолчанию** | **Описание**                         |
|---------------------------|------------------|--------------------------------------|
| RETENTION_DAYS            | 3650             | Срок хранения сессий (10 лет)        |
| GRACE_PERIOD_DAYS         | 30               | Срок мягкого удаления до hard-delete |
| RETENTION_ARCHIVE_ENABLED | true             | Авто-архивация перед удалением       |
| ARCHIVE_RETENTION_DAYS    | 3650             | Срок хранения архивов                |
| AUDIT_RETENTION_DAYS      | 3650             | Срок хранения журнала аудита         |

## 5. Авторизация и токены

Система использует однопользовательскую модель (single-user, personal-use). Модель User НЕ вводится как преждевременная оптимизация. Все данные принадлежат единственному владельцу. IDOR-риск неприменим. Любой аутентифицированный запрос имеет полный доступ.

### 5.1. Механизмы авторизации

| **Механизм**        | **Применение**                                   | **Хранение**                           |
|---------------------|--------------------------------------------------|----------------------------------------|
| Cookie (HMAC)       | Веб-клиент → все API                             | HttpOnly, Secure, SameSite=Strict, 24ч |
| Bearer API_KEY      | Server-side чтение (SSR/RSC)                     | Env var, never in bundle               |
| Bearer INGEST_TOKEN | Sensor Logger → /api/ingest                      | Env var                                |
| Bearer CRON_SECRET  | Ворчер → worker API, cron                        | Env var                                |
| Bearer ADMIN_TOKEN  | Админ-операции (backup, restore, requeue, audit) | Env var, ≥32 символа                   |

### 5.2. Cookie с HMAC-подписью

Имя cookie: telem_session (dev, без префикса __Host-) / __Host-telem_session (продакшен, с префиксом). Атрибуты: HttpOnly (защита от XSS), Secure (только HTTPS в продакшене), SameSite=Strict (защита от CSRF), Path=/, Max-Age=86400 (24 часа).

Payload cookie: base64url(JSON({sub:"owner", iat, exp})) + "." + base64url(HMAC-SHA256(SESSION_SECRET, payload)). Срок действия: iat + 86400 секунд. Sliding renewal: если exp - now < 3600 (1 час) — cookie перевыпускается в ответе.

### 5.3. Ротация токенов

Для ротации любого токена: обновить значение в переменной окружения, перезапустить сервис. Все активные сессии остаются валидными (cookie не зависит от токенов). Для инвалидации всех cookie — сменить SESSION_SECRET, после чего все существующие подписи станут невалидными.

### 5.4. Endpoint'ы авторизации

| **Endpoint**       | **Метод** | **Назначение**                      |
|--------------------|-----------|-------------------------------------|
| /api/auth/login    | POST      | Вход (установка cookie)             |
| /api/auth/logout   | POST      | Выход (удаление cookie)             |
| /api/auth/me       | GET       | Проверка текущей сессии             |
| /api/auth/register | POST      | Регистрация (multi-user расширение) |

Лимит на /api/auth/login: 5 запросов в минуту с IP (защита от брутфорса). При превышении — HTTP 429 с retryAfter: 60.

## 6. Управление данными

### 6.1. Схема базы данных

Схема содержит 8 моделей: User, Session, GpsPoint, Route, RouteCache, TrafficJob, AuditLog, ExportJob, BackupJob. Ключевые отношения и индексы:

| **Модель** | **Назначение**                       | **Ключевые поля**                                                                           |
|------------|--------------------------------------|---------------------------------------------------------------------------------------------|
| User       | Пользователь (multi-user расширение) | email, passwordHash, role, apiKey                                                           |
| Session    | Поездка                              | deviceId, clientId, startTime, endTime, pointCount, status, deletedAt, routeId, notes, tags |
| GpsPoint   | GPS-точка                            | sessionId, lat, lon, speed, altitude, accuracy, timestamp (BigInt), bearing                 |
| Route      | Избранный маршрут                    | name, startLat/Lon, endLat/Lon                                                              |
| RouteCache | Кэш маршрутизации                    | hash (unique), result JSON, todBucket, expiresAt                                            |
| TrafficJob | Задача обработки трафика             | sessionId, status, attempts, priority, scheduledFor, lockedBy, result, error                |
| AuditLog   | Журнал аудита                        | action, targetId, targetType, actorType, metadata, createdAt                                |
| ExportJob  | Задача экспорта                      | sessionId, format, status, fileUrl, expiresAt                                               |
| BackupJob  | Задача резервного копирования        | status, type, filePath, checksum, attempts                                                  |

### 6.2. Идемпотентность ingest

Поле clientId (UUID) в Session обеспечивает идемпотентность. Уникальный индекс @@unique([deviceId, clientId]) предотвращает дубликаты. При повторной отправке того же пакета возвращается существующая сессия с duplicate: true (HTTP 200 вместо 201).

### 6.3. Soft-delete и grace period

Удаление сессии — мягкое: устанавливается deletedAt = now(), статус = 'deleted'. Grace period — 30 дней (GRACE_PERIOD_DAYS). В течение этого периода сессия исключается из списков, но остаётся в БД и может быть восстановлена. После истечения grace period — hard delete через retention-cron.

### 6.4. Retention policy (10 лет)

Политика хранения: RETENTION_DAYS = 3650 (10 лет). Обоснование: соответствует максимальному сроку хранения персональных данных по законодательству РФ для личной аналитики. Ежедневная cron-задача (00:30 UTC) проверяет сессии с endTime < now - RETENTION_DAYS и удаляет их. Перед удалением создаётся ExportJob (JSON-архив), если RETENTION_ARCHIVE_ENABLED = true.

### 6.5. Миграции БД

Миграции следуют принципу expand-contract: сначала добавляем новые поля/таблицы (expand), затем переносим данные, затем удаляем старые (contract). Проверка деструктивных миграций через scripts/check-migrations.sh (prisma migrate diff + grep на DROP, DELETE, RENAME). В песочнице используется bun run db:push (без миграций, прямая синхронизация схемы).

## 7. API администратора

Все админские endpoint'ы требуют Bearer ADMIN_TOKEN (≥32 символа) в заголовке Authorization. Лимиты жёсткие — 1 запрос в час на backup/restore.

### 7.1. POST /api/admin/backup

Создание резервной копии базы данных. Возвращает backupId и статус pending. Резервное копирование выполняется синхронно в route handler (в песочнице) или через BackupJob (в продакшене).

**Запрос:**

```
POST /api/admin/backup Authorization: Bearer <ADMIN_TOKEN> Content-Type: application/json { }
```

**Ответ 202:**

```
{ "backupId": "cmbk_xxx...", "status": "pending", "createdAt": "2026-08-28T12:00:00Z" }
```

**Пример curl:**

```
curl -X POST https://your-domain/api/admin/backup \\ -H "Authorization: Bearer admin-token-32-chars-minimum-cccccccc"
```

Лимит: 1 запрос в час. Верификация: контрольная сумма SHA-256, размер файла. Срок хранения: 90 дней rolling.

### 7.2. POST /api/admin/restore

Восстановление базы данных из резервной копии. Указывается backupId существующей копии.

**Запрос:**

```
POST /api/admin/restore Authorization: Bearer <ADMIN_TOKEN> Content-Type: application/json { "backupId": "cmbk_xxx..." }
```

**Ответ 202:**

```
{ "status": "pending", "backupId": "cmbk_xxx..." }
```

Лимит: 1 запрос в час. Восстановление — деструктивная операция, записывается в AuditLog.

### 7.3. POST /api/admin/requeue

Повторная постановка зависшей задачи (dead TrafficJob) в очередь. Указывается jobId.

**Запрос:**

```
POST /api/admin/requeue Authorization: Bearer <ADMIN_TOKEN> Content-Type: application/json { "jobId": "cmtj_xxx..." }
```

**Ответ 200:**

```
{ "ok": true, "jobId": "cmtj_xxx...", "status": "pending" }
```

Лимит: 10 запросов в минуту. Используется для восстановления dead-задач (status='dead', attempts ≥ 3).

### 7.4. GET /api/admin/jobs

Список TrafficJob с фильтрами по статусу. Возвращает задачи с информацией о сессии.

```
GET /api/admin/jobs?status=dead&limit=50 Authorization: Bearer <ADMIN_TOKEN>
```

**Ответ 200:**

```
{ "jobs": [ { "id": "cmtj_xxx", "sessionId": "cms_xxx", "status": "dead", "attempts": 3, "error": "2ГИС timeout", "createdAt": "...", "updatedAt": "...", "session": { "deviceId": "iphone-12", "startTime": "..." } } ] }
```

### 7.5. POST /api/admin/settings

Управление настройками системы: TWO_GIS_API_KEY, TWO_GIS_PROXY_URL, OSRM_BASE_URL. Настройки хранятся в БД (таблица Settings) и кэшируются в памяти.

```
POST /api/admin/settings Authorization: Bearer <ADMIN_TOKEN> Content-Type: application/json { "TWO_GIS_API_KEY": "new-key-value", "OSRM_BASE_URL": "https://my-osrm.example.com" }
```

После обновления настроек кэш инвалидируется. Изменения применяются немедленно для новых запросов.

### 7.6. GET /api/audit

Чтение журнала аудита с курсорной пагинацией и фильтрами.

```
GET /api/audit?cursor=xxx&limit=50&action=session.delete&actorType=user Authorization: Bearer <ADMIN_TOKEN>
```

**Ответ 200:**

```
{ "logs": [ { "id": "cmal_xxx", "action": "session.delete", "targetId": "cms_xxx", "targetType": "Session", "actorType": "user", "actorId": "owner", "metadata": "{\\pointCount\\: 245, \\reason\\: \\user-request\\}", "createdAt": "2026-08-28T12:00:00Z" } ], "nextCursor": "cury_yyy" }
```

Лимит: 60 запросов в минуту. Фильтры: action (contains), actorType, targetType, cursor.

### 7.7. POST /api/admin/backup/github

Резервное копирование в GitHub-репозиторий. Создаёт коммит с JSON-дампом БД в указанную ветку. Требует GITHUB_TOKEN в настройках.

```
POST /api/admin/backup/github Authorization: Bearer <ADMIN_TOKEN> Content-Type: application/json { "repo": "markovsaratov-crypto/telemetria-backups", "branch": "main", "path": "backups/" }
```

## 8. Резервное копирование и восстановление

Система реализует 3 уровня резервного копирования для обеспечения RPO 1 час / RTO 30 минут.

### 8.1. Уровень 1: Turso managed snapshots

Turso предоставляет автоматические point-in-time snapshots ежечасно. Хранение 7 дней. Восстановление — через Turso CLI (turso db restore). Не требует действий администратора.

### 8.2. Уровень 2: Logical dump (JSON)

Ежедневный логический дамп через BackupJob. Полный экспорт всех таблиц в JSON-файл. Хранение 90 дней rolling. Файл сохраняется в BACKUP_STORAGE_DIR (или S3-совместимое хранилище). Верификация: контрольная сумма SHA-256, размер файла, обратное чтение.

### 8.3. Уровень 3: GitHub backup

Дополнительная копия JSON-дампа в GitHub-репозиторий. Создаёт коммит в указанной ветке. Преимущество: бесплатное хранение, версионирование, доступ из любой точки. Настраивается через POST /api/admin/backup/github.

### 8.4. BackupJob lifecycle

| **Статус** | **Описание**                     | **Действия**                                            |
|------------|----------------------------------|---------------------------------------------------------|
| pending    | Создана, ожидает выполнения      | Выбирается ворчером                                     |
| running    | Ворчер захватил (lockedBy)       | Генерация дампа, загрузка в хранилище                   |
| completed  | Успешно завершена                | filePath, fileSize, checksum заполнены                  |
| failed     | Ошибка после BACKUP_MAX_ATTEMPTS | error заполнен, retry через BACKUP_RETRY_INTERVAL_HOURS |

### 8.5. Процедура ручного бэкапа

Шаги для создания резервной копии вручную:

- 1\. Получить ADMIN_TOKEN из переменных окружения.

- 2\. Выполнить POST /api/admin/backup с заголовком Authorization.

- 3\. Сохранить возвращённый backupId.

- 4\. Проверить статус через GET /api/admin/jobs (фильтр по backupId).

- 5\. После completed — скачать файл из BACKUP_STORAGE_DIR.

- 6\. Проверить контрольную сумму: sha256sum backup.json == checksum из ответа.

## 9. Журнал аудита

Журнал аудита фиксирует все деструктивные и административные операции. Хранится в таблице AuditLog. Срок хранения: AUDIT_RETENTION_DAYS (10 лет по умолчанию).

### 9.1. Логируемые действия

| **Действие**   | **Цель**   | **Метаданные**                       |
|----------------|------------|--------------------------------------|
| session.delete | Session    | pointCount, reason, gracePeriodDays  |
| session.export | Session    | format, fileSize                     |
| session.share  | Session    | token (первые 8 символов), expiresAt |
| session.notes  | Session    | notes (bool), tags                   |
| session.purge  | Session    | archivedUrl, pointCount, ageDays     |
| admin.backup   | BackupJob  | backupId, fileSize, checksum         |
| admin.restore  | BackupJob  | backupId                             |
| admin.requeue  | TrafficJob | jobId, previousStatus                |
| admin.settings | Settings   | changedKeys[]                      |

### 9.2. Структура записи AuditLog

| **Поле**   | **Тип**       | **Описание**                                      |
|------------|---------------|---------------------------------------------------|
| id         | String (cuid) | Уникальный идентификатор                          |
| action     | String        | Тип действия (см. таблицу выше)                   |
| targetId   | String        | ID целевого объекта                               |
| targetType | String        | Тип целевого объекта (Session, BackupJob, и т.д.) |
| actorType  | String        | user \| system \| api \| retention-cron           |
| actorId    | String?       | ID инициатора (owner, api, worker-local)          |
| metadata   | String (JSON) | Дополнительные данные в JSON                      |
| sessionId  | String?       | Связанная сессия (если применимо)                 |
| createdAt  | DateTime      | Время события                                     |

## 10. Лимиты запросов (Rate Limiting)

Защита от перегрузки и злоупотреблений. Реализация: in-memory LRU (single-instance, песочница) или Redis sliding window (multi-instance, продакшен). Выбор через RATE_LIMIT_BACKEND.

| **Endpoint**       | **Лимит**  | **Окно** | **Ключ**                 |
|--------------------|------------|----------|--------------------------|
| /api/ingest        | 120        | 60 сек   | IP + INGEST_TOKEN        |
| /api/plan          | 5          | 60 сек   | API_KEY                  |
| /api/auth/login    | 5          | 60 сек   | IP (защита от брутфорса) |
| /api/admin/backup  | 1          | 3600 сек | ADMIN_TOKEN              |
| /api/admin/restore | 1          | 3600 сек | ADMIN_TOKEN              |
| /api/admin/requeue | 10         | 60 сек   | ADMIN_TOKEN              |
| /api/audit         | 60         | 60 сек   | ADMIN_TOKEN              |
| Прочие /api/*     | 60         | 60 сек   | IP                       |
| /api/health        | без лимита | —        | —                        |

При превышении лимита — HTTP 429 с телом { error: "Rate limit exceeded", retryAfter: 60 }. Заголовок X-RateLimit-Remaining содержит оставшееся количество запросов.

## 11. Безопасность

### 11.1. STRIDE threat model (кратко)

Система анализируется по модели STRIDE (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege). 18 угроз идентифицированы, для каждой — митигация.

| **Категория**          | **Угроза**                   | **Митигация**                                        |
|------------------------|------------------------------|------------------------------------------------------|
| Spoofing               | Подделка cookie сессии       | HMAC-SHA256 подпись с SESSION_SECRET                 |
| Spoofing               | Подделка Bearer-токена       | Сравнение с env var, timing-safe                     |
| Tampering              | Модификация GPS-точек        | Zod-валидация, Prisma parameterized queries          |
| Tampering              | SQL-инъекция                 | Prisma parameterized queries (no raw SQL)            |
| Repudiation            | Отказ от действия            | AuditLog всех деструктивных операций                 |
| Information Disclosure | Утечка токенов в bundle      | NEXT_PUBLIC_ не используется                        |
| Information Disclosure | IDOR                         | Неприменим (single-user модель)                      |
| Denial of Service      | Flood /api/ingest            | Rate limit 120/мин, in-memory LRU                    |
| Denial of Service      | Брутфорс /api/auth/login     | Rate limit 5/мин с IP                                |
| Elevation of Privilege | Обычный пользователь → админ | Разделение токенов по scope (API_KEY vs ADMIN_TOKEN) |

### 11.2. Security headers

Middleware устанавливает заголовки безопасности на все ответы:

- X-Content-Type-Options: nosniff

- X-Frame-Options: DENY

- Referrer-Policy: strict-origin-when-cross-origin

- Permissions-Policy: geolocation=(), camera=(), microphone=()

- Strict-Transport-Security: max-age=31536000; includeSubDomains (продакшен)

- Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'

### 11.3. CORS

CORS разрешён только для same-origin запросов. Для внешних клиентов (Sensor Logger) — заголовок Authorization: Bearer, без CORS (cross-origin по умолчанию запрещён).

### 11.4. Payload-лимиты

- Максимальный размер ingest payload: 256 КБ (MAX_PAYLOAD_BYTES).

- Максимальное количество точек в пакете: 1000.

- Максимальный размер CSV/ZIP импорта: 100 МБ (middleware).

- Превышение — HTTP 413 Payload Too Large.

## 12. Маршрутизация и цепочка провайдеров

Построение маршрутов выполняется по цепочке: 2ГИС (primary) → OSRM (fallback) → гаверсинус (последний шанс). Каждый провайдер имеет таймаут и circuit breaker.

### 12.1. 2ГИС carrouting 6.0.0

Primary провайдер. API: https://routing.api.2gis.ru/carrouting/6.0.0. Требует TWO_GIS_API_KEY. Возвращает: геометрию маршрута, плановую дистанцию, плановое время, данные о пробках по сегментам (trafficSpeed, trafficDuration). Таймаут: 8 секунд.

### 12.2. OSRM Demo Server

Fallback при отказе 2ГИС. URL: https://router.project-osrm.org (OSRM_BASE_URL). Бесплатный демо-сервер, без данных о пробках. Возвращает: геометрию, дистанцию, время. Таймаут: 8 секунд.

### 12.3. Гаверсинус (40 км/ч)

Последний резерв. Вычисляет прямую дистанцию между стартом и финишем по формуле гаверсинуса. Время = distance / (40 км/ч / 3.6) — предположение средней скорости 40 км/ч для городской среды. Не возвращает геометрию (только прямую линию).

### 12.4. Circuit breaker

Защита от лавины timeout-ов при отказе 2ГИС. При CIRCUIT_BREAKER_THRESHOLD (5) последовательных отказах в течение 1 минуты — circuit breaker размыкается на CIRCUIT_BREAKER_TIMEOUT_SEC (30) секунд. Все запросы сразу идут на OSRM без попытки 2ГИС. После 30 сек — half-open: один пробный запрос к 2ГИС, при успехе — замыкание (возврат к primary).

### 12.5. Snap-to-grid кэш

Двухуровневое кэширование результатов маршрутизации. Ключ: hash(snap-to-grid(start, end) + tod_bucket). Snap-to-grid: округление координат до сетки ~55 м × ~35 м (погрешность приемлема для автомобильной маршрутизации). Time-of-day бакеты: 0, 3, 6, 9, 12, 15, 18, 21 (час) — учитывает зависимость пробок от времени суток. TTL кэша: настраиваемый (по умолчанию 24 часа). Хранилище: in-memory LRU + SQLite persistent (RouteCache).

## 13. Ворчер (Worker)

Ворчер — отдельный процесс для асинхронной обработки TrafficJob. Изолирован от API event loop. В песочнице запускается in-process через instrumentation.ts. В продакшене — как мини-сервис на Bun (порт 3001).

### 13.1. Архитектура

- Порт: 3001 (WORKER_PORT, жёстко задан).

- Poll-loop: каждые WORKER_POLL_INTERVAL_MS (5 сек) запрашивает pending задачи.

- Батч: до WORKER_BATCH_SIZE (10) задач за один poll.

- Конкурентность: p-limit(WORKER_MAX_CONCURRENCY=5) — максимум 5 задач одновременно.

- Таймаут на задачу: 15 секунд (race с Promise.race).

- Retry: делегирован API. При failed — backoff 1с/2с/4с, максимум 3 попытки, затем dead.

### 13.2. Атомарный захват задач

Захват задачи — атомарная операция через SQL UPDATE ... RETURNING id. Это предотвращает двойную обработку одной задачи двумя инстансами ворчера:

```
UPDATE TrafficJob SET status = 'running', lockedBy = ?, lockedAt = ?, updatedAt = ? WHERE id IN ( SELECT id FROM TrafficJob WHERE status = 'pending' AND scheduledFor <= ? ORDER BY priority DESC, scheduledFor ASC LIMIT ? ) RETURNING id, sessionId, attempts;
```

### 13.3. Обработка задачи

Алгоритм обработки одной TrafficJob:

- 1\. Загрузить session.gpsPoints (только lat, lon, speed).

- 2\. Фильтр: активная часть = от первой точки speed>0 до последней speed>0.

- 3\. Если точек < 2 — завершить с provider='haversine', distanceM=0.

- 4\. Взять start = первая точка, end = последняя точка.

- 5\. Вызвать routeRequest(start, end) — цепочка 2ГИС → OSRM → гаверсинус.

- 6\. При успехе — completeJob(status='completed', result={provider, distanceM, durationSec, segments, trafficFetched}).

- 7\. При ошибке — completeJob(status='failed', error=msg). Если attempts < 3 — backoff и возврат в pending.

- 8\. Обновить Session.status = 'completed' при успешном завершении.

### 13.4. Health endpoint

```
GET /health?XTransformPort=3001 { "status": "ok", "workerId": "worker-local", "pendingJobs": 0, "runningJobs": 0, "inFlight": 0, "apiRunningJobs": 0, "totalProcessed": 42, "totalFailed": 1, "uptimeSec": 3600, "version": "2.7.0" }
```

### 13.5. Graceful shutdown

При SIGINT/SIGTERM ворчер:

- 1\. Устанавливает shuttingDown = true, останавливает poll-timer.

- 2\. Ждёт до 10 секунд завершения in-flight задач.

- 3\. Останавливает HTTP-сервер (server.stop(true)).

- 4\. Exit 0.

## 14. Наблюдаемость

### 14.1. Prometheus-метрики

Метрики доступны на GET /api/metrics в формате Prometheus text exposition. Используется библиотека prom-client.

| **Метрика**                   | **Тип**           | **Описание**                                |
|-------------------------------|-------------------|---------------------------------------------|
| ingest_total                  | counter           | Всего запросов ingest                       |
| ingest_duplicate_total        | counter           | Дубликаты (идемпотентность)                 |
| traffic_job_completed_total   | counter           | Завершённые TrafficJob                      |
| traffic_job_failed_total      | counter           | Проваленные TrafficJob                      |
| routing_fallback_total        | counter           | Fallback на резервный провайдер             |
| routing_provider              | counter (labeled) | По провайдеру: 2gis, osrm, haversine        |
| rate_limit_rejected_total     | counter           | Отклонено лимитом                           |
| session_delete_total          | counter           | Soft-delete сессий                          |
| export_total                  | counter (labeled) | По формату и статусу                        |
| export_duration_seconds       | histogram         | Длительность экспорта                       |
| retention_purge_total         | counter (labeled) | Очистка по retention (archived=true\|false) |
| retention_purge_age_seconds   | histogram         | Возраст удалённых сессий                    |
| worker_pending_jobs           | gauge             | Ожидающие TrafficJob                        |
| worker_running_jobs           | gauge             | Выполняющиеся TrafficJob                    |
| http_request_duration_seconds | histogram         | Длительность HTTP-запросов                  |

### 14.2. Health-check

```
GET /health { "status": "ok", "db": "ok", "worker": "ok", "circuits": { "2gis": "closed", "osrm": "closed" }, "rateLimiter": { "buckets": 0, "backend": "memory" }, "version": "2.7.0", "uptime": 3600, "targetLoadRpm": 100, "rateLimitMaxIngest": 120 }
```

Эндпоинт без авторизации и без лимита. Используется для uptime-мониторинга (Render/Vercel health check, keep-alive cron).

### 14.3. Структурированное логирование

Логи в формате JSON (Pino-совместимый). Каждая запись содержит: time, level, msg, requestId (сквозной идентификатор запроса), и контекстные поля (sessionId, jobId, deviceId, и т.д.).

```
{"time":"2026-08-28T12:00:00.000Z","level":"info","msg":"job completed","requestId":"uuid","jobId":"cmtj_xxx","status":"completed","provider":"osrm","distanceM":12345,"durationSec":678}
```

### 14.4. AlertManager правила

| **Правило**           | **Условие**                    | **Действие**         |
|-----------------------|--------------------------------|----------------------|
| ingest_error_rate     | errors/total > 5% за 5 мин    | Алерт в Slack/email  |
| traffic_job_dead_rate | dead/total > 10% за 1 час     | Проверить 2ГИС API   |
| backup_failure        | status=failed 3 раза подряд    | Ручное вмешательство |
| db_size_growth        | рост > 100 МБ/день            | Проверить retention  |
| api_latency_p95       | p95 > 2 сек за 5 мин          | Масштабирование      |
| worker_stuck          | pending > 50 в течение 10 мин | Перезапуск ворчера   |

## 15. Управление настройками

### 15.1. TWO_GIS_API_KEY

API-ключ для доступа к 2ГИС carrouting 6.0.0. Получение: кабинет разработчика 2ГИС (https://dev.2gis.ru). Хранение: в таблице Settings (зашифровано) или в env var TWO_GIS_API_KEY. Ротация: через POST /api/admin/settings. Без ключа — сразу fallback на OSRM.

### 15.2. TWO_GIS_PROXY_URL

URL прокси-сервера для обхода региональных блокировок 2ГИС. Если 2ГИС недоступен из дата-центра (например, Vercel US), запросы направляются через прокси. Формат: https://proxy.example.com/. Пусто — прямое подключение.

### 15.3. OSRM_BASE_URL

URL OSRM-сервера. По умолчанию: https://router.project-osrm.org (демо, без гарантий SLA). Для продакшена рекомендуется self-hosted OSRM (Docker-контейнер с данными OSM региона).

### 15.4. RETENTION_DAYS и GRACE_PERIOD_DAYS

RETENTION_DAYS: срок хранения сессий до hard-delete (3650 дней = 10 лет). GRACE_PERIOD_DAYS: срок мягкого удаления до физического удаления (30 дней). Изменение через env var, применяется немедленно.

## 16. Процедуры эксплуатации

### 16.1. Создание резервной копии

```
# 1. Создать бэкап curl -X POST https://your-domain/api/admin/backup \\ -H "Authorization: Bearer $ADMIN_TOKEN" # 2. Проверить статус curl https://your-domain/api/admin/jobs?status=completed \\ -H "Authorization: Bearer $ADMIN_TOKEN" # 3. Скачать файл scp server:/tmp/backups/backup-xxx.json . # 4. Верифицировать sha256sum backup-xxx.json
```

### 16.2. Восстановление из бэкапа

```
curl -X POST https://your-domain/api/admin/restore \\ -H "Authorization: Bearer $ADMIN_TOKEN" \\ -H "Content-Type: application/json" \\ -d '{"backupId": "cmbk_xxx"}'
```

### 16.3. Повторная постановка зависшей задачи

```
# 1. Найти dead-задачи curl https://your-domain/api/admin/jobs?status=dead \\ -H "Authorization: Bearer $ADMIN_TOKEN" # 2. Повторно поставить в очередь curl -X POST https://your-domain/api/admin/requeue \\ -H "Authorization: Bearer $ADMIN_TOKEN" \\ -H "Content-Type: application/json" \\ -d '{"jobId": "cmtj_xxx"}'
```

### 16.4. Просмотр журнала аудита

```
# Последние 50 записей curl "https://your-domain/api/audit?limit=50" \\ -H "Authorization: Bearer $ADMIN_TOKEN" # Фильтр по действию curl "https://your-domain/api/audit?action=session.delete&limit=20" \\ -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 16.5. Просмотр метрик

```
curl https://your-domain/api/metrics # Или через Prometheus: # scrape_config: # - job_name: telemetria # static_configs: # - targets: ['your-domain:443'] # scheme: https # metrics_path: /api/metrics
```

### 16.6. Проверка здоровья

```
curl https://your-domain/health \| jq . # Ожидаемый ответ: # { # "status": "ok", # "db": "ok", # "worker": "ok", # "version": "2.7.0" # }
```

### 16.7. Обновление API-ключа 2ГИС

```
curl -X POST https://your-domain/api/admin/settings \\ -H "Authorization: Bearer $ADMIN_TOKEN" \\ -H "Content-Type: application/json" \\ -d '{"TWO_GIS_API_KEY": "new-key-value"}'
```

### 16.8. Резервное копирование в GitHub

```
curl -X POST https://your-domain/api/admin/backup/github \\ -H "Authorization: Bearer $ADMIN_TOKEN" \\ -H "Content-Type: application/json" \\ -d '{ "repo": "markovsaratov-crypto/telemetria-backups", "branch": "main", "path": "backups/" }'
```

## 17. Мониторинг и алерты

Мониторинг осуществляется через Prometheus-метрики и health-check. Рекомендуемая конфигурация AlertManager:

```
groups: - name: telemetria rules: - alert: IngestErrorRate expr: rate(ingest_total{status="error"}[5m]) / rate(ingest_total[5m]) > 0.05 for: 5m annotations: summary: "Ingest error rate > 5%" - alert: TrafficJobDeadRate expr: rate(traffic_job_failed_total[1h]) / rate(traffic_job_completed_total[1h]) > 0.10 for: 1h annotations: summary: "TrafficJob dead rate > 10%" - alert: BackupFailure expr: increase(backup_failed_total[1h]) > 0 for: 1h annotations: summary: "Backup failed" - alert: WorkerStuck expr: worker_pending_jobs > 50 for: 10m annotations: summary: "Worker stuck (pending > 50)"
```

## 18. Развёртывание в продакшен

### 18.1. Чек-лист перед деплоем

- Все секреты (LOGIN_PASSWORD, SESSION_SECRET, API_KEY, INGEST_TOKEN, CRON_SECRET, ADMIN_TOKEN) заменены на сильные случайные значения ≥32 символа.

- DATABASE_URL указывает на Turso (libsql://), не на локальный SQLite.

- RATE_LIMIT_BACKEND=redis (если multi-instance) или memory (single-instance).

- TWO_GIS_API_KEY получен и установлен через /api/admin/settings.

- Cookie name: __Host-telem_session (с префиксом, требует HTTPS).

- CIRCUIT_BREAKER_THRESHOLD и TIMEOUT_SEC настроены.

- Health-check endpoint доступен без авторизации.

- Бэкапы настроены (ежедневный logical dump + GitHub backup).

- Prometheus scrape настроен на /api/metrics.

- AlertManager правила импортированы.

### 18.2. Миграция SQLite → Turso

```
# 1. Создать Turso БД turso db create telemetria # 2. Получить URL и токен turso db show telemetria --url turso db tokens create telemetria # 3. Экспортировать данные из SQLite sqlite3 db/custom.db .dump > dump.sql # 4. Импортировать в Turso (через libsql CLI) libsql dump.sql -u libsql://... -t token # 5. Обновить DATABASE_URL и TURSO_AUTH_TOKEN в env
```

## 19. Устранение неполадок

| **Симптом**               | **Причина**                                     | **Решение**                                                          |
|---------------------------|-------------------------------------------------|----------------------------------------------------------------------|
| 503 Service Unavailable   | Сервис не запущен или health-check failed       | Проверить логи, перезапустить сервис                                 |
| 429 Too Many Requests     | Превышен rate limit                             | Уменьшить частоту запросов, увеличить RATE_LIMIT_MAX_*             |
| 401 Unauthorized          | Неверный токен или истёкшая cookie              | Проверить Authorization заголовок, перекнопиться                     |
| 500 Internal Server Error | Внутренняя ошибка, см. requestId в логах        | Найти requestId в логах, проверить stack trace                       |
| Ворчер не забирает задачи | CRON_SECRET не совпадает или ворчер не запущен  | Проверить /health?XTransformPort=3001, сверить CRON_SECRET           |
| 2ГИС timeout              | Сеть или API 2ГИС недоступен                    | Проверить TWO_GIS_API_KEY, circuit breaker переключит на OSRM        |
| База данных заблокирована | SQLite single-writer, конкурентная запись       | Проверить p-limit(1) на write, мигрировать на Turso                  |
| Cookie не устанавливается | Secure flag без HTTPS или __Host- префикс     | Использовать HTTPS, проверить cookie name                            |
| BigInt serialization      | JSON.stringify не умеет BigInt                  | Маппить Number(timestamp) в route handlers                           |
| Edge Runtime warning      | instrumentation.ts импортирует Node-only модули | Guard process.env.NEXT_RUNTIME !== 'nodejs' + serverExternalPackages |
| Circuit breaker разомкнут | 5+ отказов 2ГИС подряд                          | Подождать 30 сек (auto half-open), проверить ключ 2ГИС               |
| Dead TrafficJob           | 3 неудачные попытки                             | POST /api/admin/requeue с jobId                                      |

## 20. Приложения

## Приложение А. Полный список API endpoint'ов

| **Endpoint**                    | **Метод**        | **Авторизация**     | **Назначение**             |
|---------------------------------|------------------|---------------------|----------------------------|
| /health                         | GET              | —                   | Health-check               |
| /api/auth/login                 | POST             | —                   | Вход                       |
| /api/auth/logout                | POST             | Cookie              | Выход                      |
| /api/auth/me                    | GET              | Cookie              | Проверка сессии            |
| /api/auth/register              | POST             | —                   | Регистрация (multi-user)   |
| /api/ingest                     | POST             | Bearer INGEST_TOKEN | Приём GPS-точек            |
| /api/ingest/sensorlogger        | POST             | Bearer INGEST_TOKEN | Формат Sensor Logger       |
| /api/sessions                   | GET              | Cookie/API_KEY      | Список сессий              |
| /api/sessions/[id]            | GET              | Cookie/API_KEY      | Детали сессии              |
| /api/sessions/[id]            | DELETE           | Cookie/API_KEY      | Soft-delete                |
| /api/sessions/[id]/notes      | PATCH            | Cookie/API_KEY      | Заметки и теги             |
| /api/sessions/[id]/stats      | GET              | Cookie/API_KEY      | Статистика (10 метрик)     |
| /api/sessions/[id]/share      | POST             | Cookie/API_KEY      | Публичная ссылка           |
| /api/sessions/[id]/share      | GET              | token (query)       | Публичный доступ           |
| /api/sessions/[id]/export     | POST             | Cookie/API_KEY      | Экспорт GPX/KML/JSON       |
| /api/sessions/batch             | POST             | Cookie/API_KEY      | Пакетный GET               |
| /api/sessions/batch-stats       | POST             | Cookie/API_KEY      | Пакетная статистика        |
| /api/sessions/bulk-delete       | POST             | Cookie/API_KEY      | Массовое удаление          |
| /api/sessions/search            | GET              | Cookie/API_KEY      | Поиск                      |
| /api/plan                       | POST             | Cookie/API_KEY      | Построение маршрута        |
| /api/plan/[sessionId]         | GET              | Cookie/API_KEY      | План/сегменты сессии       |
| /api/routes                     | GET/POST         | Cookie/API_KEY      | CRUD маршрутов             |
| /api/routes/[id]              | GET/PATCH/DELETE | Cookie/API_KEY      | CRUD одного маршрута       |
| /api/exports/[jobId]          | GET              | Cookie/API_KEY      | Статус экспорта            |
| /api/exports/[jobId]/download | GET              | token               | Скачивание файла           |
| /api/admin/backup               | POST             | Bearer ADMIN_TOKEN  | Резервная копия            |
| /api/admin/backup/github        | POST             | Bearer ADMIN_TOKEN  | Бэкап в GitHub             |
| /api/admin/restore              | POST             | Bearer ADMIN_TOKEN  | Восстановление             |
| /api/admin/requeue              | POST             | Bearer ADMIN_TOKEN  | Повтор dead-задачи         |
| /api/admin/settings             | POST             | Bearer ADMIN_TOKEN  | Настройки                  |
| /api/admin/jobs                 | GET              | Bearer ADMIN_TOKEN  | Список TrafficJob          |
| /api/audit                      | GET              | Bearer ADMIN_TOKEN  | Журнал аудита              |
| /api/worker/poll                | POST             | Bearer CRON_SECRET  | Захват задач ворчером      |
| /api/worker/complete            | POST             | Bearer CRON_SECRET  | Результат задачи           |
| /api/worker/health              | GET              | Bearer CRON_SECRET  | Health ворчера             |
| /api/metrics                    | GET              | —                   | Prometheus метрики         |
| /api/import/csv                 | POST             | Cookie              | Импорт CSV                 |
| /api/import/zip                 | POST             | Cookie              | Импорт ZIP (Sensor Logger) |
| /api/stats                      | GET              | Cookie/API_KEY      | Общая статистика           |
| /api/stats/aggregate            | GET              | Cookie/API_KEY      | Агрегированные метрики     |
| /api/stats/speed-distribution   | GET              | Cookie/API_KEY      | Распределение скоростей    |
| /api/stats/tags                 | GET              | Cookie/API_KEY      | Теги (облако)              |
| /api/stats/devices              | GET              | Cookie/API_KEY      | Статистика по устройствам  |
| /api/geocode/reverse            | GET              | Cookie              | Обратное геокодирование    |
| /api/keepalive                  | GET              | —                   | Keep-alive (для free-tier) |
| /api/test-2gis                  | GET              | Cookie              | Тест 2ГИС API              |
| /api/cron/finalize-sessions     | POST             | Bearer CRON_SECRET  | Финализация сессий         |

## Приложение Б. Глоссарий

| **Термин**      | **Определение**                                                                       |
|-----------------|---------------------------------------------------------------------------------------|
| Cookie (HMAC)   | HTTP-cookie с подписью HMAC-SHA256 для аутентификации веб-клиента                     |
| Bearer-токен    | Токен в заголовке Authorization для программных клиентов                              |
| Soft-delete     | Мягкое удаление: пометка deletedAt, исключение из списков, возможность восстановления |
| Grace period    | Период после soft-delete до физического удаления (30 дней)                            |
| Retention       | Политика хранения данных (10 лет)                                                     |
| Idempotency     | Свойство повторного запроса возвращать тот же результат (через clientId)              |
| Circuit breaker | Защитный механизм, размыкающий цепь при отказах провайдера                            |
| Snap-to-grid    | Округление координат до сетки ~55 м для кэширования                                   |
| TrafficJob      | Задача обработки маршрута с пробками в ворчере                                        |
| BackupJob       | Задача резервного копирования                                                         |
| ExportJob       | Задача экспорта сессии в файл                                                         |
| AuditLog        | Журнал аудита деструктивных операций                                                  |
| RPO             | Recovery Point Objective — целевой срок потери данных (1 час)                         |
| RTO             | Recovery Time Objective — целевой срок восстановления (30 минут)                      |
| Sliding window  | Алгоритм rate limit: подсчёт запросов в скользящем окне                               |
| STRIDE          | Модель угроз: Spoofing, Tampering, Repudiation, Info Disclosure, DoS, EoP             |

## 21. Приёмка и критерии готовности

Чек-лист для администратора перед запуском в продакшен:

- Все env vars настроены (см. раздел 4).

- Все секреты ≥32 символа, не дефолтные.

- DATABASE_URL указывает на Turso (не локальный SQLite).

- TWO_GIS_API_KEY получен и установлен.

- Ворчер запущен (проверить /health?XTransformPort=3001).

- Бэкапы настроены (ежедневный + GitHub).

- Prometheus scrape настроен.

- AlertManager правила импортированы.

- Health-check endpoint отвечает 200.

- Тестовый ingest прошёл успешно.

- Тестовый login + cookie работает.

- Тестовый экспорт GPX/KML/JSON работает.

- Soft-delete + grace period проверены.

- AuditLog записывает действия.

- Circuit breaker корректно переключает провайдеров.

- 0 предупреждений Edge Runtime в логах.

- Lint проходит без ошибок.

— Конец документа —