# Telemetria поездок — Worklog

Спецификация: `Telemetria_Spec_v2_6.pdf` (v2.6, 55 стр., production-grade, готовность 8.0/10).
Стек: Next.js 16 + Prisma + Turso/LibSQL (sandbox → SQLite), Worker-процесс, Redis sliding window rate-limit (sandbox → in-memory), 2ГИС→OSRM→гаверсинус, STRIDE, BackupJob, ADMIN_TOKEN.

---
Task ID: 0
Agent: orchestrator (main)
Task: Анализ блокеров №1 и №3, формулировка важных вопросов пользователю до старта программирования.

Work Log:
- Извлёк текст спецификации из PDF (pdfplumber, 113KB).
- Нашёл контраргументы по блокеру №1: TARGET_LOAD_RPM=100 сессий/мин (§11 env, §9.6) против RATE_LIMIT_MAX_INGEST=10 запросов/60с с ключом `IP + INGEST_TOKEN` (§6.3 таблица). INGEST_TOKEN — единый shared env-var (single-user модель, §6.1), ⇒ все запросы с одного IP делят один бакет 10/мин → 90% запросов получают 429 при целевой нагрузке. Жёсткое математическое противоречие.
- Нашёл контраргументы по блокеру №3: /api/auth/login упомянут в §6.1 как точка установки HttpOnly-куки (sessionId, HMAC-signed), но в §4 (API-эндпоинты, пп. 4.1–4.12) контракта НЕТ — нет request-body, нет response-body, нет статус-кодов, нет rate-limit на логин (брутфорс!), нет /logout, нет /me, нет описания sessionId в single-user модели (модель User НЕ вводится → что аутентифицируется?). Фронт и бэк заблокированы.
- Проинспектировал текущее состояние проекта: чистый Next.js 16 scaffold, shadcn/ui установлен, Prisma schema = дефолтные User/Post (нужно заменить на Session/GpsPoint/Route/RouteCache/TrafficJob/AuditLog/ExportJob/BackupJob).
- Сформулировал 9 важных вопросов пользователю (см. Stage Summary).

Stage Summary:
- Блокер №1 (rate-limit vs TARGET_LOAD_RPM): предложенное решение — ключ `rl:ingest:{deviceId}` (10/мин на устройство) + глобальный потолок `rl:ingest:token:{INGEST_TOKEN}` (150/мин, = TARGET_LOAD_RPM × 1.5 headroom). Это одновременно защищает от rogue-device flood и пропускает 100 сессий/мин от 100 разных устройств.
- Блокер №3 (/api/auth/login): предложенный контракт —
  • POST /api/auth/login { password } → 200 { sessionId, expiresAt } + Set-Cookie (HttpOnly, Secure, SameSite=Strict, __Host- prefix, 24h); 401 при неверном; 429 при >5 попыток/мин с IP (отдельный бакет rl:auth:login:{ip}).
  • POST /api/auth/logout → 204 + Set-Cookie с Max-Age=0.
  • GET /api/auth/me → 200 { authenticated, expiresAt } | 401.
  • Stateless HMAC-signed cookie { sub:"owner", iat, exp } подписан SESSION_SECRET (env, ≥32 chars), timing-safe compare пароля против LOGIN_PASSWORD (env, ≥32 chars). Никакой Session-таблицы в single-user модели (premature optimization, §6.1).
- Важные вопросы пользователю (9 шт., см. ниже в чате) — ждём ответов перед стартом кодирования.
- Состояние проекта: чистый scaffold, spec-код отсутствует.

---
Task ID: 1
Agent: orchestrator (main)
Task: Финализация решений по блокерам, старт backend-инфраструктуры.

Work Log:
- Получены ответы пользователя. Финальные решения:
  • Блокер №1: ПОДНЯТЬ RATE_LIMIT_MAX_INGEST до 120 (env), ключ остаётся `IP + INGEST_TOKEN` (упрощённый вариант). Глобальный потолок = 120/мин на токен+IP. Целевая нагрузка 100 сессий/мин достижима (headroom 20%).
  • Блокер №3: LOGIN_PASSWORD env (≥32 chars, timing-safe compare via crypto.timingSafeEqual). Stateless HMAC cookie {sub:"owner", iat, exp} подпись HMAC-SHA256(SESSION_SECRET). Companion endpoints /api/auth/logout + /api/auth/me добавлены. Cookie: __Host-telem_session, HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age=86400 (24h). Sliding renewal при exp-now<1h.
  • Скоуп: Faithful MVP — все 8 Prisma-моделей, middleware, /api/ingest, /api/sessions (+[id]), /api/plan (+[sessionId]), /api/routes CRUD, /api/sessions/[id]/export, /api/exports/[jobId], /health, /api/admin/{backup,restore}, /api/audit, /api/worker/{requeue,health}, /api/auth/*, /api/import/csv, /api/metrics. Worker как mini-service порт 3001. In-memory rate-limit (no Redis in sandbox). SQLite (no Turso). 2ГИС→OSRM→haversine chain (2ГИС key via env TWO_GIS_API_KEY).
  • UI: русский.
  • Demo-data: НЕТ. CSV-импорт endpoint /api/import/csv (auto-detect columns).
- Установлены пакеты: p-limit, react-leaflet, leaflet, @types/leaflet.
- Worker mini-service будет на порту 3001 (mini-services/worker/), доступ через ?XTransformPort=3001.
- Стартует backend-инфра (env, prisma, lib/*), затем middleware + API routes, параллельно — subagent'ы на Worker + Frontend.

Stage Summary:
- Решения по блокерам зафиксированы. Спека v2.6 + патчи: RATE_LIMIT_MAX_INGEST=120, /api/auth/login contract (login+logout+me, HMAC cookie).
- План: backend делаю сам (консистентность критична), Worker + Frontend делегирую 2 subagent'ам параллельно после завершения contracts/routing libs.
- API контракты для subagent'ов будут в этом worklog (см. ниже секцию "API CONTRACTS").
