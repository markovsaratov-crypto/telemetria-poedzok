# Operations — алерты (§14.4) и резервное копирование: фактическое состояние

Документ отражает ФАКТИЧЕСКОЕ поведение системы. Обновлять при изменениях.
Расположение на GitHub: https://github.com/markovsaratov-crypto/telemetria-poedzok/blob/main/docs/OPERATIONS.md

## Известные процедуры: кэш предрасчёта метрик

- **После рекалибровки корпуса EcoScore** (изменение env `ECO_SCORE_CAP_BASELINE` / существенный рост корпуса, см. METHODOLOGY.md §7.3) — **поднять `SESSION_CACHE_VERSION`** в `src/lib/session-cache.ts`: персистентный кэш (`Session.statsCache/eventsCache/trackCache`) хранит базлайны МОМЕНТА записи, и без бампа версии батч-роут продолжит отдавать старые значения EcoScore, а поштучный роут — новые (конвенция зафиксирована в `src/app/api/stats/batch/route.ts`).
- **После изменения расчёта метрик** (правка конвейера/порогов) — также поднять `SESSION_CACHE_VERSION`: первый запрос «Всё время»/периода после деплоя будет медленным (live-пересчёт + write-through), последующие — из кэша.

## Бэкапы: состав дампа

Логический дамп и restore покрывают ВСЕ таблицы: Session, GpsPoint,
**Trip** (серверные поездки), **IngestMessage** (ledger идемпотентности инжеста —
без него ретраи после restore задвоят точки), Route, RouteCache, TrafficJob,
AuditLog, ExportJob, BackupJob, Setting (без `diag.ingest.raw`), **_AlertState**,
плюс информационные users (без passwordHash). При необходимости поездки
восстанавливаются backfill'ом `POST /api/admin/backfill-trips`.

Актуальный полный бекап: draft-релиз `backup-v2.29.0` (79 сессий · 48 358 точек ·
9 поездок · sha256 в теле релиза). Восстановление — `POST /api/admin/restore`
(RTO 5–15 мин; см. TECHNICAL.md §14.3).

## 0. Инцидент C-1: утечка публичных дампов БД (закрыт)

Сеньор-ревью выявило: прод-дамп БД (полный трекинг, passwordHash-профили,
2GIS API-ключ, геокэш домашних адресов) был (а) закоммичен в ПУБЛИЧНЫЙ репозиторий
`db/backups/prod-dump-*.json`; (б) выгружен ПУБЛИЧНЫМИ ассетами GitHub
Releases (backup-*, проверено: анонимная загрузка давала HTTP 200).

**Статус устранения:**
1. ✅ Все 10 публичных release'ов `backup-*` удалены (API DELETE, проверка:
   анонимный download → 404; список release'ов → пуст).
2. ✅ Git-история вычищена `git filter-repo` по путям `.env`,
   `db/backups/prod-dump-2026-08-27…json`, `db/backups/prod-dump-2026-08-28…json`,
   `db/custom.db`, `prisma/db/local.db`; force-push всех 9 веток и тегов.
   Старые SHA коммитов/блобов на GitHub отвечают 403 Gone.
   ВНИМАНИЕ: локальные клоны, сделанные ДО чистки, всё ещё содержат дампы —
   переклонировать.
3. ✅ Код: новые GitHub-бэкапы создаются ТОЛЬКО приватными
   draft-релизами (ассет виден/качается только владельцу с write-доступом);
   `.gitignore` закрывает `db/backups/*.json` и `*.db`; дампы не содержат
   `diag.ingest.raw` (сырые тела батчей).
4. ⚠️ ОСТАЁТСЯ ВЛАДЕЛЬЦУ: ротация секретов (все значения были в публичном
   доступе до чистки): LOGIN_PASSWORD, API_KEY, INGEST_TOKEN, ADMIN_TOKEN,
   CRON_SECRET, SESSION_SECRET (env на Render), TWO_GIS_API_KEY (кабинет 2ГИС).
   После ротации обновить SensorLogger URL (новый INGEST_TOKEN) и
   скрипты/закладки с токенами. До ротации считать токены скомпрометированными.
5. ✅ /tmp/backups на Render эфемерный — исчезнет при рестарте сам.

## 1. Алерты (спека §14.4)

Оценщик правил: `src/lib/alerts.ts`. Два способа просмотра:

- **`GET /api/admin/alerts`** (Bearer ADMIN_TOKEN или cookie админа) — текущее
  состояние всех правил в JSON: `firing`, `value`, `threshold`, `action`, `detail`.
- **Cron `POST /api/cron/alerts`** (Bearer CRON_SECRET) — периодическая оценка;
  при срабатывании пишет `logger.warn`, инкрементирует `alert_firing_total` и
  отправляет уведомление в Slack, если задан `SLACK_WEBHOOK_URL`.

Cron-сервис `telemetria-alerts-cron` добавлен в `render.yaml` (каждые 5 минут).
В дашборде Render задать переменные cron-сервиса: `BASE_URL`, `CRON_SECRET`,
опционально `SLACK_WEBHOOK_URL` (sync:false — значения не копируются автоматически).

### Правила

| Правило | Условие (спека) | Источник данных |
|---|---|---|
| `ingest_error_rate` | errors/total > 5% за 5 мин | кольцевой буфер исходов ingest (`recordIngestOutcome` в роуте; 401 middleware не учитываются) |
| `traffic_job_dead_rate` | dead/total > 10% за 1 час | SQL по `TrafficJob.createdAt >= now-1h` |
| `backup_failure` | status=failed 3 раза подряд | последние 3 `BackupJob` |
| `db_size_growth` | рост > 100 МБ/день | `PRAGMA page_count × page_size`; последняя выборка хранится в таблице `_AlertState` |
| `api_latency_p95` | p95 > 2 c за 5 мин | буфер `src/lib/latency.ts`, наполняется роутами, вызывающими `trackLatency(request)` |
| `worker_stuck` | старейший pending > 30 мин ИЛИ pending > 50 в течение 10 мин | MIN(scheduledFor) TrafficJob + серия снапшотов pending (для single-user возраст осмысленнее счётчика) |

### Известные ограничения (сознательные, не баги)

1. **Кольцевые буферы — в памяти инстанса.** Рестарт/деплой обнуляет окна
   `ingest_error_rate`, `api_latency_p95`, `worker_stuck`; при нескольких
   инстансах каждый видит только свои запросы. Для спека это приемлемо
   (single instance на Render free), для горизонтального масштабирования
   нужен внешний сборщик метрик (Prometheus + Alertmanager).
2. **Покрытие p95 неполное.** Замер ставится в основных роутах (ingest, stats,
   aggregate, session stats, speed-distribution, metrics). Непокрытые роуты в
   p95 не попадают. Добавление замера — одна строка `trackLatency(request)`
   перед успешным `return json(...)` в роуте.
3. **`db_size_growth` требует двух оценок** с интервалом ≥ 1 ч (первая фиксирует
   базовую точку в `_AlertState`).
4. **Slack-уведомления с дедупликацией по кулдауну**: горящее правило
   уведомляется не чаще раза в `ALERT_DEDUP_COOLDOWN_MIN` (60 мин по
   умолчанию); гашение правила удаляет состояние (`_AlertState`), следующее
   срабатывание уведомит сразу. При сбое доставки состояние не ставится —
   уведомление не «съедается» кулдауном. `ALERT_DEDUP_COOLDOWN_MIN=0` —
   прежнее поведение (каждые 5 мин).
5. `PRAGMA page_size`/`page_count` на Turso может быть недоступен — правило
   вернёт `detail: "PRAGMA недоступен…"`, не падая.

## 2. Резервное копирование: фактическое поведение и ограничения restore

Реализовано (`src/lib/backup.ts`, `src/lib/github-backup.ts`, воркер):

- Логический дамп БД в `BackupJob` с checksum и верификацией (§9.8);
  файл в `BACKUP_STORAGE_DIR` (/tmp/backups на Render — **эфемерно**).
- Выгрузка в GitHub Releases (`GITHUB_BACKUP_*` env) — долговременный уровень:
  **ежедневно 03:30 UTC тем же прогоном**, что и локальный дамп (код в
  `POST /api/admin/backup`: дамп → аплоад того же файла → read-back drill;
  расписание крон-сервисов Render не менялось — еженедельный github-backup-cron
  ВС 04:00 остаётся страховкой). Ранее durable-копия была только еженедельной —
  окно потери до 7 дней.
- Read-back drill после каждого аплоада: ассет скачивается обратно, sha256
  сверяется с чексуммой аплоада, JSON парсится, счётчики строк сравниваются с
  дампом-источником. Результат — аудит-запись `backup.drill`; при провале —
  Slack (движок `sendSlackMessage`). Проверяется именно восстановимость
  durable-копии, а не только её существование.
- Ретраи `BACKUP_MAX_ATTEMPTS=3`, интервал `BACKUP_RETRY_INTERVAL_HOURS=1`.
- Cron `backup-cron` создаёт дампы по расписанию (render.yaml).

**Restore (фактическое состояние):**

- `POST /api/admin/restore {backupId}` — локальный дамп: поиск BackupJob
  (status=completed с filePath+checksum), чтение файла, сверка SHA256, разбор
  JSON-дампа, атомарная транзакция `libsql.batch` — TRUNCATE всех таблиц в
  FK-безопасном порядке + INSERT строк дампа (порядок по внешним ключам),
  запись аудита ПОСЛЕ restore (переживает truncate). Ответ:
  `{ok, restoredAt, backupId, tablesCount, checksumVerified}` (см. TECHNICAL.md §14.3).
  Лимит — 1 раз в час (admin:heavy-скоп).
- `POST /api/admin/restore {source:"github", tagName?}` — **restore из
  durable-копии**: ассет draft-релиза скачивается по GitHub API (Accept:
  octet-stream + токен), sha256 сверяется с checksum из тела релиза, файл
  сохраняется в /tmp/backups и создаётся completed-BackupJob (type=github),
  дальше — тот же атомарный конвейер. Работает и сразу после рестарта/деплоя
  инстанса (когда /tmp пуст) — прежняя зависимость restore от выживания
  /tmp-файлов снята. `tagName` опционален: без него берётся последний
  backup-релиз.
- Во время restore БД недоступна для записи; ingest в это время вернёт 5xx.
- Дампы в /tmp/backups живут до следующего деплоя/рестарта инстанса —
  долговременный уровень хранения GitHub Releases (ежедневно + read-back drill).

RTO ≈ 5–15 мин (автоматический restore из любого источника), RPO = ≤ 24 ч
(durable-уровень, ежедневно 04:00 UTC).

**Runbook: полный ручной перенос в новую БД** (крайний случай — недоступны и
Render, и Turso; 30–60 мин):

1. Скачать ассет последнего backup-релиза из GitHub (релизы `backup-*`,
   draft — нужен аккаунт с write-доступом).
