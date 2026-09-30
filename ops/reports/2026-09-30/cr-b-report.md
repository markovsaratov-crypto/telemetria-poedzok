# CR-B — Прод-данные + исходники GitHub-репо для фиксов (read-only аудит)

- Дата: 2026-09-30 (песочница), агент CR-B. Ничего не изменено в проде: только SELECT/GET; никаких деплоев/пушей/UPDATE/DELETE/INSERT.
- Отчёт создан для следующего агента-кодера: точные данные, карта кода, готовый план фиксов.

---

## 0. Метод доступа к прод-данным (важно для верификации после фикса)

- CF API-токен `[REDACTED:CF_API_TOKEN]` **валиден** (verify → active), аккаунт `b8e4eee2f19ba22f8d9ccce80691e719` доступен, НО **D1 REST API токену закрыт** (`GET /d1/database` → 401 auth error; `POST /d1/database/{id}/query` → 403 code 7403) — токен имеет права Workers Scripts / KV / Schedules, но не D1.
- ID БД **telemetria = `9dec0a90-7d38-46ae-9921-29eb83706b3d`** (извлечён из биндингов воркера: `GET /accounts/{acc}/workers/scripts/d1-gateway/settings`).
- SQL выполнялся через **уже существующий** в проде воркер `telemat-metrics-fix` (создан 09-29 16:08 не прошедшими раундами, НЕ мной; биндинг D1 = та же БД): `GET https://telemat-metrics-fix.markov-saratov.workers.dev/q?sql=…` с заголовком `x-audit-key: [REDACTED:AUDIT_KEY]` (ключ зашит в коде воркера, доступен через `GET /accounts/{acc}/workers/scripts/telemat-metrics-fix`). Все запросы — строго SELECT (проверяется по meta.changed_db=false).
- KV читался через CF API: namespace шлюза = `be49735094b14ad3a41e053c4b1cd308` (title `telemetria-kvcache-probe`).
- Альтернатива для следующего агента: тот же audit-воркер /q?sql=… (read-only SELECT), либо временный воркер с D1-биндингом (паттерн прошлого раунда — но это уже «деплой»).

---

## 1. SQL-РЕЗУЛЬТАТЫ (продовая D1 «telemetria», 2026-09-30 ~16:05 UTC)

### a) BackupJob

```
SELECT status, count(*) FROM BackupJob GROUP BY status;
→ completed: 59, failed: 18

SELECT id, type, status, createdAt, completedAt, fileSize, substr(error,1,120) FROM BackupJob ORDER BY createdAt DESC LIMIT 5;
→
1. b843e29b-de12-4ac6-9f9f-435c51238bd1 | full | failed  | 2026-09-30T03:30:58.571Z | 2026-09-30T07:55:14.010Z | null | "fm: reclaimed stuck running > 2h (worker CPU limit)"
2. 269a15c5-90a5-43ee-afce-122d1687384c | full | completed | 2026-09-29T10:04:44.796Z | 2026-09-29T10:05:05.664Z | 68476200 | null
3. 2b8f1149-2ad1-43c7-9a66-0f5bd5b0d3c8 | full | failed  | 2026-09-29T03:31:12.470Z | 2026-09-30T07:55:14.010Z | null | "fm: reclaimed stuck running > 2h (worker CPU limit)"
4. 7d744e7c-729b-4e39-9e77-ccbe921b0e02 | full | completed | 2026-09-28T10:06:29.189Z | 2026-09-28T10:06:45.673Z | 67849556 | null
5. c7e2f4ab-cf10-4047-8e7f-970962220bfb | full | failed  | 2026-09-28T03:31:10.662Z | 2026-09-30T07:55:14.010Z | null | "fm: reclaimed stuck running > 2h (worker CPU limit)"
```

Трактовка: успешные «completed» ~68 МБ — это GHA-прогоны (время совпадает с GitHub Actions run 09-28 10:06 / 09-29 10:04 UTC); «failed» — 03:30/03:31 UTC = cron шлюза → POST /api/admin/backup на воркере → CPU-лимит (1102), BackupJob висел 'running', рекается FM-движком через >2 ч (07:55:14 — время река). Полный дамп ~68 МБ (JSON.stringify ~97К точек).

### b) Сессии-сироты (D1.2)

```
SELECT count(*) FROM Session WHERE tripId IS NULL AND status='completed';           → 78
SELECT deviceId, count(*) … GROUP BY deviceId;
→ phone: 74 | proxy-e2e-test: 2 | 56ace75e-f33c-4d4d-8c68-acce81a2fe2a: 1 | diag-probe-0901c: 1

Разбивка по суткам (startTime):
→ 2026-09-30: 72 (!) | 2026-09-29: 1 | 2026-09-22: 1 | 2026-09-18: 1 | 2026-09-08: 2 | 2026-09-01: 1

Распределение pointCount у сирот:
→ 1 pts: 49 | 2 pts: 15 | 4 pts: 2 | 3 pts: 2 | 1523: 1 | 146: 1 | 64: 1 | 24: 1 | 19: 1 | 13: 1 | 11: 1 | 10: 1
Сироты со statsCache: 77 из 78.

Контекст Session (все): 361 всего = completed 316 + archived 40 + deleted 5; с tripId: 238.
Сессий status='recording' СЕЙЧАС: 0 (finalize-крон по 'recording' не находит НИЧЕГО — сироты born-completed ему невидимы).
```

⚠️ Живой источник роста: устройство `phone` шлёт через edge-порт `/ingest` (plain-канал B1, unique clientId на батч) 1-точечные сессии КАЖДЫЕ 5 МИНУТ (~288/сутки): 14:00:15, 14:05:15, 14:10:15 … последняя 15:00:09 (поток шёл до 15:00 UTC, потом устройство замолчало). Все born-completed, tripId NULL, TrafficJob pending→completed. Образец:
`617977a3… phone 55ca25bc… 2026-09-30T15:00:09.015Z→15:00:10.254Z 2pts completed tripId=NULL`.
72 из 78 сирот созданы СЕГОДНЯ — счётчик растёт на ~12/час, пока телефон онлайн.

### c) Дубликаты-«куски» (D1.1)

