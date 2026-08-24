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