2. Создать новую БД (Turso: `turso db create <name> --location fra` — регион
   см. TECHNICAL §5.3/§17; рекомендованный путь также снимает кросс-регионную
   латентность, см. «Регион Turso» ниже).
3. **Сначала пересоздать аккаунты пользователей** (FK `Session.userId →
   User.id`: дамп содержит users информационно, БЕЗ passwordHash — вставка
   сессий в БД без юзеров падает по FOREIGN KEY). Аккаунт владельца:
   `POST /api/auth/register` или SQL INSERT с bcrypt-хэшем пароля, id —
   как в дампе.
4. Загрузить дамп: локальный прогон `libsql.batch` из дампа (скрипт по образцу
   `src/lib/restore-core.ts`; restore самовосстанавливает таблицу `_AlertState`)
   или поднять инстанс с `DATABASE_URL` на новую БД и выполнить
   `{source:"github"}`-restore.
5. Сверить счётчики таблиц с `tableCounts` из тела релиза, smoke-тест UI.
6. Обновить `DATABASE_URL`/`TURSO_AUTH_TOKEN` в Render и верифицировать `/health`.

**Регион Turso (рекомендация, требует действий владельца).** Прод-БД живёт в
aws-ap-south-1 (Мумбаи), инстанс Render — во Франкфурте: каждый SQL-раундтрип
~120–150 мс кросс-континентальной латентности. Перенос в aws-eu-central-1
(fra) снижает раундтрип до единиц мс. Не выполнено автоматически: нужны
платформенный токен Turso и доступ к дашборду Render (создание новой БД,
переливка данных свежим бэкапом, смена `DATABASE_URL`, неделя наблюдения со
старой БД как фолбэком).

## 3. Метрики /api/metrics (связанное)

- `alert_firing_current` (gauge) — сколько правил горят сейчас;
- `alert_firing_total` (counter) — оценки cron, завершившиеся срабатыванием;
- остальные счётчики — см. `src/lib/metrics.ts` (реестр на globalThis,
  воркер и API делят один экземпляр).

### RATE_LIMIT_BACKEND=redis — заглушка с честным fallback (ревью F34)

`RATE_LIMIT_BACKEND=redis` + `REDIS_URL` **не реализуют Redis**: воркер
`RedisRateLimiter` (src/lib/rate-limit.ts) один раз логирует warn и метрику
`rate_limit_fallback_total`, дальше работает in-memory. Следствие (зафиксиро-
вано ревью F34, v2.38.2): при **≥ 2 инстансах приложения** (Render horizontal
scaling / несколько деплоев) все лимиты — **per-instance**: brute-force через
разные инстансы умножает эффективный лимит на число инстансов. Текущий
деплой — один инстанс, ограничение не проявляется. Действия при масштабиро-
вании вертикально/горизонтально: реализовать общий стор (Upstash Redis и т.п.)
или держать внешний rate-limit на прокси/CDN (WAF-правило).

## 4. Диагностика канала приёма (ingest)

Проблема: приложение SensorLogger показывает «отправлено успешно» при ЛЮБОМ
HTTP-ответе, включая «тихие» исходы без записи в БД: пустой батч (Test Push),
батч без location (сенсоры без GPS), все точки отброшены фильтром
accuracy > 100 м (AUDIT B-5), 400 (невалидный формат), 401 (токен).

Диагностика:

- **Каждая АВТОРИЗОВАННАЯ попытка инжеста** (оба роута: `/api/ingest`,
  `/api/ingest/sensorlogger`) пишется в Setting `diag.ingest.trace`:
  время, deviceId, исход (`accepted`/`empty`/`no_gps`/`dropped_all`/
  `invalid`/`duplicate`), число принятых/отброшенных точек, размер тела.
  Хранится последняя + 20 последних попыток. Переживает рестарты/деплои.
- **Неавторизованные попытки (401) в БД не пишутся** (анти-абьюз) — видны
  только в `/api/metrics` (`ingest_unauthorized_total`, in-memory,
  сбрасывается при рестарте).
- Просмотр: АДМИН → L1 «Состояние системы» → блок «Канал приёма (инжест)»,
  или `GET /api/stats` → поле `ingestTrace` (cookie/Bearer API_KEY).
- Счётчики исходов: `/api/metrics` — `ingest_attempts_total`,
  `ingest_{empty,no_gps,dropped_all,invalid,duplicate}_total`
  (с лейблом route, in-memory).
- **Образец структуры `sample`** — при нераспознанном батче
  (`no_gps`/`empty`/`invalid`) в trace пишется образец payload: тип корня,
  ключи первого элемента, усечённый JSON (~300 симв.). Виден в L1 под
  подсказкой и в `/api/stats` → `ingestTrace.recent[].sample`. Назначение:
  если формат приложения не совпадает с парсером — сразу видно, ПОД КАКИМИ
  ключами лежат координаты (кейс 01.09: 5 батчей × 28 КБ от markov-iphone
  пришли с валидным JSON, но без распознаваемых GPS-полей).
- **Расширенный парсер SensorLogger** — координаты ищутся
  в `location`/`coords`/`position`/`gps` (внутри — `latitude`/`longitude` или
  `lat`/`lon`/`lng`), массив точек — в корне, `points`/`data`/`records`/
  `samples`/`locations`/`entries`/`batches` (в т.ч. вложенный
  `{data:{location:[…]}}` и массив массивов), время — число (с/мс/нс) или
  ISO-строка; маркеры «нет фикса» (`lat=-1,lon=-1`) отбрасываются (§3.3).
- **Нативный формат Sensor Logger.** Реальная
  структура батча: корневой объект
  `{messageId, sessionId, deviceId, payload:[{name, time, values}]}` —
  каждая запись = отдельный сенсор (`accelerometer`, `gyroscope`, …),
  координаты — в `values` записи с `name:"location"`; `time` — наносекунды
  с epoch (`1788252050972891600` = 2026-09-01 08:40:50 UTC). Парсер ищет
  массив в `payload` (плюс `readings`/`sensors`/`measurements`), именованные
  записи `{name, values}` нормализуются: `values` → контейнер `location`,
  остальные поля — плоский fallback; не-гео-сенсоры отбрасываются
  естественно (нет lat/lon).
- **Гистограмма сенсоров в `sample`** — для формата
  `{payload:[{name, values}]}` образец показывает состав батча:
  `payload-массив[230] сенсоры: accelerometer×200, gyroscope×29, location×1 ·
  {"name":"location",…}`. Если строки `location` в гистограмме нет —
  в приложении не включён GPS/Location в списке записываемых сенсоров
  (подсказка выводится прямо в sample и в hint L1).
- **Полный дамп нераспознанного батча** — Setting
  `diag.ingest.raw`: последнее тело запроса (усечение 8 КБ с v2.38.2/ревью F32,
  обрезка помечается `truncated`, полный размер — в `bytes`), исходы
  `no_gps`/`empty`. Отдаётся ТОЛЬКО по
  `GET /api/stats?ingestRaw=1` (поле `ingestRaw`) — не в каждом ответе.
  В L1 — кнопка «показать полный дамп батча» под образцом структуры
  (ленивая загрузка). Назначение: sample обрезан ~300 симв. — его хватает
  для формы, но для точечного расширения парсера нужно видеть всю
  структуру location-записи.
  **GDPR-линза (ревью F32, v2.38.2):** сырой дамп содержит псевдонимизированные
  персональные данные (координаты + accelerometer deviceId). Меры: TTL 24 ч
  (АУДИТ C-32), **исключён из бэкапов** (`SELECT … WHERE key !=
  'diag.ingest.raw'`, ревью F13), доступ — только владелец/админ
  (`scope.mode !== "own"`, v2.23.0), хранение усечено до 8 КБ (было 64 КБ).
  Шифрование дампа/consent-notice не вводились осознанно (диагностический
  ключ одного владельца, TTL 24 ч); пересмотреть при появлении
  multi-tenant-режима.

- **Идемпотентность:** инжест SensorLogger идемпотентен по `messageId` (таблица
  `IngestMessage`, PK deviceId+messageId) — HTTP-ретраи приложения не создают
  дубликатов точек; ответ `duplicate: true`. Сырой дамп `diag.ingest.raw`
  имеет TTL 24 ч и НЕ попадает в бэкапы.

Типовые интерпретации L1:

| Что видно | Вывод |
|---|---|
| «попыток приёма не зафиксировано» (алый) | запросы приложения не доходят до сервера — проверить URL/токен в приложении |
| `no_gps` (янтарный) | запрос доходит, но координаты не извлечены — гистограмма сенсоров в L1: если `location` в ней нет — включить GPS/Location в приложении; если есть — «полный дамп» для анализа парсера |
| `dropped_all` (янтарный) | слабый GPS-сигнал, все точки точнее 100 м отброшены |
| `accepted` (сливовый) | канал работает, точки в БД |

## 5. Миграция БД Turso → Cloudflare D1 (v2.37.0, 16.09.2026)

### Причина
Turso free исчерпал месячную квоту чтений (блокировка до 1 октября): все экраны
с данными падали 500, инжест не работал — новые поездки терялись. D1 — тот же
SQLite-диалект (SQL без изменений) с дневными лимитами и дневным сбросом.

### Архитектура
```
приложение (Render) ──HTTPS──▶ d1-gateway (Cloudflare Worker,
  │ x-gateway-secret              markov-saratov.workers.dev/d1-gateway)
  │                                     │ Workers-биндинг DB
  ▼                                     ▼
src/lib/db-d1.ts (Client)         Cloudflare D1 «telemetria»
  execute() → POST /query          (database_id 9dec0a90-7d38-46ae-
  batch()   → POST /batch            9921-29eb83706b3d)
  (batch = АТОМАРНАЯ транзакция D1)
```
- Токен владельца («Edit Cloudflare Workers») не имеет прав D1 API → доступ
  идёт через воркер с биндингом: воркер авторизует секретом `GATEWAY_SECRET`,
  приложение — тем же секретом в `D1_GATEWAY_SECRET`.
- `src/lib/db.ts`: ветка `USING_D1` (env `D1_GATEWAY_URL`) подменяет клиент;
  без env — прежний путь Turso/файл. `$transaction` на D1 — буферизованный
  атомарный batch (интерактивных транзакций в D1 нет; контракт DbTx — только
  записи с клиентскими id, эхо-строки строятся локально).
- Воркер: `cloudflare-worker/d1-gateway.js` в репо; код шлюза — /query,
  /batch (≤500 стейтментов), /health; ошибки D1 → HTTP 500 `{error, d1:true}`.

### Лимиты и особенности D1 (учтены в коде)
- ≤100 связанных параметров на запрос → чанки createMany 90/N (GpsPoint 10 строк)
- строка/блоб ≤ 2 МБ → гвард в persistSessionCaches (oversized кэш → NULL,
  пересчёт on-demand; кейс: trackCache 4 МБ у сессии 173b5354)