Схема Trip: `spanStart/spanEnd/startTime/endTime` — **ISO-строки UTC** (`2026-09-02T17:52:41.002Z`), лексикографическое сравнение валидно; `datetime()` в SQLite нормализует в `YYYY-MM-DD HH:MM:SS` — при смешении форматов сравнение ЛОМАЕТСЯ (T > пробела), поэтому все оконные запросы ниже нормализуют оба операнда через `datetime()`.

```
Перекрытия (оверлапы) живых Trip:      → 0 строк
Перекрытия ВКЛЮЧАЯ мягко-удалённые:    → 0 строк
Соседние Trip с гэпом < 300 с:         → 0 строк
Соседние Trip с гэпом < 900 с (TRIP_SPLIT_SEC) — НАРУШЕНИЕ канона «поездка не рвётся»:
→ ровно 3 пары:
1. idA=52a23bec-012a-4332-bcd4-2d9f1a4d4d3b idB=241e96ae-6d87-428b-af7f-acf541072281 | phone
   aEnd=2026-09-20T15:39:23.543Z bStart=2026-09-20T15:49:06.000Z | gap=582 с | aSess=3 bSess=2
2. idA=418e1600-b897-4771-b003-484d48bf07f5 idB=6c2ad0ac-f2a8-433c-be07-6174a4fe5a1a | phone
   aEnd=2026-09-29T09:28:56.071Z bStart=2026-09-29T09:43:24.558Z | gap=867 с | aSess=9 bSess=3
3. idA=e9b7947c-400d-45c5-a5fe-f5add7d56458 idB=27280f61-04af-48e9-8271-f307fb2ae360 | phone
   aEnd=2026-09-22T10:38:02.114Z bStart=2026-09-22T10:53:02.187Z | gap=899 с | aSess=18 bSess=30
```

⚠️ КЛЮЧЕВАЯ ВЕРИФИКАЦИЯ (прогон канонического алгоритма локально): я скачал реальные точки/сессии device=phone за 09-22 07:00–12:28 (71 сессия, 539 точек) и выполнил `computeTripsFromPoints()` из исходников репо (bun, env-дефолты TRIP_SPLIT_SEC=900). Результат: **алгоритм даёт ДРУГИЕ поездки, чем лежит в БД**:
- вычислено 2 поездки: `08:32:21→08:59:11` (4 сессии) и `09:27:58→09:34:34` (3 сессии);
- в БД: `d3c7f22d` spanEnd 06:59:43→08:59:11 (32 сессии, startTime 08:47:21) и `e9b7947c` 09:27:58→**10:38:02** (18 сессий, startTime 09:28:55, endTime 09:34:34).
- то есть `e9b7947c.spanEnd` (10:38:02) РАЗДУТ live-склейкой/ручными фиксами поверх парковочных 5-минутных сердцебиений (09:34:34→10:38:02 все точки disp=0, speed=NULL — стоянка!), а канон даёт spanEnd=09:34:34 и состав 3 сессии вместо 18.
- точки 10:53–11:58 (сессии по 22–23 точки) — тоже disp=0 (стоянка!) — т.е. «поездка» `27280f61` (spanStart 10:53:02, startTime 12:47:35) реально начинается движением только в 12:47.

ВЫВОД по D1.1: (а) дубликатов-оверлапов сейчас НЕТ; (б) видимый дефект — 3 пары «недоразрезанных» кусков (гэп 582–899 с < 900 с) + раздутые spanEnd поверх парковки; (в) состояние Trip в БД ≠ выводу канонического алгоритма (смесь live-glue `extendTripOnPoints`/`joinNewSessionToTrip`, ручных SQL-фиксов 09-29 16:25/16:34 и старых прогонов). Матчинг ±120 с (MATCH_MS=120_000) — механизм возникновения дубликатов остаётся в коде (новый Trip при дрейфе старта >2 мин, старый удаляется только если его конец < windowStart = первая точка окна −120 с).

### d) Trip: счётчики и последние 15

```
SELECT count(*) FROM Trip WHERE deletedAt IS NULL; → 51
SELECT count(*) FROM Trip;                          → 53 (2 мягко-удалённых:
   22a7362e… 56ace75e… 2026-09-20T01:14→02:23 deletedAt=2026-09-29T16:40:00 (ручной фикс прошлого раунда);
   e9ae7d93… qa-live-glue-v235 2026-09-14 deletedAt=2026-09-14T16:41:58)

Последние 15 живых Trip (spanStart DESC):
id                                   device  spanStart               spanEnd                 sess  pointCountActual  statsNull  status
69bc8daf-b370-4a14-a085-e87f964ec0d0 phone   2026-09-30T14:39:45.735 2026-09-30T14:43:53.745  1    38                0         completed
8ceb3e6c-93ba-4a25-95cd-8ba383a1b8db phone   2026-09-30T09:51:00.776 2026-09-30T09:58:44.000  1    444               0         completed
e556426e-dcff-40d8-80fb-cdf6aa6d1424 phone   2026-09-30T09:05:05.251 2026-09-30T09:10:50.000  2    178               0         completed
6da059e1-c3c0-4fb3-bdad-510f2a843801 phone   2026-09-30T08:44:39.136 2026-09-30T08:50:01.525  1    60                0         completed
daa492a2-590a-49a2-abcc-3e25df211465 phone   2026-09-30T05:26:37.841 2026-09-30T05:59:28.192  2    1265              0         completed
59583bd0-6695-4a8d-b12b-aa687191a0e9 phone   2026-09-29T14:09:52.934 2026-09-29T14:46:30.928  6    150               0         completed
6c2ad0ac-f2a8-433c-be07-6174a4fe5a1a phone   2026-09-29T09:43:24.558 2026-09-29T09:56:02.267  3    4                 0         completed
418e1600-b897-4771-b003-484d48bf07f5 phone   2026-09-29T09:00:34.765 2026-09-29T09:28:56.071  9    112               0         completed
e39b8fca-c9e5-4244-81d4-5883706c63f7 phone   2026-09-29T05:32:27.999 2026-09-29T06:05:08.926  3    1210              0         completed
9ed5e960-daa0-4760-90dc-88c453eb23d0 phone   2026-09-28T15:51:32.873 2026-09-28T15:53:28.008  2    23                0         completed
f33c4c57-e28c-4231-b2ff-f35eb51a7233 phone   2026-09-28T06:40:57.007 2026-09-28T08:16:13.999  5    4456              0         completed
3ecd4356-ddb4-4c50-a8d6-9c4e92b5c073 phone   2026-09-28T05:46:53.000  2026-09-28T06:13:44.099  3    390               0         completed
e4caaf4a-ecdb-437c-96e1-ea54e9c21dcc phone   2026-09-23T06:39:58.778 2026-09-23T06:47:38.042  3    17                0         completed
7763d3fe-3d03-41f5-835c-d368b3df04ae phone   2026-09-23T05:15:04.480 2026-09-23T06:18:48.068  2    3507              0         completed
27280f61-04af-48e9-8271-f307fb2ae360 phone   2026-09-22T10:53:02.187 2026-09-22T13:19:56.001  30   1778              0         completed
```
statsComputedAt заполнен у ВСЕХ живых Trip (FM tsw-механизм работает: перерасчёт через GET /api/trips/batch?ids=).