- `PRAGMA page_count` запрещён (алерт db_size деградирует мягко, заложено)
- `sqlite_version()` запрещён — не используется приложением
- rows_written/read видны в meta ответов шлюза (диагностика квот)
- индекс `GpsPoint_sessionId_idx` НЕ создан (избыточен: составной
  (sessionId, timestamp) покрывает все запросы; экономия ~56К записей)
- `_SessionTrips` не создана (приложение не использует — состав в sessionIds)

### Развёртывание/откат
- Активация: `.env.production.local` в корне (подгружается `next start`).
- **Откат на Turso**: удалить `.env.production.local`, redeploy; Turso-переменные
  в окружении Render не тронуты (однако чтения Turso заблокированы до 01.10 —
  откат вернёт сайт только после сброса квоты).
- Секреты шлюза: `D1_GATEWAY_SECRET` в `.env.production.local`;
  воркер-секрет задаётся через Workers API (PUT .../secrets).

### Сверка миграции (16.09.2026)
Session 101 (живых 55), GpsPoint 56 299 (распределение по 61 сессии — байт-в-байт
с бекапом backup-2026-09-16-0334.json: count/min/max по каждой сессии), Trip 20,
TrafficJob 120, AuditLog 129, User 2, Setting 90, IngestMessage 4 071 (окно 48ч),
ExportJob 5, BackupJob 56, _AlertState 1; `PRAGMA foreign_key_check` — 0 нарушений.

## 5а. Инцидент: исчерпание дневной квоты чтений D1 + оптимизация v2.38.0 (16.09.2026)

### Что случилось
В день миграции (v2.37.0) дневная квота чтений D1 free (5 млн строк/день, сброс
00:00 UTC) выгорела за ~1 час активного использования сайта: вкладка «Поездки»
поллит `/api/trips/batch` каждые 30 с, а роут на каждом TTL-промах ответа
ПЕРЕСЧИТЫВАЛ статы всех 15 поездок — читая ВСЕ точки состава (56 299 строк за
проход). Плюс corpus-калибровка EcoScore каждые 5 мин активности делала full-sweep
всех точек всех сессий (ещё 56К строк). Итого при открытой вкладке — до
~7 млн строк/час. Симптом — как у Turso: экраны с данными 500,
`D1_ERROR: Your account has exceeded D1's free tier daily row read limit`,
`/health: db degraded`. Данные целы; сброс квоты 00:00 UTC.

### Оптимизация v2.38.0 (деплой 16.09 ~16:40 UTC)
1. **Кэш статов поездок в памяти** (`src/lib/trip-stats.ts`): результат конвейера
   (computeSessionStats по срезу состава) кэшируется в памяти процесса
   (TTL 1 ч, LRU 128, `ttl-cache.ts` на globalThis) и валидируется
   ОТПЕЧАТКОМ строки Trip — `sessionIds + startTime/endTime/spanStart/spanEnd +
   statsComputedAt` — и КЛЮЧОМ корпус-калибровки. Инвалидации trip-grouping
   (NULL-ят statsComputedAt), live-продление окна (extendTripOnPoints двигает
   spanEnd) и смена состава меняют отпечаток → пересчёт; всё остальное — hit
   без единого чтения точек. План-факт читается свежим на каждый запрос
   (1 строка TrafficJob) — завершение маршрутного джоба видно сразу.
   Кэш-поля `Trip.*` пишутся ТОЛЬКО на реальном пересчёте (экономия квоты
   записей). Метрики: `trip_stats_cache_hit_total` / `trip_stats_cache_miss_total`.
2. **Подпись корпуса EcoScore** (`src/lib/eco-corpus.ts`): перед full-sweep
   (56К строк) проверяется агрегатная подпись — одна строка
   `COUNT(*) + SUM(pointCount) по финализированным записям`. Корпус не менялся
   (нет финализаций/удалений/backfill) → sweep не выполняется вовсе. Состав
   корпуса сужен до ФИНАЛИЗИРОВАННЫХ записей (`endTime IS NOT NULL`): live-запись
   растёт каждую секунду, её rates «дышат» — в медиане это шум без ценности;
   внутри активной поездки базлайны теперь стабильны.
3. **Батч-роут параллельно**: ids обрабатываются чанками по 8 (быстрый путь —
   2 запроса к шлюзу на поездку; последовательные раундтрипы 15 поездок
   стоили 2–3 с).

### Эффект (оценка по коду)
| Сценарий | v2.37.0 | v2.38.0 |
|---|---|---|
| Вкладка «Поездки» открыта 1 ч (30 с poll) | ~7,3 млн строк чтения | ~130 тыс. (2 строки/поездку на промахе TTL ответа 30 с) |
| Corpus-калибровка в покое (5 мин TTL) | 56К строк каждый sweep | 1 строка подписи; sweep только при изменении корпуса |
| Записи `Trip.*` при просмотре | 15 строк каждые 30 с | только при реальном пересчёте |
Суточный расход при обычном использовании — сотни тысяч строк против лимита
5 млн (запас >10×);worst case (вкладка 24/7) — ~3 млн, всё ещё в лимите.

### Поведение при исчерпании квоты (любой день)
- Чтения блокируются на аккаунте до 00:00 UTC: экраны с данными 500
  (ошибка D1 в логах), `/health: db degraded`, инжест 500 (чтение перед записью).
- v2.38.0 НЕ деградирует хуже: сбой corpus-подписи/sweep ловится и держит
  прежние базлайны (повтор через 5 мин), кэш статистики в памяти переживает
  блокировку, плановый UPDATE кэш-полей — non-fatal.
- Восстановление автоматическое в 00:00 UTC; после сброса кэш прогревается
  первым же проходом.

### Верификация
Функциональная симуляция (локальная sqlite, 31/31): холодный расчёт (1 чтение
точек, 1 запись кэша) → повтор (0 чтений точек, 0 записей, payload байт-в-байт)
→ live-продление окна (пересчёт с новыми точками) → NULL-инвалидация
(пересчёт) → сдвиг базлайнов (пересчёт с новыми) → свежий план-факт на
hit-пути → подпись корпуса (нет sweep без изменений; live-запись не меняет
подпись; финализация → sweep). Прод-E2E после сброса квоты 00:00 UTC 17.09
(крон): два последовательных `/api/trips/batch` → второй волной быстрее,
счётчики hit/miss в `/api/metrics`, UI без регрессий.

## 6. v2.38.1 (ревью): шифрование GitHub-бэкапов, снапшот-дамп, D1-лимиты

### 6.1 Шифрование durable-копий (ревью F13)

Ежедневные дампы (PII: треки, deviceId, email) больше НЕ выгружаются в GitHub
Releases в открытом виде — даже draft-релизом (публикация draft — одна кнопка,
повтор инцидента C-1).

- **`GITHUB_BACKUP_ENCRYPTION_KEY`** (env, опциональная): 32 байта в hex
  (64 символа), `openssl rand -hex 32`. Задаётся на Render-сервисе (и в env
  сессии, где выполняется restore).
- Ассет шифруется AES-256-GCM ДО аплоада: формат
  `TELMENC1 | IV(12 байт) | GCM-тег(16) | ciphertext`, имя `<база>.sql.enc`.
  Chесksum в теле релиза — sha256 ОТКРЫТОГО текста (сверка после расшифровки).
- **FAIL-CLOSED**: ключ не задан/битый → аплоад НЕ выполняется, локальный дамп
  создаётся как обычно; сигнал — `logger.error` + Slack + поле `github.error`
  в ответе `POST /api/admin/backup`. Плейнтекст в GitHub не попадает ни при
  каких настройках.
- Read-back drill и restore-from-GitHub автоматически распознают магию
  `TELMENC1` и расшифровывают тем же ключом; старые plaintext-ассеты (до
  v2.38.1) читаются как есть. Потеря ключа = потеря доступа к зашифрованным
  durable-копиям (храните ключ в менеджере секретов, НЕ только в Render).
- Секретные значения Setting (`TWO_GIS_API_KEY`) маскируются в дампе значением
  `[REDACTED-BY-BACKUP]` (denylist в `src/lib/backup.ts`). После restore
  задайте ключ заново (env или админка «Настройки»).

### 6.2 Снапшот-консистентность дампа и restore на D1 (ревью F3/F25)

- **Дамп** (`src/lib/backup.ts`): Session дампится первой (фиксирует срез
  sessionId); GpsPoint/AuditLog/TrafficJob/ExportJob — только `sessionId IN
  (срез)` чанками ≤90 id (лимит параметров D1); пост-чек
  `Σ pointCount активных сессий == точки дампа` — расхождение (гонка с
  инжестом 24/7) помечает бэкап `failed` → повтор кроном/вручную. В дампе
  появился ключ `watermark` (границы среза; старый restore его игнорирует).
- **Restore** (`src/lib/restore-core.ts` + `batchChunked` в db.ts): строки
  группируются в МНОГОРЯДНЫЕ INSERT (~10× меньше стейтментов; реальный дамп
  79 сессий / 48 358 точек → ~4,9K стейтментов вместо ~48,5K), на D1
  применяются чанками ≤400 стейтментов на /batch (лимит шлюза 500). DELETE-фаза
  (~13 стейтментов) атомарна одним чанком; между INSERT-чанками сквозной
  атомарности на D1 нет — повторный restore идемпотентен (начинается с полного
  DELETE). На Turso — прежний одиночный атомарный batch.
- `$transaction` на D1 (CSV/ZIP-импорт) — буфер стейтментов отправляется
  теми же чанками ≤400 (раньше ≥4971 точки = 503 стейтмента → 400 «too many
  statements», импорт группы падал целиком).
- Инжест SensorLogger: чанк многорядного INSERT = 10 строк (90 параметров)
  вместо 450 — на D1 любой батч ≥12 точек падал «too many SQL variables».

### 6.3 Схема Prisma = прод (ревью F26)

`db:push` БЕЗ `--accept-data-loss` (деструктивный вариант вынесен в
`db:push:danger` с предупреждением — только локальная песочница). Из
`prisma/schema.prisma` удалены объекты, которых в прод-D1 нет: неявная m-n
связь Session↔Trip (join-таблица `_SessionTrips`) и одиночный индекс
`GpsPoint_sessionId_idx` (избыточен: составной `(sessionId, timestamp)`
покрывает все запросы). Схема соответствует фактическому прод-D1 — `db:push`
не тянет drift. Миграции прода — только версионируемым SQL (как §5).

## 7. Деплой fix-паков v2.38.1 + v2.38.2 и повторная квота D1 (17.09.2026)

### Таймлайн (все UTC)
- **до пуша** — страховка: прод-дамп 03:30 из GitHub Releases
  (`backup-2026-09-17-033016`, 31,9 МБ, 13 таблиц, версия 2.38.0) + локальная
  копия; `git bundle` репозитория; архив кода; на GitHub создана ветка отката
  `backup/pre-fixpacks-2026-09-17` (ba413c5 = v2.38.0).
- **21:04** — push 9 коммитов в `main` (ba413c5..bbba0e0: v2.38.1 ×4 +
  v2.38.2 ×5; 88/88 находок ревью закрыто в коде).
- **21:04–21:06** — GitHub Actions CI run #17: **success** (tsc прод+тесты,
  eslint, vitest 50/50).
- **21:06** — Render autoDeploy пересобрал сервис: `/health → version 2.38.2`,
  страницы 200 (poedzok.fun и origin).

### Повторное исчерпание квоты чтений D1 (второй день подряд)
До 21:06 прод работал на v2.38.0 — квота чтений выгорела ещё днём (та же
механика, что §5а: пересчёт статов по сырым точкам + опрос вкладки каждые
30 с + эфемерные кэши после рестартов free-инстанса). Симптом и лечение
те же: `db degraded`, сброс 00:00 UTC. Ручной `POST /api/admin/backup` в этот
период отклоняется Cloudflare («daily row read limit exceeded») — штатно,
данные целы, ночной backup-cron (03:30 UTC уже 18.09) пройдёт после сброса.

**Что меняет v2.38.2 с 17.09 21:06:** TTL-кэш `/api/stats`, in-memory кэш
статов поездок (§10.3а TECHNICAL), RouteCache §13.4, agg-cache, batched-обёртки,
p95-покрытие дашбордов и ленивый индекс `Session(userId, startTime)` (F50:
создаётся идемпотентно при первом списковом запросе после рестарта; после
сброса квоты дотянется сам — ближайший гарантированный рестарт: пробуждение
инстанса ночными кронами 03:00–04:00 UTC 18.09).

**Контроль (18.09 утром):** `BackupJob` 03:30 = completed (провал 3 ночи
подряд = алерт `backup_failure`); `/api/metrics` → `d1_rows_read_total`
за ночь; `/health` без `dbError`.

### Чеклист владельца после деплоя
1. **Ротация секретов** по `docs/SECURITY-ROTATION.md` (до неё секрет шлюза
   считается скомпрометированным — он в git-истории и в xlsx).
2. **Отозвать GitHub PAT**, использованный для деплоя (ghp_…, GitHub →
   Settings → Developer settings → Personal access tokens).
3. **Blueprint-синк в дашборде Render** (Manual deploy → Sync blueprint или
   ручками в env): `REGISTRATION_ENABLED=false` (F6) и
   `ECO_SCORE_CAP_PENALTY_EXPONENT=2` (F65) — значения в `render.yaml`
   обновлены, но применяются только при синке.
4. **Деплой хардненого d1-gateway-воркера** (wrangler; вайтлист операций,
   лимит тела, rate-limit, дайджест-сравнение секрета) — код в
   `cloudflare-worker/d1-gateway.js`; до этого воркер работает в старой
   версии (совместим, без вайтлиста).
5. **filter-repo** истории (шаг 10 ранбука ротации).
6. Утренний контроль по пунктам выше.

### Откат (если что-то пойдёт не так)
- Render: Manual deploy → rollback на коммит ba413c5 (или Deploy from branch
  `backup/pre-fixpacks-2026-09-17`).
- Git: `git reset --hard ba413c5 && git push -f origin main` (в крайнем
  случае; история публичного репо — аккуратно).
- Данные: restore из `backup-2026-09-17-033016` (`POST /api/admin/restore
  {source:"github", tagName:"backup-2026-09-17-033016"}`).

### Планирование развития
Системное предложение по оптимизации потоков данных/нагрузки/скорости —
`docs/OPTIMIZATION-PROPOSAL.md` (статус: ПРЕДЛОЖЕНИЕ, не исполнено;
варианты A/B/C по мировым практикам, сравнение и метрики успеха).

## §8. Edge-воркер v2.39.1 (18.09.2026): /ingest, /kvcache, деплой-рунбук

### Что добавилось на d1-gateway-воркере (v2.39.1)
- **§B1 `/ingest`** — edge-инжест Sensor Logger: монтируется ДО общего гейта
  `X-Gateway-Secret`, своя авторизация `INGEST_TOKEN` (Bearer или `?token=`).
  Паритет ответов с `/api/ingest` (201/200-duplicate/401/405/413/400/500),
  идемпотентность (deviceId, clientId) канала владельца, rollup-инкременты
  StatsRollup (§A1.5) прямо на границе. it_/apiKey-канал (личные устройства) —
  осознанно только через Render (см. шапку `ingest-port.js`).
- **§B2 `/kvcache`** — KV-кэш тяжёлых SELECT (cache-aside): body
  `{key, sql, params, ttlSec}`, ответ `{rows, meta, kv:hit|miss|passthrough}`.
  Гейты: общий секрет, rate-limit, лимит тела 64 КБ, валидация ключа
  `^[A-Za-z0-9_:.-]{1,128}$`, ttl 1..3600, **только SELECT по вайтлисту
  таблиц** (403 на DML/чужие таблицы ДО исполнения), значение ≤512 КБ,
  TTL-пол платформы 60с (клиентский ttlSec меньше — округляется вверх).
  **`/kvcache/invalidate`** — сброс по префиксу (пагинация list, параллельные
  delete, ответ `{invalidated: N}`); вызывается приложением при финализации
  сессии (`edgeKvInvalidate("dash:")`, fire-and-forget).
- Обратная совместимость: биндинг KV отсутствует → `/kvcache` исполняет SQL
  напрямую с `kv:"passthrough"`; `/query` и `/batch` не изменились.

### Деплой воркера (рунбук, ~5 минут)
1. Код: `cloudflare-worker/d1-gateway.js` (импортирует `./ingest-port.js`) —
   деплоятся ОБА файла как модули.
2. Конфиг: `cloudflare-worker/wrangler.toml` — имя `d1-gateway`, биндинги
   DB (D1 «telemetria») + KV (`telemetria-kvcache-probe`), vars
   (`EDGE_INGEST_ROLLUP_ENABLED`, `TELEMAT_TIMEZONE=Europe/Saratov`,
   `EDGE_INGEST_MAX_BYTES`), `workers_dev = true`
   (URL `https://d1-gateway.markov-saratov.workers.dev`).
3. Токен CF: право `Workers Scripts:Edit` (права D1 API не нужны — доступ
   через биндинг). `CLOUDFLARE_API_TOKEN=… bunx wrangler deploy` из папки
   `cloudflare-worker/`.
4. Секреты: `bunx wrangler secret put GATEWAY_SECRET` и
   `bunx wrangler secret put INGEST_TOKEN` — значения ДОЛЖНЫ совпадать с
   Render-инстансом приложения (`D1_GATEWAY_SECRET`, `INGEST_TOKEN`).
5. Проверка: `GET /health` → `{ok:true, gateway:"d1", db:"bound"}`;
   `POST /query {sql:"SELECT 1"}` с секретом → 200; `POST /ingest` без
   авторизации → 401; `POST /kvcache` без секрета → 401.
6. Откат: повторный деплой прошлой версии (копия кода воркера хранится в
   `/home/z/backups/d1-gateway-worker-v2.38.1.js` до подтверждения стабильности;
   при самостоятельном деплое — сохранить `GET …/workers/scripts/d1-gateway`
   перед обновлением).

### Мониторинг после включения B2 (метрики `/api/metrics`)
- `edge_kv_hit_total` / `edge_kv_miss_total` — кэш-эффективность (цель §B2:
  hit ≥60% на дашбордных запросах после прогрева);
- `edge_kv_error_total` — деградации в прямой D1 (норма ≤ единиц в час при
  KK-сбоях; рост = смотреть квоту/биндинг KV);
- `d1_rows_read_total` — главный индикатор эффекта: до/после деплоя v2.39.1
  на одинаковой нагрузке (цель §B2: −30–50% на дашбордных SELECT).
- KV-квота free: 100k чтений/сутки, 1k записей/сутки — кэш 60с на десятке
  ключей `dash:*` укладывается с запасом; счётчик `invalidated` не растёт
  сам по себе = инвалидация не зациклена.

## §9. Edge-контур v2.40.0 (18.09.2026): Cron Triggers, B1-алиас, мигратор Turso-дельты, B6 OpenNext

### 9.1 Что изменилось (директива владельца «сначала идеальный продукт»)

1. **Turso-инцидент закрыт** (18.09 08:10 UTC): env-пара `D1_GATEWAY_URL` +
   `D1_GATEWAY_SECRET` выставлена в Render через Render API (PUT env-vars,
   полный набор 36 переменных), деплой dep-damf2un40ujc73an0g70 → `/health`
   `{"status":"ok","db":"ok"}`. Промежуточный итог: prod на D1-шлюзе, чтения/записи
   живы, Turso больше не в горячем пути.
2. **§B5 Cron Triggers**: d1-gateway-воркер получил `scheduled()` — расписания
   render.yaml 1:1 (retention 03:00, alerts */5, backup 03:30, github-backup
   ВС 04:00, finalize-sessions */5) + новый **worker-tick */1** (драйвер
   инжест-воркера: POST /api/worker/tick → runWorkerTick() — один pollOnce-цикл;
   атомарный claim исключает двойную обработку с in-process-интервалом) +
   **turso-migrate */30**. Cron-сервисы Render НЕ создаются (их в Render и не
   было — blueprint-синк не подтверждался; исполнители остались в приложении).
   Попутный эффект: tick */1 держит Render-инстанс тёплым (нет засыпания).
3. **§B1-complete**: алиас `POST /api/ingest` на воркере — Sensor Logger при
   переводе на edge меняет ТОЛЬКО хост в URL:
   `https://d1-gateway.markov-saratov.workers.dev/api/ingest` (путь и Bearer
   INGEST_TOKEN не меняются). Личные устройства (it_-токены) остаются на
   приложении — edge-канал их сознательно не поддерживает.
4. **§T-DELTA мигратор**: самовосстанавливающийся перенос Turso-дельты
   (17.09 21:06 → 18.09 08:10) в D1. Состояние — KV `turso_delta:v1`; шаг
   ограничен (CPU-бюджет инвокации); идемпотентность: GpsPoint/IngestMessage/
   AuditLog/Route — INSERT OR IGNORE, Session/Trip/TrafficJob/User/Setting —
   только более свежая Turso-строка (сравнение updatedAt).
5. **GITHUB_BACKUP_ENCRYPTION_KEY** сгенерирован и выставлен в Render env —
   durable-копии снова шифруются (AES-256-GCM TELMENC1; до этого fail-closed
   пропускал аплоады).

### 9.2 Рунбук наблюдения (гейт — секрет шлюза)