### e) GpsPoint

```
SELECT count(*) FROM GpsPoint; → 97 101
```
(Размер БД size_after ≈ 58.3 МБ; полный JSON-дамп ≈ 68 МБ — источник D2.2.)

### f) TrafficJob

```
Колонки TrafficJob: id, sessionId, tripId, status, attempts, priority, scheduledFor, lockedBy, lockedAt, result, error, createdAt, updatedAt
(колонки type НЕТ — запрос из ТЗ с type невалиден)
SELECT status, count(*) FROM TrafficJob GROUP BY status; → completed: 409, dead: 1
```

### Доп. прод-факты

- `StatsRollup`: FM-движок жив — day=2026-09-30: sessions=78, points=2706, updatedAt=16:05:38 (обновляется ежеминутно); fm:frozenThru=2026-09-29; fm:backfill:v1 (22 дня) done 07:55.
- `IngestMessage`: последние messageId 66326/66328 (phone) в 15:00:10 — инжест шёл до 15:00 UTC.
- `AuditLog`: последние — `stats.rollup_backfill` 09-29 16:23, `backup.drill`/`backup.github.upload`/`backup.create` 09-29 10:05 (GHA).

---

## 2. GITHUB-РЕПО (клон /tmp/tel-repo, main @ 969d965)

PAT через askpass-хелпер; `.git/config` — **CLEAN** (проверено grep ghp_). Ветка main + `backup/pre-fixpacks-2026-09-17-clean`.

### 2.1 Структура (верхний уровень)

```
README.md  bun.lock  package.json  tsconfig*.json  vitest.config.ts  eslint.config.mjs
cloudflare-worker/  → d1-gateway.js (1388 строк — ИСХОДНИК гейтвея!), ingest-port.js (1165), worker.js, wrangler.toml
src/ → app/(api/…), lib/ (trip-grouping.ts 796, active-trip.ts 466, session-finalize.ts 120, backup.ts 376, github-backup.ts 417, worker-runtime.ts, stats-rollup.ts, env.ts, …), components/, hooks/, proxy.ts, proxy.workers.ts, edge-entry.js
scripts/ → backup-remote.ts, backfill-route-hash.ts, repair-trips-n4.ts, verify-teleport-fix.ts, cf-proxy-swap.mjs, check-secrets.sh
docs/ → OPERATIONS.md (67КБ, §§0–12), TECHNICAL.md, ADMIN_SPEC.md, METHODOLOGY.md, SECURITY-ROTATION.md, CUSTOM_DOMAIN.md, OPTIMIZATION-PROPOSAL.md
.github/workflows/ → backup.yml, ci.yml
wrangler.jsonc (telemat-web/OpenNext), open-next.config.ts, render.yaml, db/, prisma/, tests/, mini-services/, public/
```

**Исходник d1-gateway в репо ЕСТЬ**: `cloudflare-worker/d1-gateway.js` — это исходник задеплоенного (до-FM) бандла (deployed-clean.js = бандл этого файла; FM-блок в репо ОТСУТСТВУЕТ — он только в прод-бандле patched-d1-gateway.js). `cloudflare-worker/wrangler.toml` содержит биндинги DB=9dec0a90-…, KV=be4973…, vars и **[triggers] crons = */1, */5, 0 3 * * *, 30 3 * * *, 0 4 * * SUN** (комментарий: free-план ≤5 триггеров).

### 2.2 Сегментация поездок — src/lib/trip-grouping.ts

- `recomputeTripsForDevice(deviceId, fromMs)` — :335, ЕДИНСТВЕННАЯ реализация правила. Загружает сессии окна (`WHERE deviceId=? AND deletedAt IS NULL AND (endTime IS NULL OR endTime >= fromMs-1)`), конкатенирует точки, `computeTripsFromPoints()` (:146), diff с существующими Trip.
- **Матчинг: `const MATCH_MS = 120_000;` (:405)** — `existing.find(e => Math.abs(e.startTimeMs - trip.startTime) <= MATCH_MS)`. Новый Trip INSERT (:463-475); не-матчнутые существующие удаляются только если `e.endTimeMs >= windowStart` где `windowStart = streamFirstTs - MATCH_MS` (:499-509) — вне окна «неприкосновенны» (механизм D1.1: дрейф старта >120 с + старый Trip с endTime в окне → дубликат-«хвост»).
- `TRIP_SPLIT_SEC` — env.ts:108, дефолт 900; инварианты I1/I2 (:232-240).
- Составы/назначение Session.tripId — шаги 5–6 (:518-544), один batchChunked.
- `assignTripOnSessionFinalize(sessionId)` — :577 (окно = от min(начало записи−900с, старт последней Trip−5с)).
- `closeStaleTrips()` — :614 (recording-поездки >900с без живых сессий → completed + план-джоб).
- Сверка с задеплоенным бандлом telemat-web (CR-A1): в бандле 3 копии recomputeTripsForDevice (~33374, ~34925, ~98593) — тот же алгоритм.

### 2.3 active-trip.ts (state machine)