```bash
GW=https://d1-gateway.markov-saratov.workers.dev
SEC=<D1_GATEWAY_SECRET>

# Состояние миграции + последние запуски всех cron-джоб:
curl -s "$GW/admin/cron-status" -H "x-gateway-secret: $SEC"

# Ручной шаг мигратора (до 40 фаз за запрос):
curl -s -X POST "$GW/admin/turso-migrate" -H "x-gateway-secret: $SEC" \
  -H 'content-type: application/json' -d '{"steps":40}'

# Сброс прогресса (идемпотентно, безопасно):
curl -s -X POST "$GW/admin/turso-migrate" -H "x-gateway-secret: $SEC" \
  -H 'content-type: application/json' -d '{"reset":true}'
```

Статусы мигратора: `pending` (ещё не запускался) → `blocked` (квота Turso
читается, ретрай через 30 мин — это НОРМА до сброса квоты) → `running` →
`done` | `error`. После `done`: удалить биндинг TURSO_AUTH_TOKEN из воркера
(см. SECURITY-ROTATION.md) и отозвать JWT в Turso.

### 9.3 Перевод Sensor Logger на edge-инжест (§B1, за владельцем, 2 минуты)

В приложении на телефоне: URL отправки `https://poedzok.fun/api/ingest` →
`https://d1-gateway.markov-saratov.workers.dev/api/ingest`, Bearer-токен и
формат тела НЕ меняются. Проверка после смены: GET
`$GW/admin/cron-status` (ingest не виден там — смотреть метрики приложения
`/api/metrics`: ingest-счётчики растут, `d1_rows_written_total` растёт) или
дашборд «Записи» — новые точки появляются. Откат — вернуть старый URL.

### 9.4 §B6 OpenNext: сборка и деплой сайта под CF Workers

Репо: `bun add -d @opennextjs/cloudflare wrangler` → сборка
`DATABASE_URL="file:./db/local.db" bunx opennextjs-cloudflare build` →
деплой `CLOUDFLARE_API_TOKEN=… bunx wrangler deploy -c wrangler.web.jsonc`.
Секреты — wrangler secret put (значения = Render env). Сайт поднимается на
`https://<name>.<subdomain>.workers.dev`. Домен poedzok.fun переводится на
CF владельцем (зона + смена NS у регистратора + custom domain на воркер);
до перевода домена сайт остаётся на Render через TurboFlare, OpenNext-воркер
работает параллельно как канареечный контур. Известные ограничения B6:
(а) бэкап-роут использует fs (/tmp) — на Workers не работает, НО бэкап
исполняется по cron APP_ORIGIN=poedzok.fun (Render) — не затрагивается;
(б) bcrypt-login на CPU-лимите free-плана Workers — проверять фактически;
(в) 10 мс CPU на инвокацию free — SSR тяжёлых страниц может упираться
(наблюдать, при необходимости Workers Paid $5/мес или оставить сайт на Render).

### 9.5 Тикет GitHub Support (purge PR-refs) — текст готов

23 ссылки refs/pull/*/head держат переписанные до filter-repo коммиты до
GitHub GC. Тикет подаёт владелец (Support API нет) — текст в отчёте ревью
(раунд 19, Постскриптум №7) и в worklog.

## §10. Pack C v2.40.9 (20.09.2026): квота-бюджет, точечная инвалидация, персистентные кэши, edge-телефон

Замер среза 20-5 (Task 27): фоновая нагрузка побеждена Pack A/B (0 чтений в
тихую эпоху), остаточный расход — разовые тяжёлые события. Pack C закрывает
оба верхних источника выгорания (N-6/N-7) и делает квоту ВИДИМОЙ (P1-a):

- **N-6 (app)**: `invalidateSessionCaches(ids)` — инвалидация кэшей ПО
  СПИСКОМ повреждённых сессий (cacheVersion=-1), не глобальным bump'ом;
  `warmStaleSessionCaches` — бюджетный фоновый прогрев протухших (не первым
  зрителем); стартовый warmup греет ТОЛЬКО протухшие (O(повреждённых)).
- **N-7 (app+gateway)**: heavy-segments — единая загрузка точек на запрос
  (было двойное чтение) + двухслойный кэш ответа: in-memory 60с + KV шлюза
  по watermark-ключу (состав групп + период + tz + SESSION_CACHE_VERSION);
  новая сессия → другой watermark → честный пересчёт, TTL 1 ч — страховка.
  Воркер: `POST /kvstore/get|put` (секрет шлюза, тело ≤64 КБ, значение
  ≤512 КБ, TTL 1..3600).
- **P1-a (gateway)**: бюджет-метр дня — шлюз суммирует meta.rows_read/rows_written
  каждого /query и /batch, троттл-флаш (60 с) в KV `quota:day:YYYY-MM-DD`;
  `GET /admin/cron-status` → `budget {day, rowsRead, rowsWritten, quota,
  quotaExhaustedAt, updatedAt}`. Приложение: alerts d1_quota_70/90 читают
  бюджет ШЛЮЗА (кэш 5 мин, 0 строк квоты; фолбэк — локальная свёртка).
- **m-20 (app)**: честный /health — sticky-флаги `d1-quota.ts` (ставятся на
  РЕАЛЬНЫХ D1-ошибках в db-d1.ts, снимаются успешным чтением строк /
  полуночью UTC): db:degraded + `d1Quota{readExhaustedAt,writeExhaustedAt}`
  вместо ложного db:ok при мёртвой квоте; gauges d1_quota_read/write_exhausted.
- **P1-в (app)**: read-back drill бэкапов — auto = ПОЛНЫЙ только воскресенье
  UTC (день github-крона), будни — checksum+расшифровка без парсинга 66 тыс.
  строк (CPU 0.1 — источник 502-таймаутов ночного окна). BACKUP_DRILL_MODE
  = auto|full|checksum.
- **P2 (gateway)**: `POST /api/ingest/sensorlogger` НА EDGE — Push URL
  SensorLogger меняет ТОЛЬКО хост (push.poedzok.fun →
  d1-gateway.markov-saratov.workers.dev), путь/?token=it_…/?deviceId=
  остаются. it_-верификация: HMAC-SHA256(SESSION_SECRET, "<apiKey>:ingest")
  по User-таблице (паритет token-check.ts — юнит-тест сверяет побуквенно),
  результат кэшируется KV на 10 мин. ЧЕСТНЫЕ ОТЛИЧИЯ от Render-канала:
  финализация/trip-grouping/кэши — жнецом приложения ≤ ~10 мин
  (worker-tick */1, порог F8); ingest-trace/метрики — в консоли воркера.
  Воркер-секрет `SESSION_SECRET` обязан совпадать с Render (ротация секрета
  инвалидирует it_-токены на ОБОИХ каналах синхронно).

Мониторинг эффекта: `/api/metrics` — `routes_hotspot_cache_total{layer}` ,
`edge_kv_*`, `d1_quota_*_exhausted`; `/admin/cron-status` — budget дня
(истина расхода, переживает ресайклы приложения); расход чтений должен расти
как O(новых данных), всплеск после релиза = симптом N-6 (больше не должен
воспроизводиться — инвалидация точечная).

## §11. Инцидент 2026-09-25: прод-даунтайм — Render suspend-by-user

**Симптом:** `https://poedzok.fun` → 503 «This service has been suspended by its
owner» (заголовок `x-render-routing: suspend-by-user`), `push.poedzok.fun` —
тоже 503 (оба хоста терминируются TurboFlare → origin).

**Диагноз:** web-сервис `telemetria-poedzok` на Render приостановлен
(suspend-by-user). Не при чём: домен (REG.RU, активен до 07.09.2027, NS
trbcdn/TurboFlare), CDN (пропускает код origin честно), D1-шлюз
`d1-gateway.markov-saratov.workers.dev` — ЖИВ (`/health` → `{"ok":true,
"db":"bound","version":"2.40.9"}`, инжест-эндпоинты отвечают 401 без токена,
как положено), GitHub-бэкапы целы.

**Окно инцидента:** последний успешный GitHub-бэкап `backup-2026-09-20-040109`
(04:01 UTC 20.09, ассет 34.5 МБ `.sql.enc`); бэкапа 21.09 нет → приостановка
произошла между 20.09 04:01 и 21.09 03:30 UTC. Последний код на main — v2.42.1
(CI green, 21.09 08:56 UTC); локальная верификация 25.09: install/test/tsc/
lint/build/start — 299/299 тестов, 0 ошибок типов, `/health` ok, инжест и UI
end-to-end работают. Код исправен — сбой исключительно инфраструктурный.

**Идущая потеря данных:** телефон шлёт инжест на poedzok.fun/push.poedzok.fun →
503 → поездки с ~21.09 не записываются. **Стоп-кран (не ждать resume):**
перевести Sensor Logger на edge-инжест (§9.3): хост →
`https://d1-gateway.markov-saratov.workers.dev`, путь и Bearer-токен НЕ
меняются — точки начнут писаться в D1 немедленно, даже пока Render приостановлен.

**Восстановление (владелец, ~2 минуты):**
1. dashboard.render.com → сервис `telemetria-poedzok` → переключатель
   Suspend → **Resume**. Если Resume «серый» — проверить Billing: просроченная
   карта/неоплаченные инвойсы приводят к suspend всех сервисов аккаунта.
2. После resume убедиться, что задеплоена свежая сборка: Manual Deploy →
   Deploy latest commit (main = v2.42.1). TurboFlare/домен/DNS не трогать.
3. Самовосстановление остального автоматически: cron'ы d1-gateway
   (worker-tick */1, finalize+alerts */5, retention 03:00, backup 03:30,
   github-backup ВС 04:00) стучат в APP_ORIGIN=poedzok.fun и оживут сами;
   следующий ночной бэкап создаст новый draft-релиз.
4. Проверка: из РФ без VPN `https://poedzok.fun/health` →
   `{"status":"ok","version":"2.42.1"}`; дашборд «Записи» — точки пошли.
   Пропущенные за даунтайм поездки — добраться ZIP-архивами Sensor Logger:
   `POST /api/import/zip` (идемпотентен по csv-хэшу, M-1).

**Профилактика:** внешний uptime-монитор `poedzok.fun/health` (Render suspend =
тихий 503 без алертов; cron-pinger песочницы из §CUSTOM_DOMAIN более не
существует), календарная проверка биллинга Render, датчик «бэкапа нет >25 ч»
(последний успешный asset — маркер здоровья origin, см. этот инцидент).

## §12. 2026-09-25: эвакуация с Render — воркер v2.42.2, бэкапы в GitHub Actions

**Продолжение §11.** Render resume невозможен: API отвечает «only services
suspended by a user can be resumed», суспендер — `billing` (неоплаченные
инвойсы платных cron-сервисов, удалённых до нас). Крон-сервисов в аккаунте
уже нет, web-сервис free — единственный, приостановлен 23.09 12:39 UTC
(последняя точка инжеста 06:46 UTC; окно потери поездок: 23.09 утро → далее,
восстановимо ZIP-импортом).

**Данные целы** (перепроверено 25.09): D1 «telemetria» — 215 сессий / 87 739
точек / 35 поездок / 16 849 IngestMessage. «Пропажа» при логине через legacy
`__owner__` — scope-иллюзия (данные принадлежат `admin@telemetria.local`).

**Выполнено 25.09 (v2.42.2, деплой на telemat-web):**
1. `834cba9` fs-толерантность бэкапа/restore на edge-рантайме (memory://-
   маркеры, контент в BackupResult.content); tsc/eslint 0, 299/299.
2. Ротация `GATEWAY_SECRET`/`D1_GATEWAY_SECRET` (d1-gateway + telemat-web +
   Render env синхронизированы новым значением); прямое чтение D1 через
   `/query` шлюза для диагностики.
3. Фикс стоячей нестыковки снапшот-чека (она валила бэкапы 21–23.09 и
   выжигала subrequest-лимит ретраями): Session `bbdcfa84…` (22.09)
   pointCount 2670 → 2671. Σ pointCount = COUNT(GpsPoint) = 87 739 ✅.
4. Обнаружен предел воркера: полный дамп (64 МБ) упирается в CPU/память
   free-плана (`1102`) — POST /api/admin/backup НА ВОРКЕРЕ невозможен.
5. Ночные бэкапы переехали в GitHub Actions: `.github/workflows/backup.yml`
   (cron 03:30 UTC + dispatch) гонит `scripts/backup-remote.ts` — тот же
   production-код (дамп через шлюз → TELMENC1 → draft-релиз → drill).
   Секреты репо: `D1_GATEWAY_SECRET`, `BACKUP_ENCRYPTION_KEY` (значение =
   прежний GITHUB_BACKUP_ENCRYPTION_KEY; имя без GITHUB_-префикса — запрет
   GitHub) + 6 прикладных для env() FAIL-CLOSED. Верифицировано: run #1
   success, релизы backup-2026-09-25-112023 (ручной) и -112513 (GHA),
   оба 64.3 МБ, drill OK.

**Не закрыто (владелец):** origin poedzok.fun / push.poedzok.fun в TurboFlare
всё ещё → onrender (503). Смена origin на `https://telemat-web.markov-
saratov.workers.dev` — в панели turboflare.ru (учётка не восстановима
агентом: пароль REG.RU не подходит; регистрация на markov.saratov@mail.ru).
После переключения оживают cron-каналы d1-gateway (tick/finalize/alerts/
retention — статус в /admin/cron-status перестанет быть 503). Cron 03:30
backup на воркере будет падать 1102 (бэкап живёт в GH Actions — это ожидаемо).
Turso-мигратор: статус blocked (квота чтений Turso), дельта 17–18.09 уже
восстановлена ZIP-импортом 20.09 — блокировка индифферентна.

## §13. Gateway v3 (2026-09-30, CR-C): двойной секрет GHA, схлопывание кронов, adopt/merge-движки

**Исходники:** ветка `ops/gateway-v3-20260930` (репо `markovsaratov-crypto/
telemetria-poedzok`), `cloudflare-worker/d1-gateway.js` (v3, /health →
`version: "2.43.0"`), `cloudflare-worker/wrangler.toml`. До этого FM-движок
существовал только в прод-бандле (раунд frozen-metrics-fix); в v3 он внесён в
исходник репо. Развёртывание — PUT бандла через Workers API (рунбук §8/§12:
multipart metadata `keep_secrets=true` + ЯВНЫЕ не-секретные биндинги).

### Что изменено

1. **F0 Двойной секрет.** Гейты `POST /query` (+`/batch`, `/kvcache`,
   `/kvstore`, `/admin/turso-migrate`) и `GET /admin/*` принимают ЛЮБОЙ из
   `GATEWAY_SECRET` (secret_text, основной — приложение) ИЛИ
   `GHA_GATEWAY_SECRET` (plain_text, канал GitHub Actions). Оба —
   constant-time (SHA-256, `gatewaySecretOk()`). Причина: ротация
   `GATEWAY_SECRET` 2026-09-29 16:54 UTC сломала GHA-бэкап (репо-секрет
   `D1_GATEWAY_SECRET` не обновлялся с 09-25) → 25+ ч без durable-копий.
   Теперь GHA-секрет независим от ротаций основного. Не задан/пуст → вторая
   проверка пропускается.
2. **F1 Схлопывание расписаний.** Триггеры воркера: `*/1 * * * *` (tick) и
   `0 3 * * *` (retention) — PUT `/workers/scripts/d1-gateway/schedules`.
   Джобы `finalize-sessions`/`alerts`/`turso-migrate` (бывший `*/5`)
   запускаются ИЗ тика на минутах `getUTCMinutes() % 5 === 0` —
   последовательно, каждый в своём try/catch. Убраны `30 3 * * *` (backup)
   и `0 4 * * SUN` (backup-github): полный дамп на воркере невозможен
   (CPU 1102, §12) — бэкап живёт ТОЛЬКО в GHA (cron 03:30 UTC). KV-ключи
   `cron:last:backup*` и `CRON_APP_PATHS` сохранены для наблюдаемости.
3. **FM-движок перенесён в исходник** (порт из прод-бандла, семантика 1:1):
   `fmEngineTick` (StatsRollup сегодня/заморозка `fm:frozenThru`/refresh7d),
   перехватчики `fmInterceptQuery` в `/query` (4 шаблона: heal-kill
   1970-01-01, счётчики KPI из rollup), рекон stuck BackupJob (>2 ч →
   failed), прогрев tsw (`statsComputedAt IS NULL` → `GET
   /api/trips/batch?ids=` с Bearer User.apiKey).
4. **F2 fmAdoptOrphans** — усыновление сессий-сирот (born-completed через
   /ingest-порт, `tripId IS NULL`): раз в 5 мин ≤3 сессий с
   `pointCount >= 3`; attach к пересекающейся по времени поездке того же
   устройства (`session.startTime ≤ Trip.spanEnd` И `session.endTime ≥
   Trip.spanStart`, обе стороны через `datetime()`) либо create новой
   поездки (INSERT по образцу `recomputeTripsForDevice`); spanStart/spanEnd
   только расширяются (min/max); метрики/`statsComputedAt` NULL → tsw
   пересчитает; план-джоб — ensure-INSERT как у приложения. Мусорные
   парковочные сердцебиения (1–2 точки) не трогаются. Лог:
   `{"t":"fm:adopt","sessionId":…,"tripId":…,"mode":"attach"|"create"}`.
5. **F3 fmMergeUndercut** — слияние «недосклеенных» кусков: пары живых Trip
   одного устройства с гэпом `spanEnd(a) → spanStart(b)` < 900 с
   (TRIP_SPLIT_SEC); ≤2 пары за прогон; ПЕРЕД слиянием проверка по сессиям
   (MAX(endTime сессий a) vs MIN(startTime сессий b) — реальный гэп ≥ 900 с
   → skip: span мог быть растянут back-extension поверх парковки). Keeper =
   ранний: spanEnd/endTime = max, sessionIds = объединение, sessionCount =
   сумма, метрики NULL; сессии b → `tripId = a`; план-джоб keeper'а
   переочередью; b — жёсткий DELETE (как `recomputeTripsForDevice`;
   сырые Session/GpsPoint не трогаются — поездка восстановима
   `POST /api/admin/backfill-trips`). Лог: `{"t":"fm:merge","tripA":…,
   "tripB":…,"gapMs":…}`.
6. Прочее: пустые `catch {}` → `console.warn` с контекстом; заголовок-шапка
   v3; `/health` version 2.43.0.

### Как откатиться (rollback)

1. **Код:** `PUT /accounts/b8e4…/workers/scripts/d1-gateway` с телом
   `download/telemat-fm/patched-d1-gateway.js` (задеплоенный до-v3 бандл;
   метод — тот же: multipart, metadata `keep_secrets=true` + явные
   не-секретные биндинги; plain_text-биндинг GHA_GATEWAY_SECRET при откате
   можно НЕ подставлять — код до-v3 его игнорирует).
2. **Расписания:** `PUT /accounts/b8e4…/workers/scripts/d1-gateway/schedules`
   с прежними пятью:
   `["*/1 * * * *", "*/5 * * * *", "0 3 * * *", "30 3 * * *", "0 4 * * SUN"]`.
   (Внимание: `30 3`/`0 4 SUN` на до-v3 коде снова начнут падать 1102/530 —
   это ожидаемое до-F0 поведение; см. §12.)
3. **Данные adopt/merge:** идемпотентны к повторам, но НЕ обратимы кодом —
   при ошибочном слиянии запустить канонический пересчёт
   `POST /api/admin/backfill-trips` (пересобирает Trip из точек по
   deviceId); слитые b-поездки восстановит именно он. Журнал действий —
   логи воркера (`fm:adopt`/`fm:merge`/`fm:merge:skip`).

### Как проверить (после деплоя v3)

- `GET /health` → `{"ok":true,"version":"2.43.0"}`; `GET
  /workers/scripts/d1-gateway/settings` → 13 биндингов (6 секретов, включая
  GHA_GATEWAY_SECRET, 6 text/vars, DB, KV).
- `GET /workers/scripts/d1-gateway/schedules` → 2 записи (`*/1`, `0 3`).
- KV (namespace `telemetria-kvcache-probe`): `cron:last:tick` ok каждую
  минуту; `cron:last:finalize-sessions|alerts|turso-migrate` ok каждые 5 мин
  (пишутся из свёрнутого тика); `cron:last:backup*` больше не обновляются
  (заморожены на откате) — бэкап виден только в GHA.
- SQL (read-only через шлюз/аудит): `SELECT count(*) FROM Session WHERE
  tripId IS NULL AND status='completed' AND pointCount>=3` → дрейф к 0
  (мусор 1–2-точечных остаётся намеренно); пары кусков: `SELECT count(*)
  FROM Trip a JOIN Trip b ON a.deviceId=b.deviceId AND a.id<>b.id AND
  datetime(a.spanStart)<datetime(b.spanStart) AND datetime(b.spanStart)>=
  datetime(a.spanEnd) AND datetime(b.spanStart)<datetime(a.spanEnd,'+900
  seconds') WHERE a.deletedAt IS NULL AND b.deletedAt IS NULL` → к 0 (или
  стабильно мало из-за session-verify skip).
- GHA: `POST /repos/…/actions/workflows/backup.yml/dispatches` → run
  success («=== БЭКАП ГОТОВ ===»), draft-релиз `backup-YYYY-MM-DD-*`,
  BackupJob completed (~68 МБ).

### Деплой-журнал 2026-09-30

- **17:07 UTC** — репо-секрет `D1_GATEWAY_SECRET` (GitHub Actions) обновлён
  (libsodium-рецепт CR-B §4; значение = `GHA_GATEWAY_SECRET` шлюза).