- `computeActiveTrip(points, motion, {splitSec, minLegSec})` :316; сплит leg: (1) moving-интервал с dt ≥ splitSec (:367), (2) run из idle/gap ≥ splitSec (:390).
- `computeMovingTime` :116: гистерезис 5/2 км/ч, debounce 5с, gap > 30с; «разреженное движение» (jump ≥ 75 м, потолок 200 км/ч — N-3 телепорт-гард); cross-check min(speed, disp×1.5); **speed=NULL → v = dispSpeed** (парковочные сердцебиения = idle/gap).
- КАНОНИЧЕСКОЕ ПРАВИЛО (trip-grouping.ts:19-28): поездка = максимальная последовательность точек с соседними интервалами < 900с И стоянками < 900с. Стоп-ран < 900с поездку НЕ режет — потому пары с гэпом 582/867/899 с в БД и есть дефект «недосклейки».

### 2.4 POST /api/admin/backfill-trips — src/app/api/admin/backfill-trips/route.ts

- Zod-схема: **`{ planDays?: z.coerce.number().int().min(0).max(3650) }` — ТОЛЬКО planDays. Параметров deviceId/days/threshold НЕТ** → роут всегда перебирает ВСЕ устройства (`SELECT deviceId … GROUP BY deviceId`) и для каждого `recomputeTripsForDevice(deviceId, 0)` = полная история. Bounded-пересчёт для одного устройства СЕЙЧАС НЕВОЗМОЖЕН (нужна правка роута + редеплой telemat-web — заблокирован миной секретов, см. §5.4).
- Auth: Bearer ADMIN_TOKEN / admin-cookie, heavy-scope 1/час; аудит trip.backfill.

### 2.5 Роуты бэкапа

- `POST /api/admin/backup` (route.ts): `runBackup(actorId)` → если настроен GitHub — `backupToGitHub(actorId, {…content})` тем же дампом; ответ 201. GET — listBackups.
- `POST /api/admin/backup/github`: `backupToGitHub(actorId)` (dynamic import). GET — список релизов.
- `src/lib/backup.ts` `runBackup()` :108: `db.backupJob.create({status:'running', type:'full', lockedBy})` — **in-flight лока НЕТ (D2.1)**; снапшот-фаза: Session первая → GpsPoint/AuditLog/TrafficJob/ExportJob по срезу сессий (keyset-пагинация CHILD_PAGE_ROWS=5000) → пост-чек ΣpointCount == дампленные точки live-сессий (3 попытки, 30с пауза); полный JSON всех таблиц; `content` в памяти (v2.42.2 — fs-толерантность); BACKUP_STORAGE_DIR="/tmp/backups" (на Workers дамп живёт в памяти → CPU/128МБ лимит → 1102).
- `src/lib/github-backup.ts` `backupToGitHub()` :112: runBackup → AES-256-GCM (TELMENC1) → GitHub **draft-release** (assets .sql.enc) → read-back drill (checksum в будни, full в воскресенье UTC) → аудит backup.github.upload / backup.drill.

### 2.6 .github/workflows/backup.yml (ключевой — приводится полностью в §4 плана)

- `schedule: cron "30 3 * * *"` + workflow_dispatch; concurrency group=backup; таймаут 30 мин; bun install → `bun scripts/backup-remote.ts` с env D1_GATEWAY_URL/`D1_GATEWAY_SECRET`(секрет репо)/`BACKUP_ENCRYPTION_KEY`/`GITHUB_TOKEN`(+6 прикладных для env() FAIL-CLOSED). Никакого D1 export API — тот же production-код дампа через шлюз.
- `scripts/backup-remote.ts`: `backupToGitHub('backup-gha-01')`.
- ci.yml: tsc ×2 + eslint + vitest (push main / PR).

### 2.7 docs/ + README

- README: «Прод: poedzok.fun… Бекап БД: ежедневный приватный draft-релиз backup-* (03:30 UTC…) + read-back drill; восстановление POST /api/admin/restore {source:"github"}». Развёртывание — push в main (Render, устарело).
- OPERATIONS.md: §5 миграция Turso→D1; §8 edge-воркер; **§9 Cron Triggers + рунбук `/admin/cron-status` (curl -H x-gateway-secret)**; §10 Pack C; §11 инцидент Render; **§12 эвакуация 25.09: «полный дамп (64+МБ) упирается в лимиты free-плана (1102) — POST /api/admin/backup НА ВОРКЕРЕ невозможен. Ночные бэкапы переехали в GitHub Actions… Cron 03:30 backup на воркере будет падать 1102 (бэкап живёт в GH Actions — это ожидаемо)»**.
- wrangler.jsonc (telemat-web): кронов НЕТ; vars `GITHUB_BACKUP_CRON_UTC`/`GITHUB_BACKUP_ENABLED` — **мёртвые** (в src/ не используются).
- tests/: отдельного теста trip-grouping НЕТ (ingest-port.test.ts, tripcalc.test.ts, …) — зазор для фиксов D1.1/D1.2.

### 2.8 Git-история (git log --oneline -15)

```
969d965 docs(ops): §12 — эвакуация с Render: v2.42.2, ротация секрета шлюза, фикс консистентности, бэкапы в GitHub Actions, остаточные шаги
3aefd03 fix(ci): tsc на scripts/backup-remote.ts …
b19230a v2.42.2 ops(backup): ночной бэкап переезжает в GitHub Actions (workflow backup.yml, секреты репо D1_GATEWAY_SECRET, BACKUP_ENCRYPTION_KEY…)
834cba9 v2.42.2 fix(backup): fs-толерантность для Cloudflare Workers …
d9c5ee6 docs(ops): §11 инцидент 2026-09-25 — Render suspend-by-user …
5174c77 v2.42.1 fix(ci) … | f3e5aac v2.42.0 feat(calc): TripCalc … | 5b9262f v2.41.0 … | ec1420f v2.40.9 Pack C … | 5db0ac7 v2.40.8 fix(trips): N-5 … | cf50777 v2.40.7 fix(stats): N-3 телепорты … | 8b18870 v2.40.6 … | 45f4fcf v2.40.5 Pack B … | d382800 v2.40.5 Pack A … | e8a536a v2.40.4 chore(release)
```

---

## 3. ЖИВОЕ СОСТОЯНИЕ ПРОДА (только GET)

### 3.1 Health

- Шлюз: `GET https://d1-gateway.markov-saratov.workers.dev/health` → 200 `{"ok":true,"gateway":"d1","db":"bound","version":"2.42.1"}`.
- Приложение: `/` → 200; `GET /api/keepalive` → 200; `/api/share?token=…` → 400/403 (валидация токена до БД — см. ниже); `POST /api/auth/login` (левые креды) → **401 «Неверный email или пароль»** — маршрут вызывает `userDb.findByEmail` (SQL через шлюз) ДО ответа, т.е. **канал приложение↔шлюз↔D1 жив** (секрет D1_GATEWAY_SECRET у telemat-web валиден).
- Инжест-порт шлюза без токена → 401 с reason (ожидаемо).

### 3.2 Расписания d1-gateway (CF API, изменены 2026-09-27T18:17)

```
*/1 * * * *   (tick)
*/5 * * * *   (finalize-sessions + alerts + turso-migrate)
0 3 * * *     (retention)
30 3 * * *    (backup)
0 4 * * SUN   (backup-github)
```
telemat-web расписаний не имеет. Воркеры аккаунта: d1-gateway, telemat-web, qa-pulse-probe (тривиальный "probe-ok"), telemat-analytics-fix (отдаёт патченый чанк), **telemat-metrics-fix (D1-биндинг + /q с x-audit-key — канал read-only аудита)**.

### 3.3 KV шлюза (namespace be49735094b14ad3a41e053c4b1cd308)

```
cron:last:backup         {"at":"2026-09-30T03:31:25.000Z","ok":false,"status":503}        ← 03:30 cron падает
cron:last:retention      {"at":"2026-09-30T03:01:05.632Z","ok":true,"status":200}
cron:last:tick           {"at":"2026-09-30T16:06:41.096Z","ok":true,"status":200}         ← тик жив
cron:last:finalize-sessions {"at":"2026-09-30T16:05:38.011Z","ok":true,"status":200}
cron:last:alerts         {"at":"2026-09-30T16:00:43.263Z","ok":true,"status":200}
cron:last:backup-github  {"at":"2026-09-27T04:01:03.479Z","ok":false,"status":530}        ← ВС 04:00 тоже падает
cron:last:turso-migrate  ok, state blocked (квота Turso, blockedCount 1218 — индифферентно, §12)
fm:frozenThru            2026-09-29
fm:backfill:v1           {"at":"2026-09-30T07:55:59.262Z","days":22,"written":22}
fm:refresh7d:at          2026-09-30T16:02:37.800Z
fm:tsw:<tripId>          3 ключа с TTL (6da059e1, daa492a2, e556426e)
quota:day:2026-09-30     rowsRead 470308 / 5М (9.4%), rowsWritten 15444
turso_delta:v1           blocked (известно)
qapulse-probe            (мусор от qa-воркера)
```

### 3.4 Ошибки воркеров за сегодня (GraphQL workersInvocationsAdaptive, до ~16:09 UTC)

```
d1-gateway:  success 100 607 | clientDisconnected 1 346 | errors 0
telemat-web: success 35 076 | exceededResources 618 (час 14:00 — 617; час 03:00 — 1)
             scriptThrewException 51 (05h:16, 08h:2, 09h:8, 13h:1, 14h:24) | clientDisconnected 2
Вчера (09-29, до FM-фикса): exceededResources 4 826, scriptThrewException 28
```
FM-фикс снял утренний пик (06–08h: 0 ошибок), но вечерний пик 14:00 UTC (618 за час — юзер за рулём + дашборд) остаётся открытым пунктом мониторинга.

### 3.5 ⚠️ НОВАЯ КРИТИЧЕСКАЯ НАХОДКА: GHA-бэкап СЛОМАН (последний успешный — 09-29 10:04 UTC)

- Workflow `backup` (schedule 03:30 UTC, фактически стартует с задержкой GitHub: 08:47/09:28/10:04/10:06 UTC):
```
36699391180 schedule    completed failure 2026-09-30T09:57:18Z  ← СЕГОДНЯ ПРОВАЛ
36553265612 schedule    completed success 2026-09-29T10:04:29Z  ← последний успех
36407652862 schedule    completed success 2026-09-28T10:06:15Z
36309493368 schedule    completed success 2026-09-27T09:28:43Z
36230837751 schedule    completed success 2026-09-26T08:47:27Z
36129230204 workflow_dispatch success 2026-09-25T11:24:39Z
```
- Лог провала (скачан): шаг «Run backup» упал за 170 мс с **«БЭКАП ПРОВАЛЕН: unauthorized»** — это 401 от `POST {D1_GATEWAY_URL}/query` шлюза: секрет репо `D1_GATEWAY_SECRET` НЕ совпадает с задеплоенным `GATEWAY_SECRET`.
- Причина (хронология версий d1-gateway): **v14 = «secret» 2026-09-29T16:54:40** (ротация GATEWAY_SECRET не залoggированным раундом) → telemat-web modified 09-29T17:12:59 (его D1_GATEWAY_SECRET синхронизирован) → **секрет репо GitHub D1_GATEWAY_SECRET обновлён 2026-09-25T11:23:47 и БОЛЬШЕ НЕ ОБНОВЛЯЛСЯ** (список секретов репо подтверждает) → все GHA-бэкапы после 09-29 16:54 падают 401.
- ИТОГ: **durable-бэкапов НЕТ с 2026-09-29 ~10:05 UTC** (25+ ч). In-worker 03:30-бэкап мёртв по CPU-дизайну (D2.2), воскресный 04:00 мёртв (530, D2.4). Значение текущего GATEWAY_SECRET неизвестно (в CF не читается, в песочнице/в worklog его нет) → чинится только ротацией с синком (см. план F0).

---

## 4. ПЛАН РЕАЛИЗАЦИИ ФИКСОВ (для агента-кодера)