- **17:08 UTC** — деплой gateway v3 (PUT бандла через Workers API,
  keep_secrets + явные биндинги): `/health` → `version: "2.43.0"`, db
  bound, 13 биндингов, включая новый plain_text `GHA_GATEWAY_SECRET`.
- **17:09 UTC** — расписания обновлены атомарным PUT: ровно 2 (`*/1` тик,
  `0 3` retention); `*/5`, `30 3`, `0 4 SUN` сняты (%5-свёртка в тике).
- **17:11 / 17:17 UTC** — два GHA workflow_dispatch-рана бэкапа — ОБА
  failed: 401 unauthorized больше НЕТ (двойной секрет F0 работает),
  падение — на консистент-чеке «Σ pointCount активных сессий (97100) !=
  точек в дампе (97101)» (Δ=1; до-существующая болезнь purged-сессий —
  точки purged/archived-сессий остаются в GpsPoint, а Σ pointCount
  считается по активным; телефон был offline с 15:00 UTC → НЕ гонка
  инжеста, ретраи бессмысленны). **Фикс (CR-E):** толерантность дрейфа
  ≤ max(10, 0.1% числа точек) в `src/lib/backup.ts` — WARN «consistency
  drift tolerated» и дамп продолжается; больше порога — fail-closed, как
  раньше. Код исполняется в GHA из репо (workflow backup.yml НЕ менялся) —
  деплой воркеров не требуется, telemat-web не тронут.
- **17:24 UTC** — дневная квота чтений D1 free-tier ИСЧЕРПАНА (2
  dispatch-рана × 3 попытки полного дампа дожгли квоту поверх дневного
  трафика): `finalize-sessions` 429, FM-движки adopt/merge стоят с
  17:20:37. Сброс в 00:00 UTC. До сброса НЕ форсить бэкапы/тяжёлые
  SELECT (каждый полный дамп ≈ сотни тысяч строк чтения).
- **Движки adopt/merge (до исчерпания квоты):** сироты pointCount≥3
  8→5 (+5 новых Trip fmAdoptOrphans в 17:15/17:20; живых Trip 51→54);
  пары кусков — 2 из 3 слиты (52a23bec+241e96ae, 418e1600+6c2ad0ac,
  жёсткий DELETE b), 3-я (e9b7947c+27280f61) — корректный skip по
  реальному сессионному гэпу ≥ 900 с. Новые 5 смежных пар из
  adopted-поездок (гэпы 252–749 с) ждут merge-движка после сброса квоты.

## §14. 2026-10-01 (CR-G): «поездки рвутся на куски снова» — диагноз, GHA-мост, воркер v3.1

### 14.1 Диагноз (запрос юзера вечером 01.10: «где вечерняя поездка сегодня?»)

Четыре независимые корневые причины, полный разбор по сырым данным D1:

- **RC1 — «фейковые поездки» (вкладка «Поездки» и аналитика).**
  `fmAdoptOrphans` v3 усыновляет сирот с pointCount ≥ 3 БЕЗ проверки
  движения. Стоянка с открытым приложением (точки каждые ~20 с, speed=0)
  финализируется → сирота → adopt создаёт Trip **0 км / 0 мин движения**.
  За 30.09 — 5 таких «поездок» (06:40, 07:11, 11:01, 13:23, 14:39) +
  3 старых на других устройствах. Канон приложения (computeActiveTrip)
  требует движения для leg — create-ветка движка это правило нарушала.
- **RC2 — фабрика сирот-сессий (счётчики аналитики).** Телефон в фоне
  шлёт 1-точечные батчи каждые 5 мин (SensorLogger-канал). Прод-шлюз не
  имеет биндинга `SESSION_GAP_MS` → дефолт 60 c < интервала фона → КАЖДОЕ
  сердцебиение = новая сессия. 30.09: **78 сессий** при ~6 реальных
  эпизодах (~50 одиночных точек-сирот, накачка «записей»/дней в rollup).
- **RC3 — «недосклейки» (один выезд порван).** Спека TRIP_SPLIT_SEC=900 c
  рвёт поездку на ЛЮБОМ стоянии/тишине ≥ 15 мин. Утренний выезд 01.10
  (09:21–09:23 локально + стоянка 19 мин + 09:42–09:57) = 2 поездки
  (596 м + 10.2 км) — для юзера это «порванная одна поездка на работу».
- **RC4 — «где вечерняя поездка сегодня».** Сервер ЗДОРОВ (шлюз 2.43.0,
  FM-тик каждую минуту, бэкапы 00:20 и 10:24 UTC — success). Телефон
  отправил последнее сообщение (IngestMessage id 67440) в **09:57:25
  локально** — дальше НОЛЬ точек до конца дня: приложение на телефоне
  было закрыто/убито ОС. Вечерняя поездка 01.10 **не записана физически**
  (нечему появиться); вечер 30.09 тоже оборвался в 19:00 локально (данные
  за рулём 17:23–17:30 — 64 точки, дальше стояние speed=0). Это app-side:
  сервер обязан детектить молчание (F9), юзер — держать приложение живым.

### 14.2 Что сделано СРАЗУ (без деплоя воркера — CF-токен раунда без права PUT)

**GHA-движок лечения** `scripts/trip-heal.ts` + workflow
`.github/workflows/trip-heal.yml` (cron **\*/5**, репо публичный — минуты
GHA бесплатны). SQL через штатный канал шлюза `POST /query|/batch`
(`x-gateway-secret` = `D1_GATEWAY_SECRET` — тот же, что у backup.yml;
воркер НЕ в read-only: `GATEWAY_READ_ONLY` не задан). Шаги за прогон
(идемпотентны, лимитированы; **GpsPoint не трогаются ВООБЩЕ**):

1. **retireStaticTrips** (≤4): Trip с честными метриками
   (statsComputedAt NOT NULL) и distanceM < 100 м И movingTimeSec < 60 c →
   отцепить сессии + DELETE pending/running TrafficJob + hard-DELETE Trip
   (как recomputeTripsForDevice — восстановимо backfill'ом).
2. **softDeleteStandingOrphans** (≤40): сироты (tripId NULL, completed)
   без движения (MAX(speed) < 2 м/с И bbox < 250 м) → `Session.deletedAt`
   (мягко: точки остаются, FM-роллап/приложение исключают deletedAt —
   счётчики самоочищаются; замороженные дни пересчитает часовой refresh7d).
3. **mergeUndercutPairs** (≤3): соседние Trip одного устройства, гэп
   < TRIP_MERGE_MAX_SEC=1800 c (§ «один выезд со стоянкой до 30 минут»),
   проверка по сырым сессиям; стейтменты 1:1 fmMergeUndercut; метрики
   NULL → тsw-прогрев шлюза пересчитает через /api/trips/batch.
4. **deviceSilentAudit**: молчание устройства 3–9 ч / 21–27 ч при
   локальных часах 7..23 → AuditLog `device.silent` (RC4-детект).

**Результат боевых прогонов 16:38–16:40 UTC 01.10:** фейки 9→0;
поездки с 30.09: **11 → 4 чистые** (утро 14.8 км; 08:29–09:18 слит
6.4 км; 09:51 4.8 км; утро 01.10 **слито в одну** 05:21–05:57);
сессий за 30.09: **78 → 12** (день-роллап пересчитает refresh7d);
сироты → 5 (движущиеся оставлены adopt-движку; тест-девайсы не тронуты).

**Ретро-склейка сессий НЕ делается** (сшивка сердцебиений в соседние
сессии меняла бы Trip.sessionIds-состав) — мусор убирается мягко, метрика
«записей» восстанавливается через deletedAt-фильтр FM.

### 14.3 Постоянное решение — d1-gateway v3.1 (код в репо, деплой по рунбуку)

`cloudflare-worker/d1-gateway.js` → **2.44.0**: F6 гейт движения в
create-ветке adopt; F7 fmRetireStaticTrips (≤2/тик, до adopt); F8 окно
merge = биндинг `FM_TRIP_MERGE_MAX_SEC` (дефолт 1800 c); F9 device-silence
аудит в %5-тике. **RC2 чинится биндингом** (код не менялся — ingest-port
уже читает env): `SESSION_GAP_MS=900000` — сердцебиения фона (5 мин)
склеиваются в ОДНУ запись; порог финализации cron приложения
max(10 мин, SESSION_GAP_MS×10) не меняется (сессия живёт, пока фон дышит).

#### Рунбук деплоя v3.1 (когда появится CF-токен с правом Workers Scripts:Edit)

0. Сверить текущие биндинги: `GET /accounts/{acc}/workers/scripts/d1-gateway/settings`
   (брать значения оттуда; на 01.10: 13 биндингов — 6 plain_text, 5 secret, DB, KV).
1. Собрать бандл: `esbuild cloudflare-worker/d1-gateway.js --bundle --format=esm --platform=neutral`
   (проверено 01.10: 104 КБ, node --check OK).
2. PUT воркера (multipart, keep_secrets=true, ЯВНЫЕ не-секретные биндинги +
   НОВЫЕ `SESSION_GAP_MS=900000`, `FM_TRIP_MERGE_MAX_SEC=1800`):
   metadata `{"main_module":"gateway-v3.1.js","compatibility_date":"2026-09-01","keep_secrets":true,"bindings":[…см. §13 шаг 3…, {"type":"plain_text","name":"SESSION_GAP_MS","text":"900000"},{"type":"plain_text","name":"FM_TRIP_MERGE_MAX_SEC","text":"1800"}]}`
   + D1 `DB` id 9dec0a90-… + KV `be49735094b14ad3a41e053c4b1cd308`.
3. Расписания НЕ трогать (те же 2 крона переживают PUT кода; при желании —
   атомарный PUT `[{\"cron\":\"*/1 * * * *\"},{\"cron\":\"0 3 * * *\"}]`).
4. Проверка: `/health` → 2.44.0; через 2–6 мин — KV cron:last:tick ok,
   логи `fm engine tick` с `retired`/`silentAudits`; SQL: фейки = 0.
5. **Отключить cron \*/5 в trip-heal.yml** (закомментировать schedule,
   workflow_dispatch оставить как ручной инструмент) — движки теперь
   в воркере. telemat-web НЕ трогать (мина секретов, §12).

Откат: PUT бандла v3 (тег/commits 4b4b094..004359c, артефакт CR-C) тем же
методом + убрать 2 новых биндинга из metadata; расписание trip-heal.yml
вернуть. GHA-мост и воркер-движки идемпотентны друг к другу (одни и те же
критерии/стейтменты) — сосуществование безопасно на любом этапе.

### 14.4 Открытые пункты после CR-G

- Юзеру: держать приложение живым в поездки (фон Android/iOS убивает
  запись); server-side видимость молчания — AuditLog `device.silent`
  (после деплоя v3.1 — в каждом %5-тике; сейчас — в каждом прогоне моста).
- Ротация: CF API-токен (текущий в песочнице — только чтения), GitHub PAT,
  пароль дашборда — юзер обещал сменить сам (§12/§13).
- До деплоя v3.1 аналитика «записей» может кратко «дышать» (мусорная
  сессия живёт ≤10 мин до выметания мостом) — исчезнет с биндингом
  SESSION_GAP_MS.

## §15. 2026-10-03 (CR-H): регрессия «поездки режутся неверно» — диагноз по данным, мост v3, диспетчер

### 15.1 Диагноз (прод, 03.10 ~11:00 UTC; метод — аудит-воркер /q, GHA-логи, API приложения)

Пять независимых причин, все подтверждены данными:

- **RC-A. Прод до сих пор на d1-gateway v3 (2.43.0)** — v3.1 (2.44.0:
  гейт движения F6, retire F7, окно merge F8=1800с, тишина-аудит F9,
  tsw-фиксы) НЕ задеплоено (CF-токен раунда утерян вместе с песочницей,
  §14.3 рунбук ждёт токен с правом PUT). Движки v3 продолжали:
  adopt без гейта движения (фабрика фейков), merge с окном 900с,
  tsw-прогрев с break-багом и 6ч-KV-голаданием.
- **RC-B. GHA-мост деградировал.** cron `*/5` trip-heal.yml фактически
  исполнялся GitHub'ом ~раз в 4-6 ч (02.10 — 5 прогонов, 03.10 до полудня
  — 2; вместо ~288/сутки). «Мусор живёт ≤10 мин» (§14.2) перестало
  выполняться: фейк-поездки и сироты копились часами. Прогон 01.10
  21:19 ещё и упал на D1-квоте (free tier row read limit).