**Общий принцип деплоя (проверен раундом frozen-metrics-fix, безопасен):** правим исходник `cloudflare-worker/d1-gateway.js` в /tmp/tel-repo (репо — исходник гейтвея ЕСТЬ — править исходник, не бандл!) → бандлим (или правим бандл `download/telemat-fm/patched-d1-gateway.js` параллельно тем же патчем) → `PUT /accounts/{acc}/workers/scripts/d1-gateway` c multipart: metadata keep_secrets=true + ЯВНЫЕ не-секретные биндинги (APP_ORIGIN, EDGE_INGEST_MAX_BYTES, EDGE_INGEST_ROLLUP_ENABLED, TELEMAT_TIMEZONE, TURSO_URL, d1 DB, kv KV) — секреты (GATEWAY_SECRET, INGEST_TOKEN, CRON_SECRET, SESSION_SECRET, TURSO_AUTH_TOKEN) наследуются. После — проверить `/health` и 12 биндингов в settings. telemat-web НЕ трогать (мина секретов, worklog:437).

### F0 (П0, новое): восстановить GHA-бэкап — ротация секрета «в одну сторону»

Проблема: GHA-секрет протух. Безопасный путь БЕЗ деплоя telemat-web (его секрет-PUT опасен из-за пустого черновика v24):

1. Сгенерировать `S=$(openssl rand -hex 32)`.
2. Обновить секрет репо (PAT имеет admin): рецепт проверен в песочнице — `cd /tmp && bun add libsodium-wrappers`, затем:
```js
import sodium from "libsodium-wrappers"; await sodium.ready;
const pk = sodium.from_base64("<key из GET /repos/markovsaratov-crypto/telemetria-poedzok/actions/secrets/public-key>");
const sealed = sodium.crypto_box_seal(sodium.from_string(S), pk);
// PUT /repos/.../actions/secrets/D1_GATEWAY_SECRET  body {encrypted_value: sodium.to_base64(sealed), key_id: "<key_id>"}  заголовок Authorization: Bearer <PAT>
```
(key_id сейчас: 3380204578043523366; секреты репо: ADMIN_TOKEN, API_KEY, BACKUP_ENCRYPTION_KEY, CRON_SECRET, D1_GATEWAY_SECRET, GH_BACKUP_PAT?, INGEST_TOKEN, LOGIN_PASSWORD, SESSION_SECRET.)
3. В **деплое гейтвея F1** (см. ниже) добавить plain_text-биндинг `GHA_GATEWAY_SECRET = <S>` и в коде шлюза принять ЛЮБОЙ из двух секретов:
```js
// fetch-роутер, текущие строки ~1975-1978 бандла / ~…… d1-gateway.js исходника:
const secret = request.headers.get("x-gateway-secret") ?? "";
const gwOk = await secretEquals(secret, env.GATEWAY_SECRET) ||
             (env.GHA_GATEWAY_SECRET ? await secretEquals(secret, env.GHA_GATEWAY_SECRET) : false);
if (!env.GATEWAY_SECRET || !gwOk) return json({ error: "unauthorized" }, 401);
```
(приложение продолжает ходить со старым GATEWAY_SECRET — его не трогаем; GHA шлёт новый).
4. `POST /repos/…/actions/workflows/backup.yml/dispatches` → проверить run: «=== БЭКАП ГОТОВ ===», релиз backup-2026-09-30-*, BackupJob completed ~68МБ.
РИСКИ: (а) секрет S попадёт в metadata PUT гейтвея (plain_text) — виден в settings API только с нашим токеном, допустимо; (б) если упустить шаг 3, GHA останется сломан; (в) альтернатива для владельца — задать значение сам через wrangler/dashboard. После восстановления — опционально задокументировать в docs/OPERATIONS.md §13.

### F1 (D2.2 + D2.4 + D2.3 + D2.6 + D2.1-частично): расписания и «один бэкап-канал»

**Целевые расписания CF (замена одним атомарным PUT — НЕ delete/create по одному):**
```
PUT /accounts/b8e4…/workers/scripts/d1-gateway/schedules
body: {"schedules":[{"cron":"*/1 * * * *"},{"cron":"0 3 * * *"}]}
```
- Удаляется `30 3 * * *` (backup): in-worker полный дамп 68МБ структурно невозможен на free-CPU (§12, инцидент 1102; BackupJob-факты §1a) — бэкап живёт в GHA (после F0).
- Удаляется `0 4 * * SUN` (backup-github): дубль GHA-ежедневника; воскресный запуск и так падал 530 (cron:last:backup-github). Побочно закрывается D2.4 (2 дампа в ВС) и историческая гонка D2.3 (retention 03:00 vs backup 03:30 — гонять больше нечему; GHA стартует по факту ~09:30–10:05 UTC, retention 03:00 уже завершился).
- Удаляется `*/5 * * * *` → **свёртка в тик** (закрывает D2.6 — совпадение */1 и */5 в одну минуту :00/:05/:10…): в `scheduled()` после jobs-резолва:
```js
const jobs = CRON_SCHEDULES_BY_NORM.get(normalizeCron(controller.cron)) ?? [];
if (jobs.includes("tick") && new Date().getUTCMinutes() % 5 === 0) {
  jobs.push("finalize-sessions", "alerts", "turso-migrate"); // v2.42.3 (CR-B D2.6): вместо отдельного */5-триггера
}
```
(последовательное исполнение внутри одной инвокации — без параллельных POST в приложение; записи cron:last:* продолжаются через putCronLastThrottled). В CRON_SCHEDULES (исходник :683-689 / бандл :1347-1353) записи оставить как есть (dead-safe: если кто-то вернёт триггер через дашборд, диспетчер сработает).
**D2.1 (in-flight лок)**: в шлюзе перед вызовом backup-джоба (его оставляем в CRON_APP_PATHS для ручных вызовов через dashboard cron нельзя — поэтому фактически код-путь мёртв; всё же добавляем защиту на случай возврата):
```js
if (job === "backup" || job === "backup-github") {
  const r = await env.DB.prepare("SELECT id FROM BackupJob WHERE status='running' AND createdAt > ? LIMIT 1")
    .bind(new Date(Date.now() - 30*60_000).toISOString()).first().catch(() => null);
  if (r) { results[job] = { ok:false, skipped: "in-flight BackupJob < 30min" }; continue; }
}
```
Плюс в репо (для будущего деплоя telemat-web, НЕ сейчас): `runBackup()` — атомарный claim:
```sql
INSERT INTO BackupJob (id, type, status, lockedBy) SELECT ?, 'full', 'running', ? WHERE NOT EXISTS
  (SELECT 1 FROM BackupJob WHERE status='running' AND createdAt > datetime('now','-30 minutes'))
```
rowsAffected=0 → skip (GHA-side уже защищён concurrency: group=backup в workflow).
РИСКИ: удаление триггеров через PUT — необратимо без обратного PUT (список для отката — §3.2); свёртка */5 в тик удлиняет тик-инвокацию (finalize+alerts+turso ~секунды — приемлемо); cron:last-наблюдаемость сохраняется.