- **RC-C. Dangling-ссылки Session.tripId → несуществующие поездки.**
  7 сессий указывали на удалённые Trip (35ab2015, 95a74bea, d27a5db4 —
  жертвы конкурентных писателей: adopt/create v3 → merge моста → DELETE).
  В их числе **a69f182f (09:52–10:10, 942 точки, 3.8 км — самый большой
  сегмент дня)**: числилась в tripId несуществующей поездки, не входила
  ни в один sessionIds — полностью невидима во вкладке «Поездки».
- **RC-D. Метрики поездок NULL 36+ часов** (все 4 поездки 01-02.10):
  tsw-прогрев воркера v3 мёртв (KV-ключ ставится ДО fetch, при сбое
  кандидат голодает 6 ч; break-баг = 1/тик; APP_ORIGIN-ветка могла
  молча скипать) + мост обнулял метрики при merge 02.10 18:06/22:08.
  Вкладка «Поездки» читает сырые строки Trip → «— км — мин» (логическая
  ошибка вебморды). Ленивый persist работает только при открытии детали.
- **RC-E. «Поездки» 02.10 состояли из стационарных сессий.** Утро 02.10:
  телефон в фоне слал сердцебиения (сессии по 3-14 точек, bbox=0);
  реальное движение — в отдельных сессиях (572 м, 2875 м, 3784 м).
  Движки собрали «поездки» из стационарных сердцебиений (0 км), а
  движущиеся сессии остались сиротами/dangling → поездки «режутся
  неверно» и «где вечерняя/утренняя езда». Поле speed местами мусорит
  (7337 м/с при 2.9 км; 0 м/с при 572 м) — N-5, доверять только геометрии.
- **Сегодня 03.10 данных нет вообще**: телефон молчит с 02.10 14:30 UTC
  (18:30 локально) — устройство device.silent (AuditLog 02.10 18:06,
  4 ч). Вечерней/ночной/утренней езды 03.10 физически не записано.

### 15.2 Что сделано (без CF-токена — канал GHA-моста + API приложения)

1. **Мост v3** (коммит 516a373, CI green): шаг 0 `repairDanglingRefs`
   (стационарные dangling — soft-delete по геометрии; движущиеся —
   tripId=NULL на adopt), шаг 5 `warmStats` (замена мёртвого tsw:
   statsComputedAt IS NULL + spanEnd старше 10 мин → GET
   /api/trips/batch?ids= c Bearer apiKey владельца — persist в
   приложении), env APP_ORIGIN. Дискриминатор движения в шаге 0 —
   ТОЛЬКО bbox/скорость смещения (поле speed непригодно, RC-E).
2. **Диспетчер mini-services/gheal-dispatcher** (порт 3031, каденс 5 мин):
   workflow_dispatch trip-heal из песочницы — гарантированный каденс
   моста до деплоя v3.1 (GHA-cron больше не источник правды). После
   деплоя v3.1 — остановить (движки переезжают в воркер).
3. **Боевой прогон 03.10 11:00 UTC** (dry-run сверен заранее): 2 фейк-
   поездки 02.10 удалены (retire: 0 км / 0 мин), их стационарные сессии
   soft-delete; 5 стационарных dangling soft-delete; 06b81f98 (2875 м) и
   a69f182f (3784 м) освобождены → adopt-движок воркера создаёт поездки;
   d8ce71e2 (572 м, все speed=0, 1.09 м/с) классифицирован эвристикой
   GPS-дрейфа → soft-delete (обратимо: снять deletedAt при споре).
   Метрики новых поездок греет шаг 5 на следующем цикле (≤10 мин).

### 15.3 Открытые пункты (порядок приоритета)

1. **Деплой d1-gateway v3.1 по рунбуку §14.3** — нужен CF-токен с правом
   Workers Scripts:Edit (создать в dash → Profile → API Tokens; временно
   выдать агенту). После деплоя: остановить gheal-dispatcher, cron
   trip-heal.yml закомментировать, SESSION_GAP_MS=900000 убьёт фабрику
   сирот (RC2 §14) на корню.
2. **Окно склейки vs сплит**: приложение рвёт поездку по TRIP_SPLIT_SEC=900,
   движки склеивают ≤1800 — каноническое правило recomputeTripsForDevice
   при следующем прогоне снова разрежет слитое (флип-флоп для устройств
   с recording-сессиями; для phone-канала born-completed неактивно).
   Радикальное лечение — поднять TRIP_SPLIT_SEC приложения до 1800
   (env telemat-web), требует пересоздания 10 секретов (мина §12) при
   следующем деплое telemat-web. Обсудить с юзером: «выезд со стоянкой
   до N минут» — N=30 сейчас, N=60 вариант.
3. **Приложение на телефоне**: держать живым в поездке (экран/фон без
   убийства ОС); тишина устройства видна в AuditLog device.silent.
4. Ротация: CF API-токен, GitHub PAT, пароль дашборда (юзер, §12-§14).

## §16. 2026-10-03 (CR-I): деплой d1-gateway v3.2 — политика склейки по METHODOLOGY.md, движки в воркере, мост остановлен

**Директива юзера:** «системно исправляй все баги, деплой и делай бекап.
по политике склейки основывайся на файле методологии в гитхабе. хватит
ломаться». CF API-токен с правом Workers Scripts:Edit выдан (рунбук §14.3
исполнен). Диагноз перед деплоем: прод на v3 (2.43.0), GHA-цепочка моста
умерла 03.10 13:09 (транзиентный сокет → exit 1 → chain-шаг skipped),
3 стационарные сироты, dangling=0, coldTrips=0.

### 16.1 Политика склейки — единый порог 900 с (METHODOLOGY.md §4.11/§4.11а)

Файл методологии фиксирует: пауза ≥ `TRIP_SPLIT_SEC` = 900 c — ГРАНИЦА
поездки (инвариант env-проверки приложения; тот же порог у серверных Trip,
leg-сплита и легаси-склейки вкладки «Поездки»). Окно движка 1800 c
(изобретение раунда CR-G «один выезд со стоянкой до 30 минут») НЕ из
методологии и порождало флип-флоп: merge ≤ 1800 → canonical re-split
приложения по 900 → куски возвращаются → «хватит ломаться».

**Деплой-биндинг `FM_TRIP_MERGE_MAX_SEC=900`**: движок клеит ТОЛЬКО
недосклейки < 900 c (то, что канон считает одной поездкой). Слитое НИКОГДА
не содержит внутренней стоянки ≥ 900 c → recompute его не разрежет →
стабильный фикс-поинт, флип-флоп устранён конструктивно. Стоянка ≥ 15 мин
в новой политике = отдельная поездка (по канону). Хотите «до 30 минут» —
это изменение METHODOLOGY.md + TRIP_SPLIT_SEC приложения (мина секретов
§12) — решение за владельцем.

### 16.2 Что в v3.2 (2.45.0; код — cloudflare-worker/d1-gateway.js)

1. **F6/F7/F8/F9/tsw-фиксы v3.1** (CR-G, ждали деплоя): гейт движения в
   adopt-create, retire фейков, окно merge = биндинг, device-silence аудит,
   tsw без break-бага (до 3 поездок за тик, 9 кандидатов).
2. **F10 fmSoftDeleteStandingOrphans** (порт шага 2 моста, бой 01-03.10):
   стационарные completed-сироты (maxSpeed < 2 м/с И (bbox < 250 м ИЛИ
   bbox/длительность < 1,4 м/с — GPS-дрейф f53153d4)) → Session.deletedAt;
   ≤20/тик на %5-минуте, окно 2 суток, pointCount ≤ 3000. После остановки
   моста мусор выметает воркер.
3. **tsw-окно 6 ч → 10 мин** (логическая ошибка вебморды RC-D: свежие
   поездки висели «— км — мин» до 6 ч; боевая практика моста — 10 мин).
   TTL KV-маркера fm:tsw 21600 → 900 c (ретрай сбоя через 15 мин).
4. **Биндинги деплоя**: `SESSION_GAP_MS=900000` (RC2: сердцебиения фона
   склеиваются в одну запись) + `FM_TRIP_MERGE_MAX_SEC=900` (§16.1).
5. Мост trip-heal: дефолт/окно 900 (CR-I), cron ОТКЛЮЧЁН (движки в
   воркере), chain-шаг `!cancelled()` (транзиентный сбой шага больше не
   убивает цепочку — кейс 13:09 03.10). workflow_dispatch — ручной
   инструмент/страховка.

### 16.3 Журнал деплоя (см. git-историю и worklog CR-I)

PUT бандла esbuild 106 КБ (multipart, keep_secrets=true, явные plain-text
биндинги + DB + KV; секреты CRON_SECRET/GATEWAY_SECRET/INGEST_TOKEN/
SESSION_SECRET/TURSO_AUTH_TOKEN пережили PUT). Расписания не менялись
(*/1 tick + 0 3 retention). Проверка: /health → 2.45.0; эффекты движков —
по данным (сирота 849cd816 выметена F10, KV-ключи tsw TTL 900 c).

Откат: PUT бандла v3 (артефакт CR-C) или v3.1 (коммит ba957f1) тем же
методом; биндинги SESSION_GAP_MS/FM_TRIP_MERGE_MAX_SEC можно не снимать
(код v3 их не читает) — снять при необходимости через settings PUT.