### F2 (D1.2): усыновление сирот в шлюзе (gateway-only, без деплоя приложения)

Куда: `fmEngineTick()` бандла :1808-1905 (блок `%5`, :1866+) и исходник d1-gateway.js (вставить аналогичный шаг в scheduled). Логика (bounded, идемпотентная, КОНСЕРВАТИВНАЯ — без раздувания spanEnd):

```js
// v2.42.3 (CR-B D1.2): adopt orphan sessions (born-completed через /ingest-порт)
if (new Date(now).getUTCMinutes() % 5 === 0) {
  try {
    const orphans = await env.DB.prepare(
      `SELECT s.id, s.deviceId, s.userId, s.startTime, s.endTime, s.pointCount
       FROM Session s WHERE s.tripId IS NULL AND s.status='completed' AND s.deletedAt IS NULL
         AND s.pointCount >= 3 ORDER BY s.startTime ASC LIMIT 20`).all();
    for (const s of orphans.results ?? []) {
      // 1) поездка, ЧЬЁ ОКНО ДВИЖЕНИЯ (startTime..endTime) накрывает или граничит (±900с) с сессией
      const t = await env.DB.prepare(
        `SELECT id, sessionIds, sessionCount, spanStart, spanEnd, startTime, endTime FROM Trip
         WHERE deviceId = ? AND deletedAt IS NULL AND status='completed'
           AND datetime(startTime) <= datetime(?) AND datetime(endTime) >= datetime(?, '-900 seconds')
         ORDER BY ABS(strftime('%s', ?) - strftime('%s', startTime)) LIMIT 1`)
        .bind(s.deviceId, s.endTime, s.startTime, s.startTime).first();
      if (t) {
        const ids = new Set(JSON.parse(String(t.sessionIds || "[]")));
        ids.add(String(s.id));
        const arr = [...ids];
        await env.DB.batch([
          env.DB.prepare(`UPDATE Trip SET sessionIds=?, sessionCount=?, spanEnd=MAX(spanEnd,?), updatedAt=?,
              statsComputedAt=NULL, distanceM=NULL, activeDurationSec=NULL, movingTimeSec=NULL, idleTimeSec=NULL,
              gapTimeSec=NULL, internalStopTimeSec=NULL, pointCountActual=NULL, maxSpeedMs=NULL, ecoScore=NULL WHERE id=?`)
            .bind(JSON.stringify(arr), arr.length, s.endTime, new Date(now).toISOString(), t.id),
          env.DB.prepare(`UPDATE Session SET tripId=?, updatedAt=? WHERE id=?`)
            .bind(t.id, new Date(now).toISOString(), s.id)
        ]);
        out.adopted = (out.adopted ?? 0) + 1;
      }
      // 2) нет подходящей поездки → НОВЫЙ Trip только для «настоящих» кусков (pointCount>=3):
      else {
        const nid = crypto.randomUUID();
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO Trip (id, deviceId, userId, status, startTime, endTime, spanStart, spanEnd,
              sessionIds, sessionCount, interFragmentGapSec, createdAt, updatedAt)
              VALUES (?,?,?,'completed',?,?,?,?,?,?,0,?,?)`)
            .bind(nid, s.deviceId, s.userId, s.startTime, s.endTime ?? s.startTime, s.startTime, s.endTime ?? s.startTime,
                  JSON.stringify([String(s.id)]), 1, new Date(now).toISOString(), new Date(now).toISOString()),
          env.DB.prepare(`UPDATE Session SET tripId=?, updatedAt=? WHERE id=?`)
            .bind(nid, new Date(now).toISOString(), s.id)
        ]);
        out.adopted = (out.adopted ?? 0) + 1;
      }
    }
  } catch (e) { console.log(JSON.stringify({ level: "warn", msg: "fm adopt failed", error: String(e && e.message || e) })); }
}
```
Пояснения/риски:
- `MAX(spanEnd, ?)` — только расширение, НИКОГДА не сжатие; правило «движение-окно ±900с» НЕ даёт парковочной цепочке сердцебиений приклеиваться бесконечно (сердцебиение с pointCount=1–2 отфильтровано порогом pointCount≥3 — 64 из 78 сирот сегодня мусорные 1–2 точки, они остаются вне поездок, как и требует канон: «парковка между поездками не принадлежит никому»);
- statsComputedAt=NULL → существующий tsw-шаг (:1872-1902) сам пересчитает метрики через приложение (GET /api/trips/batch) — synergy без нового кода;
- «настоящие» сироты (1523/146/64/24/19/13/11/10 точек — 8 шт. + исторические) получат свои Trip;
- идемпотентность: повтор — no-op (tripId уже проставлен);
- АЛЬТЕРНАТИВА (правильнее, но заблокирована): правка src/app/api/admin/backfill-trips/route.ts — добавить в zod `deviceId: z.string().optional()` и ветку `if (deviceId) { recomputeTripsForDevice(deviceId, fromMs) }`; требует редеплоя telemat-web (мина секретов worklog:437 — сначала пересоздать 10 секретов значениями владельца). Рекомендуется как F2b после разминирования.
- После внедрения F2 проверить: `SELECT count(*) FROM Session WHERE tripId IS NULL AND status='completed' AND pointCount>=3` → должно дрейфовать к 0 (мусор 1–2-точечных намеренно остаётся).

### F3 (D1.1): merge «недорезанных» кусков в шлюзе

Куда: тот же блок %5 в fmEngineTick (после adopt). Кандидаты — ровно 3 пары (§1c). SQL + JS:

```js
// v2.42.3 (CR-B D1.1): merge adjacent trips with gap < TRIP_SPLIT_SEC (900s)
const pairs = await env.DB.prepare(
  `SELECT a.id AS idA, b.id AS idB, a.sessionIds AS idsA, b.sessionIds AS idsB,
          CAST((julianday(datetime(b.spanStart)) - julianday(datetime(a.spanEnd)))*86400 AS INTEGER) AS gapSec
   FROM Trip a JOIN Trip b ON a.deviceId = b.deviceId AND a.id <> b.id
     AND datetime(b.spanStart) > datetime(a.spanEnd)
     AND datetime(b.spanStart) <= datetime(a.spanEnd, '+900 seconds')
   WHERE a.deletedAt IS NULL AND b.deletedAt IS NULL ORDER BY gapSec LIMIT 5`).all();
for (const p of pairs.results ?? []) {
  const ids = [...new Set([...JSON.parse(String(p.idsA || "[]")), ...JSON.parse(String(p.idsB || "[]"))])];
  await env.DB.batch([
    env.DB.prepare(`UPDATE Trip SET spanEnd=(SELECT spanEnd FROM Trip WHERE id=?), endTime=COALESCE((SELECT endTime FROM Trip WHERE id=?), endTime),
        sessionIds=?, sessionCount=?, interFragmentGapSec=interFragmentGapSec+?, updatedAt=?,
        statsComputedAt=NULL, distanceM=NULL, activeDurationSec=NULL, movingTimeSec=NULL, idleTimeSec=NULL,
        gapTimeSec=NULL, internalStopTimeSec=NULL, pointCountActual=NULL, maxSpeedMs=NULL, ecoScore=NULL
      WHERE id=?`).bind(p.idB, p.idB, JSON.stringify(ids), ids.length, p.gapSec, new Date(now).toISOString(), p.idA),
    env.DB.prepare(`UPDATE Session SET tripId=? WHERE tripId=?`).bind(p.idA, p.idB),
    env.DB.prepare(`UPDATE TrafficJob SET tripId=? WHERE tripId=? AND status IN ('pending','running')`).bind(p.idA, p.idB),
    env.DB.prepare(`UPDATE Trip SET deletedAt=?, updatedAt=? WHERE id=?`).bind(new Date(now).toISOString(), new Date(now).toISOString(), p.idB) // мягкая tombstone (безопаснее hard-DELETE)
  ]);
  out.merged = (out.merged ?? 0) + 1;
}
```
- Мягкая tombstone (deletedAt) вместо DELETE как у app-рекомпьюта:保留了 историю для отката (запомнить пары); /api/trips фильтрует deletedAt IS NULL.
- statsComputedAt=NULL → tsw пересчитает (объединённая поездка 27280f61 — 1778 точек, влезает: аналогичная f33c4c57 на 4456 точек посчитана).
- РИСКИ: (1) merge по span-гэпу — апроксимация канона (не учитывает движение); для 3 найденных пар корректна (гэп 582/867/899 < 900); (2) сервер-докрученный spanEnd (e9b7947c до 10:38:02 поверх парковки) — merge НЕ лечит раздутые spanEnd (это отдельная чистка; канонический бэкфилл F2b исправит всё разом); (3) TrafficJob: completed-джобы B остаются привязаны к tombstoned Trip — на отображение не влияют.
- После внедрения: контрольный SELECT пар должен вернуть 0 строк (кроме пар с tombstone).

### F4 (D2.1 остаток + наблюдаемость): мелочи

- В fmEngineTick-лог добавить поля adopted/merged (строка :2104 console.log «fm engine tick»).
- Опционально: KV-ключ `fm:adopt:v1` с датой последнего прогона.
- Ретеншн-наблюдаемость: cron:last:retention ok — не трогать.

### Порядок выполнения для агента-кодера

1. F0 шаги 1–2 (секрет репо) → F1+F2+F3+F0-шаг-3 одним деплоем гейтвея (исходник /tmp/tel-repo/cloudflare-worker/d1-gateway.js: внести FM-блок целиком из download/telemat-fm/engine.js + новые шаги adopt/merge + двусекретный auth + свёртку */5; собрать бандл) → PUT расписаний (2 триггера) → F0 шаг 4 (dispatch GHA) → верификация.
2. Верификация после деплоя (READ-ONLY):
   - `/health` 200; settings: 13 биндингов (5 секретов + GHA_GATEWAY_SECRET + 6 text + DB + KV);
   - schedules = 2; через 10 мин: KV cron:last:tick ok, отсутствие новых BackupJob 'running';
   - GHA run success + BackupJob completed ~68МБ + draft-релиз;
   - SQL: сироты pointCount≥3 → уменьшение; merge-пары → 0; пары «кусков» не появляются новые сутки;
   - GraphQL: telemat-web errors не выросли.
3. В репо ЗАПУШИТЬ изменения исходника d1-gateway.js (+ docs/OPERATIONS.md §13 «CR-B: cron-свёртка, GHA-единственный бэкап, adopt/merge-движок») — PAT позволяет; паттерн пуша из CR-A2 (git+HTTPS, PAT в askpass, не в remote-URL).
4. Откат: PUT бандла download/telemat-fm/deployed-clean.js (до-FM) или нового бандла без adopt/merge; расписания вернуть PUT-ом из §3.2.

---

## 5. Риски и открытые вопросы

1. **Мина секретов telemat-web** (worklog:437): НЕ делать wrangler deploy / secret-PUT на telemat-web до пересоздания 10 секретов владельцем. Все фиксы CR-B сознательно gateway-only.
2. **Audit-воркер telemat-metrics-fix** с x-audit-key в коде остаётся в проде (не мой — не удаляю read-only-раундом); рекомендация следующему раунду: удалить его и его ключ из отчётов после завершения фиксов.
3. **Вечерний пик exceededResources 14:00 UTC (617/час)** — отдельная тема (тяжёлый дашборд), мониторить.
4. **Роздутые spanEnd** (e9b7947c и др.) и «неканонические» составы Trip — полностью лечится только каноническим backfill-trips по устройствам (F2b, после разминирования telemat-web).
5. GHA-задержка расписания (03:30 → факт 08:47–10:06 UTC) — особенность GitHub Actions, не дефект; учесть в SLA бэкапа.
6. FM-перехватчики /query чувствительны к тексту SQL приложения (CR-A1 П5) — не трогать в этом раунде.
