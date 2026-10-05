// d1-gateway v3 (CR-C, 2026-09-30) — аутентифицированный SQL-шлюз над Cloudflare D1.
// Деплой: Workers API (module syntax). БД привязана биндингом DB.
// Auth: заголовок X-Gateway-Secret — основной секрет GATEWAY_SECRET (secret_text)
// ИЛИ v3-второй секрет GHA_GATEWAY_SECRET (plain_text, канал GitHub Actions).
//
// ─── v3 (CR-C, ветка ops/gateway-v3-20260930) — что изменено ───
//  F0 Двойной секрет: POST/GET-гейты принимают ЛЮБОЙ из GATEWAY_SECRET |
//     GHA_GATEWAY_SECRET (оба constant-time, SHA-256). Причина: секрет
//     GATEWAY_SECRET ротировали 2026-09-29, а репо-секрет D1_GATEWAY_SECRET
//     (GitHub Actions бэкап) с 2026-09-25 не обновлялся → 401, durable-бэкапов
//     нет 25+ ч. GHA теперь ходит со своим секретом, независимым от ротаций
//     основного (см. docs/OPERATIONS.md §13).
//  F1 Схлопывание расписаний: триггеры воркера = "*/1 * * * *" (tick) и
//     "0 3 * * *" (retention). Джобы finalize-sessions/alerts/turso-migrate
//     (бывший */5) запускаются ИЗ ТИКА на минутах %5===0 — последовательно,
//     каждый в своём try/catch (раньше */1 и */5 вызывали приложение ДВАЖДЫ
//     в одну минуту :00/:05/:10…). Записи backup (30 3) и backup-github
//     (0 4 SUN) УДАЛЕНЫ: полный дамп на воркере невозможен (CPU 1102, §12),
//     бэкап живёт ТОЛЬКО в GitHub Actions (cron 03:30 UTC, workflow backup.yml).
//  + FM-движок замороженных суточных метрик перенесён в исходник из
//     прод-бандла (раунд frozen-metrics-fix 2026-09-30): fmEngineTick на тике
//     (StatsRollup сегодня/заморозка/refresh7d), перехватчики SQL в /query
//     (4 шаблона: heal-kill 1970, счётчики из rollup), рекон stuck BackupJob,
//     прогрев tsw (statsComputedAt IS NULL → GET /api/trips/batch?ids=).
//  F2 fmAdoptOrphans: усыновление сессий-сирот (born-completed через
//     /ingest-порт, tripId IS NULL): ≤3 сессий/тик с pointCount ≥ 3 — attach
//     к пересекающейся по времени поездке или create новой; метрики NULL →
//     tsw пересчитает. Мусор 1–2-точечных парковочных сердцебиений не трогаем.
//  F3 fmMergeUndercut: слияние «недосклеенных» кусков Trip (гэп < 900 с =
//     TRIP_SPLIT_SEC): ≤2 пары/тик, проверка по сессиям (сырьё, не span),
//     keeper = ранний, b удаляется как в recomputeTripsForDevice (жёсткий
//     DELETE; сырые Session/GpsPoint не трогаются).
//
// ─── v3.1 (CR-G, 2026-10-01 «куски поездок» — см. docs/OPERATIONS.md §14) ───
//  F6 Гейт движения в fmAdoptOrphans (create-ветка): стационарная сессия
//     (maxSpeed < 2 м/с И bbox < 250 м) НЕ становится поездкой — как канон
//     приложения (computeActiveTrip требует движения для leg). RC1: adopt v3
//     создал 5 «поездок» 0 км из стоянок с открытым приложением.
//  F7 fmRetireStaticTrips: вывод ГОТОВЫХ фейков — Trip с честными метриками
//     (statsComputedAt NOT NULL) и distanceM < 100 м И movingTimeSec < 60 c →
//     отцепить сессии + hard-DELETE (≤2/тик, перед adopt).
//  F8 Окно слияния fmMergeUndercut: биндинг FM_TRIP_MERGE_MAX_SEC (сек,
//     дефолт 1800 = «один выезд со стоянкой до 30 минут»; было 900 жёстко).
//     RC3: спека TRIP_SPLIT_SEC=900 c рвёт один выезд на любой стоянке >15 мин.
//  F9 device-silence аудит: устройство молчит 3-9 ч / 21-27 ч при локальных
//     часах 7..23 → AuditLog action='device.silent' (RC4: «вечерняя поездка
//     не записалась» — приложение на телефоне умерло в 10 утра, никто не
//     узнал). Троттлинг 20 ч по индексу AuditLog(action, createdAt).
//  + ДЕПЛОЙ-ТРЕБОВАНИЕ (рунбук §14): биндинг plain_text SESSION_GAP_MS=
//     900000 — склейка фоновых сердцебиений телефона (5 мин) в ОДНУ запись
//     вместо фабрики сирот (RC2: 60 c дефолт < интервала фона).
//  + GHA-мост scripts/trip-heal.ts (cron */5) уже чинит те же RC1/RC3 в
//     данных через /query|/batch — после деплоя v3.1 его cron отключить.
//  Мелочи: пустые catch {} → console.warn с контекстом; /health version 2.44.0.
//
// ─── v3.2 (CR-I, 2026-10-03 «хватит ломаться»: деплой по рунбуку §14.3 + политика склейки по METHODOLOGY.md) ───
//  F10 fmSoftDeleteStandingOrphans: порт шага 2 GHA-моста (бой 01-03.10) —
//     осиротевшие completed-сессии БЕЗ ДВИЖЕНИЯ (maxSpeed < 2 м/с И
//     (bbox < 250 м ИЛИ bbox/длительность < 1,4 м/с — кейс GPS-дрейфа
//     f53153d4)) → Session.deletedAt (мягко, обратимо; FM-роллап и
//     приложение исключают deletedAt — счётчик «записей» не дышит мусором).
//     Дискриминатор — ТОЛЬКО геометрия: поле speed мусорит (N-5).
//     После остановки моста мусор выметает воркер (≤20/тик на %5-минуте,
//     окно 2 суток, pointCount ≤ 3000; гиганты — движку adopt по-прежнему).
//  tsw-окно: spanEnd старше 6 ЧАСОВ → 10 МИНУТ (вслед за боевой практикой
//     моста): свежая поездка получает метрики ≤ ~15 мин, а не «— км — мин»
//     до 6 ч (логическая ошибка вебморды, RC-D). TTL KV-маркера fm:tsw:
//     6 ч → 900 с (сбойный прогрев ретраится через 15 мин, а не голодает).
//  ПОЛИТИКА СКЛЕЙКИ — ЕДИНЫЙ ПОРОГ ПО METHODOLOGY.md (§4.11/§4.11а):
//     пауза ≥ 900 с (TRIP_SPLIT_SEC, инвариант env-проверки приложения) =
//     ГРАНИЦА поездки; < 900 с = внутри поездки. Деплой-биндинг
//     FM_TRIP_MERGE_MAX_SEC=900: движок клеит ТОЛЬКО недосклейки < 900 с
//     (то, что канон считает одной поездкой) и НИКОГДА не создаёт поездку
//     с внутренней стоянкой ≥ 900 с, которую recompute приложения тут же
//     разрежет обратно (флип-флоп «слил → разорвало → куски снова» —
//     устранён конструктивно: merge-окно == split-порог = стабильный
//     фикс-поинт). Биндинг SESSION_GAP_MS=900000 (RC2) не меняется.
//  Мелочи: /health version 2.45.0.
//
// ─── v3.3 (CR-J, 2026-10-03 кодревью топ-архитектора — hardening GHA-канала) ───
//  J-B3 Канальные привилегии: gatewaySecretChannel() возвращает "main"|"gha"
//     вместо bool. GHA-канал (репо-секреты GitHub) — read-only с хирургическим
//     исключением (см. v3.4): паттерн PAT-компрометации больше не даёт канал
//     полного DML к прод-D1. Main-канал (приложение) — без изменений.
//  Мелочи: GHA_GATEWAY_SECRET деплоится биндингом secret_text (был plain_text
//     — читался из /settings любым токеном с правом чтения настроек воркера).
//
// ─── v3.4 (CR-J, фикс живого прогона 16:24 UTC) ───
//  Ночной бэкап GHA делает ПЕРВЫМ делом INSERT INTO BackupJob (+UPDATE статусов
//  + INSERT AuditLog) — v3.3 read-only его убил (backup run 37136737540,
//  «forbidden», 0.2 с от старта). GHA-DML теперь ALLOWLIST: BackupJob/AuditLog
//  (операционные таблицы бэкап-конвейера) — можно; ВСЁ остальное (Session/Trip/
//  GpsPoint/TrafficJob/User/…) — только при GATEWAY_GHA_DML="true" (аварийный
//  ручной heal); User — НИКОГДА (даже при флаге). SELECT/PRAGMA — как было.
//  /health version 2.47.0.
//
// ─── v3.6 (CR-G-finish, 2026-10-05 «доделывай аудит»: durable-фиксы A1/A8) ───
//  A1-DURABLE fmDayAudit + флаг fm:dirtyScan: удаления/восстановления юзера
//     (UPDATE Session SET deletedAt…) в /query|/batch ставят KV-флаг — day-
//     audit на СЛЕДУЮЩЕМ тике пересчитывает замороженные суточные строки
//     (до сих пор дрейф лечился разовым реконсайлом: удаления старше 7-днев-
//     ного окна refresh7d оставляли призраков в KPI — прод-кейс 01-02.10:
//     +9703 точки/+10,7%). Гарантия — каждые 10 минут (импорт в старый день,
//     внутренние мутации движка, любой другой источник дрейфа). Сверка — по
//     ТОЧНОЙ методологии fmComputeDays (тот же rollupDayKey/TZ, тот же мап-
//     пинг userId): несовпадение = реальный дрейф, а не артефакт ключа.
//     Прунинг: день без живого состава юзера → его StatsRollup-строка
//     удаляется (зомби-дни 09-03 больше невозможны конструктивно).
//  A6/A7-РЕСИНК fm:resync:statsv3: после деплоя приложения ≥ 2.44.0 (проверка
//     GET /health — безопасен при любом порядке деплоев) — одноразово NULL-ит
//     statsComputedAt всех финальных поездок; прогрев tsw пересчитает их
//     новым кодом (MaxSpeed: гео-корроборация спайк-поездов + гео-фоллбек
//     для NULL-speed; 9 поездок/тик, ~30 мин на весь парк).
//  A8-вывод: limits.cpu_ms НЕ деплоится — аккаунт на Workers FREE-плане
//     (GHA-деплой 05:03 UTC: «CPU limits are not supported for the Free plan»,
//     code 100328). CPU-потолок поднимется апгрейдом плана (ops-рекомендация
//     юзеру, $5/мес); код-путь снижения CPU уже сделан ранее (интерцепторы
//     Q1-Q4, чанки батча v2.43.1).
//  /health version 2.48.0.
//
// Эндпоинты:
//   GET  /health                          → {ok, gateway:"d1", db:"bound"}
//   POST /query   {sql, params?}          → {rows, rowsAffected, meta}
//   POST /batch   {statements:[{sql,params}]} → АТОМАРНО → [{rows, rowsAffected, meta}, ...]
//   POST /ingest  (body Sensor Logger)    → §B1: см. ingest-port.js (своя auth)
//   POST /kvcache {key, sql, params, ttlSec} → §B2: SELECT через KV-кэш
//   POST /kvcache/invalidate {prefix}     → §B2: сброс кэша по префиксу
//   POST /api/ingest                      → §B1 v2.40.0: алиас /ingest (host-only switch)
//   POST /api/ingest/sensorlogger         → §P2 v2.40.9: SensorLogger-native канал (it_)
//   POST /kvstore/get {key}               → §P0-b v2.40.9: сырой KV для артефактов
//   POST /kvstore/put {key, value, ttlSec} → §P0-b v2.40.9: запись артефакта (≤512 КБ)
//   POST /admin/turso-migrate {steps?,reset?} → §T-DELTA: шаги мигратора Turso-дельты
//   GET  /admin/turso-migrate/status      → §T-DELTA: состояние миграции (KV)
//   GET  /admin/cron-status               → §B5: cron-джобы + budget дня (§P1-a v2.40.9)
//   scheduled (Cron Triggers)             → §B5: планировщик вместо cron-сервисов Render
//
// Формат ответа повторяет @libsql/client ResultSet (rows как объекты,
// rowsAffected), чтобы адаптер на стороне приложения оставался тонким.
//
// v2.37.0 (миграция Turso → D1): воркер создан, потому что D1 REST API
// требует отдельного разрешения у токена; биндинг воркера получает доступ
// к D1 через Workers-рантайм без D1-API-прав у токена деплоя.
//
// v2.38.1 (ревью F1, hardening): секрет шлюза был скоммичен в публичный репо
// (.env.production.local, коммит 25bd1bd) — «один секрет» больше не считается
// достаточной защитой, добавлены три слоя (ротация секрета — владелец, см.
// docs/SECURITY-ROTATION.md):
//   1) ВАЙТЛИСТ ОПЕРАЦИЙ: только SELECT/INSERT/UPDATE/DELETE по известным
//      таблицам (prisma/schema.prisma + рантайм-таблица _AlertState) + два
//      идемпотентных исключения (PRAGMA page_count/page_size, CREATE TABLE IF
//      NOT EXISTS _AlertState). DROP/ALTER/ATTACH/VACUUM/PRAGMA(прочие)/CTE и
//      любые неизвестные таблицы (вкл. sqlite_*) → 403 ДО исполнения;
//   2) ЛИМИТ ТЕЛА: стрим с капом (дефолт 2 МБ) → 413 — и по content-length,
//      и по фактическим байтам (chunked без заголовка не проходит);
//   3) PER-IP RATE-LIMIT в памяти изолейта (дефолт 3000/мин → 429;
//      env-оверрайд GATEWAY_RATE_LIMIT_MAX). Дефолт НЕ 60/мин из рецепта
//      ревью осознанно: единственный легитимный вызывающий — приложение на
//      Render, один HTTP-запрос API порождает несколько SQL-вызовов (фан-аут
//      инжеста/статов), 60/мин душил бы прод; 3000/мин = 50 rps ≈ 10×
//      пикового легитимного трафика, останавливает runaway-циклы и
//      скан-штормы с украденным секретом. Проверяется ПОСЛЕ auth — без
//      секрета нельзя бесплатно 429-нуть легитимного вызывающего.
//
// v2.38.2 (ревью F33, minor): (а) секрет сравнивается по SHA-256-дайджестам
//      без раннего выхода по длине (раньше тайминг ответа 401 выдавал ДЛИНУ
//      секрета); (б) опциональный READ-ONLY режим (env GATEWAY_READ_ONLY) —
//      только SELECT и read-only PRAGMA, см. isReadOnly().
//
// v2.39.1 (§B1 + §B2, docs/OPTIMIZATION-PROPOSAL.md): 
//   §B1 — монтаж edge-инжеста: /ingest проксирует в handleEdgeIngest из
//      ./ingest-port.js (портативный ESM-модуль, паритет ответов с
//      /api/ingest). Своя авторизация: INGEST_TOKEN (Bearer или ?token=)
//      ИЛИ X-Gateway-Secret — поэтому ветка стоит ДО общего гейта секрета.
//      it_/apiKey-канал на edge сознательно не поддержан (личные
//      устройства — через Render, см. шапку ingest-port.js).
//   §B2 — KV-кэш тяжёлых SELECT (cache-aside на стороне воркера, биндинг KV
//      типа kv_namespace, ОБРАТНАЯ СОВМЕСТИМОСТЬ: биндинга нет → прямой
//      запрос, kv:"passthrough" — приложение без KV не меняет поведение):
//      только SELECT по таблицам вайтлиста (та же validateStatement в
//      read-only режиме), значение — JSON {rows} с капом 512 КБ, TTL
//      клиентский ttlSec (платформенный минимум KV 60с — округляем вверх,
//      задокументировано в edge-gateway.ts), инвалидация — list по префиксу
//      с пагинацией (кап 100 страниц = 100k ключей, полный сброс «dash:»).

import { handleEdgeIngest, handleEdgeSensorLogger, rollupDayKey } from "./ingest-port.js";
// rollupDayKey — из ingest-port.js: ключ rollup-дня (YYYY-MM-DD) в TZ оператора;
// используется FM-движком (fmComputeDays) — тот же расчёт дня, что у приложения.

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

// ——— v2.38.1 (ревью F1): вайтлист операций ———
// Таблицы prisma/schema.prisma (User, Session, Trip, GpsPoint, Route,
// RouteCache, TrafficJob, AuditLog, ExportJob, BackupJob, Setting,
// IngestMessage) + рантайм-таблица алертов _AlertState (alerts.ts и
// restore-core.ts). Всё, чего нет в списке (включая sqlite_*), → 403.
const ALLOWED_TABLES = new Set(
  [
    "User",
    "Session",
    "Trip",
    "GpsPoint",
    "Route",
    "RouteCache",
    "TrafficJob",
    "AuditLog",
    "ExportJob",
    "BackupJob",
    "Setting",
    "IngestMessage",
    "_AlertState",
    // v2.39.1 (§A1): дневные агрегаты — /query читает/пишет её ПОСЛЕ деплоя
    // v2.39.0-приложения; /ingest-порт пишет независимо от вайтлиста
    // (стейтменты фиксированы), строка нужна для /query и create-index.
    "StatsRollup",
    // v2.42.0 («Вариант 1»): расчётные снапшоты финальных записей (>24 ч) —
    // рендер-трек/события + метрики; читают/пишут батч-роуты рендера,
    // warm/бэкфилл и retention-purge (DELETE). До СВОЕГО деплоя все SQL к
    // ней = 403 — приложение консервативно живёт на пути v2.41.0.
    "TripCalc",
    // v2.42.1-fix (27.09.2026, возвращён в v3.5 04.10.2026 — потерян при
    // пересборке v3 из исходников): служебная таблица блокировок экспорта —
    // worker-runtime.ts pollExportJobs()/reclaimStuckExportJobs() (F9,
    // v2.38.1). Без неё каждый worker-tick ловил 403 «forbidden table:
    // _exportjoblock» («export poll failed» в логах), ExportJob застревал
    // в pending навсегда, экспорт больших сессий зависал.
    "_ExportJobLock",
  ].map((t) => t.toLowerCase())
);

// Единственные исключения помимо DML (оба используются рантаймом приложения):
//  - PRAGMA page_count / PRAGMA page_size — read-only размер БД (alerts.ts,
//    правило db_size_growth; при отказе деградирует мягко — «PRAGMA недоступен»);
//  - CREATE TABLE IF NOT EXISTS _AlertState — идемпотентное самовосстановление
//    KV-таблицы алертов (alerts.ts + restore-core.ts). IF NOT EXISTS = no-op на
//    существующей таблице, существующие данные не трогает.
const PRAGMA_RE = /^PRAGMA\s+(page_count|page_size)\s*$/i;
const CREATE_ALERTSTATE_RE = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?_AlertState"?\s*\(/i;
// v2.39.1 (§A1): ленивое самовосстановление StatsRollup-таблицы приложением
// (src/lib/stats-rollup.ts ensureStatsRollupTable — идемпотентный DDL, тот же
// паттерн что _AlertState: IF NOT EXISTS = no-op на существующей).
const CREATE_STATSROLLUP_RE = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?StatsRollup"?\s*\(/i;
// v2.42.0 («Вариант 1»): ленивое самовосстановление TripCalc-таблицы
// приложением (src/lib/trip-calc.ts ensureTripCalcTable — идемпотентный DDL,
// тот же паттерн _AlertState/StatsRollup; ретрай каждые 10 мин, чтобы
// таблица поднялась сразу после ЭТОГО деплоя шлюза без ресайкла Render).
const CREATE_TRIPCALC_RE = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?TripCalc"?\s*\(/i;
// v2.42.1-fix: см. комментарий в ALLOWED_TABLES (_ExportJobLock).
const CREATE_EXPORTLOCK_RE = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?_ExportJobLock"?\s*\(/i;
// v2.38.2 (ревью F50): идемпотентные индексы ensure-on-boot. Приложение
// создаёт Session_userId_startTime_idx лениво при первом списковом запросе
// (db.ts, fire-and-forget). IF NOT EXISTS = no-op на существующем индексе;
// допустимы только индексы на таблицах из ALLOWED_TABLES, имя индекса
// ограничено [A-Za-z0-9_] чтобы не протащить инъекцию в имя.
const CREATE_INDEX_RE =
  /^CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+"?([A-Za-z0-9_]+)"?\s+ON\s+"?([A-Za-z0-9_]+)"?\s*\(/i;

// ——— v2.38.1 (ревью F1): лимит тела и rate-limit ———
const MAX_BODY_BYTES_DEFAULT = 2 * 1024 * 1024; // 2 МБ
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_DEFAULT = 3000; // см. комментарий в шапке — почему не 60
const RATE_BUCKETS_MAX = 10000;

// ——— v2.39.1 (§B2): константы KV-кэша ———
// Тело /kvcache мало (sql+params): 64 КБ хватает с запасом, отдельный кап
// НЕ даёт кэш-эндпоинту съесть общий бюджет тела 2 МБ / гонки content-length.
const KVCACHE_MAX_BODY_BYTES = 64 * 1024;
// Ключи приложения — соглашение §B2: dash:{scope}:{day}:{cacheVersion};
// валидация имени отсекает пробел/управляющие/юникод-инъекции в KV-пространство.
const KVCACHE_KEY_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
// Значение — JSON {rows}: 512 КБ покрывает агрегаты дашборда (62 метрики ×
// 30 дней); большее — не кэшируем (отдаём как miss), чтобы изолят не душил
// память сериализацией чужих широких выборок.
const KVCACHE_VALUE_MAX_CHARS = 512 * 1024;
// TTL: 1..3600 с; платформенный минимум KV 60с — клиентские ttlSec<60
// округляются ВВЕРХ (клиент edge-gateway.ts осведомлён: «протухнет само»).
const KVCACHE_TTL_MIN_SEC = 1;
const KVCACHE_TTL_MAX_SEC = 3600;
const KV_PLATFORM_MIN_TTL_SEC = 60;
// Инвалидация: list пагинирован (1000 ключей/страница); 100 страниц — щит от
// бесконечного курсора, на реальном «dash:» десятки ключей.
const KVCACHE_INVALIDATE_MAX_PAGES = 100;
// Параметры bound-запроса: 100 с запасом поверх бюджета 90 ingest-порта.
const KVCACHE_PARAMS_MAX = 100;

// v2.38.2 (ревью F33): секрет сравнивается по ДАЙДЖЕСТАМ SHA-256 (как
// src/lib/token-check.ts в приложении — здесь inline, воркер отдельный файл):
// сначала хешируем ОБЕ стороны, потом сравниваем дайджесты XOR-аккумулятором
// по всей длине. Фиксированная длина (32 байта) убирает ранний выход по длине
// — старая версия возвращала false сразу при a.length !== b.length и
// утекала ДЛИНУ секрета по времени ответа 401. crypto.subtle доступен в
// Workers-рантайме из коробки.
async function secretEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** v3 (CR-C F0): гейт секрета шлюза — ЛЮБОЙ из двух секретов.
 *  • GATEWAY_SECRET (secret_text) — основной, им ходится приложение
 *    (telemat-web) и рунбук /admin/cron-status;
 *  • GHA_GATEWAY_SECRET (secret_text, v3.3) — второй, независимый канал GitHub
 *    Actions (бэкап 03:30 UTC): ротация основного секрета 2026-09-29
 *    оставила GHA с протухшим D1_GATEWAY_SECRET → 401 → 25+ ч без
 *    durable-бэкапов (CR-B §3.5). Второй секрет ротируется отдельно
 *    (PUT репо-секрета + биндинг при деплое шлюза).
 *  Оба сравнения — constant-time (secretEquals, SHA-256-дайджесты).
 *  GHA_GATEWAY_SECRET не задан/пуст → вторая проверка просто пропускается.
 *  Ни один не сконфигурирован → гейт закрыт наглухо (как раньше).
 *
 *  v3.3 (CR-J, ревью J-B3): гейт возвращает КАНАЛ ("main" | "gha" | null),
 *  а не просто bool — канал определяет привилегии DML (см. isGhaDmlEnabled
 *  и ghaUserDmlViolation ниже): GHA-канал по умолчанию READ-ONLY (бэкапу
 *  нужны только SELECT), DML на нём — только явным флагом GATEWAY_GHA_DML,
 *  а таблица User — НИКОГДА (passwordHash/apiKey вне досягаемости GHA-канала,
 *  даже при включённом флаге). Мотив: GHA-секрет живёт в репо-секретах
 *  GitHub — PAT-компрометация не должна давать канал полного DML к прод-D1. */
async function gatewaySecretChannel(env, presented) {
  const s = typeof presented === "string" ? presented : "";
  const hasPrimary = typeof env.GATEWAY_SECRET === "string" && env.GATEWAY_SECRET.length > 0;
  const hasGha = typeof env.GHA_GATEWAY_SECRET === "string" && env.GHA_GATEWAY_SECRET.length > 0;
  if (!hasPrimary && !hasGha) return null;
  if (hasPrimary && (await secretEquals(s, env.GATEWAY_SECRET))) return "main";
  if (hasGha && (await secretEquals(s, env.GHA_GATEWAY_SECRET))) return "gha";
  return null;
}

async function gatewaySecretOk(env, presented) {
  return (await gatewaySecretChannel(env, presented)) !== null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

// ——— v2.38.1 (ревью F1): валидация стейтмента вайтлистом ———

// Убирает SQL-комментарии (-- и /* */) — глагол/таблицу нельзя спрятать в них.
function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

// Имена таблиц после FROM/JOIN/INTO/UPDATE. «DO UPDATE SET» (хвост ON CONFLICT)
// вырезаем заранее — иначе за таблицу примется SET (alerts.ts: INSERT ... ON
// CONFLICT(key) DO UPDATE SET ...). Подзапрос «FROM (SELECT ...)» не матчится
// (за ключевым словом идёт «(», не идентификатор) — внутренние FROM ловятся
// тем же общим сканом.
const TABLE_TOKEN_RE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/gi;
function extractTableNames(sql) {
  const clean = stripSqlComments(sql).replace(/\bDO\s+UPDATE\s+SET\b/gi, " ");
  const names = new Set();
  let m;
  while ((m = TABLE_TOKEN_RE.exec(clean)) !== null) {
    names.add((m[1] ?? m[2] ?? m[3] ?? "").toLowerCase());
  }
  return names;
}

// v2.38.2 (ревью F33): опциональный READ-ONLY режим (env-биндинг воркера
// GATEWAY_READ_ONLY="true"/"1", читается из env ВЫЗОВА как
// GATEWAY_RATE_LIMIT_MAX — process.env в Workers-рантайме недоступен).
// Поверх вайтлиста операций: пропускаются ТОЛЬКО SELECT и два
// read-only PRAGMA (page_count/page_size) — INSERT/UPDATE/DELETE/CREATE
// отклоняются 403 ДО исполнения. Зачем: при компрометации единственного
// секрета зона поражения сужается с «вся БД» до «чтение»; полезно для
// страховочных реплик/отладочных инсталляций. Дефолт ВЫКЛ: приложение
// легитимно пишет через /query (execute() шлёт все DML — db-d1.ts),
// включение режима требует перевода приложения на read-only-потребление.
function isReadOnly(env) {
  return env.GATEWAY_READ_ONLY === "true" || env.GATEWAY_READ_ONLY === "1";
}

// v3.3 (CR-J, J-B3): GHA-канал — ПО УМОЛЧАНИЮ read-only, НО с хирургическим
// исключением: операционные таблицы бэкап-конвейера (BackupJob — статус/рекон
// джоба, AuditLog — аудит операций) пишутся ЛЕГИТИМНО ночным бэкапом GHA
// (backupToGitHub: db.backupJob.create() ПЕРВОЕ действие — v3.3 read-only
// сломал ночной конвейер, найдено живым прогоном 03.10 16:24 UTC).
// Пользовательские данные (User/Session/Trip/GpsPoint/TrafficJob/…) —
// read-only на GHA-канале ВСЕГДА: PAT-компрометация GitHub не даёт запись
// в телеметрию и аккаунты. Аварийный DML полного спектра (ручной trip-heal:
// UPDATE Session/Trip) — временный биндинг GATEWAY_GHA_DML="true"
// (рунбук §14.3/§17.2: включить → прогнать → выключить); таблица User
// заблокирована ДАЖЕ при включённом флаге.
const GHA_DML_TABLES = new Set(["backupjob", "auditlog"]);

function isGhaDmlEnabled(env) {
  return env.GATEWAY_GHA_DML === "true" || env.GATEWAY_GHA_DML === "1";
}

// v3.4 (CR-J): DML-проверка GHA-канала. Возвращает причину отказа или null.
// — SELECT/PRAGMA: не проверяются здесь (validateStatement уже пропустил);
// — INSERT/UPDATE/DELETE: таблица ∈ GHA_DML_TABLES (бэкап-конвейер) → OK;
// — иначе: только при GATEWAY_GHA_DML=true (аварийный режим) — и НИКОГДА User.
function ghaDmlViolation(sql, env) {
  const clean = stripSqlComments(String(sql).replace(/;\s*$/, "")).trim();
  const verbMatch = clean.match(/^([A-Za-z]+)/);
  if (!verbMatch) return null;
  const verb = verbMatch[1].toUpperCase();
  if (verb !== "INSERT" && verb !== "UPDATE" && verb !== "DELETE") return null;
  const tables = extractTableNames(clean);
  if (tables.size === 0) return null;
  for (const t of tables) {
    if (t === "user") {
      return "gha channel: User table is read-only (passwordHash/apiKey are out of scope)";
    }
    if (!GHA_DML_TABLES.has(t) && !isGhaDmlEnabled(env)) {
      return `gha channel read-only: DML on ${t} requires GATEWAY_GHA_DML (emergency runbook 17.2; BackupJob/AuditLog allowed for nightly backup)`;
    }
  }
  return null;
}

// Валидация ОДНОГО стейтмента. null = разрешено; строка = причина отказа (403).
function validateStatement(sql, readOnly) {
  // Мульти-стейтменты через «;» запрещены (D1 prepare их и так отверг бы —
  // валидируем ДО исполнения, включая попытку «SELECT 1; DROP TABLE Session»).
  const noTrailing = sql.replace(/;\s*$/, "");
  if (noTrailing.includes(";")) return "multiple statements are not allowed";

  const clean = stripSqlComments(noTrailing).trim();
  if (clean.length === 0) return "empty statement";

  const verbMatch = clean.match(/^([A-Za-z]+)/);
  if (!verbMatch) return "unrecognized statement";
  const verb = verbMatch[1].toUpperCase();

  // v2.38.2 (ревью F33): опциональный READ-ONLY режим — см. isReadOnly().
  if (readOnly) {
    if (verb === "SELECT") {
      const tables = extractTableNames(clean);
      if (tables.size > 0) {
        for (const t of tables) {
          if (!ALLOWED_TABLES.has(t)) return `forbidden table: ${t}`;
        }
      }
      return null;
    }
    if (verb === "PRAGMA") {
      return PRAGMA_RE.test(clean) ? null : "read-only mode: forbidden operation: PRAGMA";
    }
    return `read-only mode: forbidden operation: ${verb}`;
  }

  if (verb === "SELECT" || verb === "INSERT" || verb === "UPDATE" || verb === "DELETE") {
    const tables = extractTableNames(clean);
    if (tables.size === 0) {
      // SELECT без FROM (SELECT 1) безвреден; DML без таблицы — битый синтаксис
      return verb === "SELECT" ? null : "no table reference";
    }
    for (const t of tables) {
      if (!ALLOWED_TABLES.has(t)) return `forbidden table: ${t}`;
    }
    return null;
  }
  if (verb === "PRAGMA") {
    return PRAGMA_RE.test(clean) ? null : "forbidden operation: PRAGMA";
  }
  if (verb === "CREATE") {
    if (CREATE_ALERTSTATE_RE.test(clean)) return null;
    if (CREATE_STATSROLLUP_RE.test(clean)) return null;
    if (CREATE_TRIPCALC_RE.test(clean)) return null;
    if (CREATE_EXPORTLOCK_RE.test(clean)) return null;
    // v2.38.2 (F50): CREATE [UNIQUE] INDEX IF NOT EXISTS <idx> ON <allowed-table>
    const idxMatch = clean.match(CREATE_INDEX_RE);
    if (idxMatch && ALLOWED_TABLES.has(idxMatch[3].toLowerCase())) return null;
    return "forbidden operation: CREATE";
  }
  // DROP / ALTER / ATTACH / DETACH / VACUUM / EXPLAIN / BEGIN / COMMIT /
  // ROLLBACK / REPLACE / TRUNCATE / ANALYZE / REINDEX / SAVEPOINT / WITH (CTE)...
  return `forbidden operation: ${verb}`;
}

// ——— v2.38.1 (ревью F1): per-IP rate-limit (память изолейта воркера) ———
// CF-Connecting-IP ставит сам Cloudflare (доверенный). Окно 60 с, слiding.
const rateBuckets = new Map(); // ip → массив timestamp
function rateLimitExceeded(ip, limit, windowMs) {
  const now = Date.now();
  let ts = rateBuckets.get(ip);
  if (!ts) {
    if (rateBuckets.size > RATE_BUCKETS_MAX) {
      // грубая защита от роста карты: выметаем старейшую запись (insertion order)
      const oldest = rateBuckets.keys().next().value;
      if (oldest !== undefined) rateBuckets.delete(oldest);
    }
    ts = [];
    rateBuckets.set(ip, ts);
  }
  const fresh = [];
  for (const t of ts) {
    if (t > now - windowMs) fresh.push(t);
  }
  if (fresh.length >= limit) {
    rateBuckets.set(ip, fresh);
    return true;
  }
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  return false;
}

// ——— v2.38.1 (ревью F1): чтение тела стримом с капом ———
// Стрим прерывается на превышении: chunked-запрос без content-length не может
// уложить память изолейта (раньше request.json() парсил всё подряд).
async function readBodyLimited(request, maxBytes) {
  const reader = request.body && typeof request.body.getReader === "function" ? request.body.getReader() : null;
  if (!reader) return { ok: false, status: 400, error: "empty body" };
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (e) {
        // v3 (CR-C): отмена стрима сорвалась — не критично (клиент всё равно
        // получит 413), но фиксируем в логе для диагностики утечек.
        console.warn(JSON.stringify({ level: "warn", msg: "body reader.cancel failed", error: String((e && e.message) || e) }));
      }
      return { ok: false, status: 413, error: "payload too large", limitBytes: maxBytes };
    }
    chunks.push(value);
  }
  let byteLen = 0;
  for (const c of chunks) byteLen += c.byteLength;
  const merged = new Uint8Array(byteLen);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

// JSON не переносит BigInt — D1 может вернуть BigInt для INTEGER-колонок.
// Все наши значения < 2^53 (timestamp ~1.8e12), конвертация безопасна.
function bigintSafe(value) {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(bigintSafe);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = bigintSafe(v);
    return out;
  }
  return value;
}

// SQLite хранит boolean как 0/1; D1-bind принимает boolean не во всех
// версиях — нормализуем на входе.
function normParam(p) {
  if (typeof p === "boolean") return p ? 1 : 0;
  if (typeof p === "bigint") return Number(p);
  return p;
}

// ——— v2.39.1 (§B2): KV-кэш SELECT (cache-aside) ———
// Контракт = src/lib/edge-gateway.ts (§B2): {key, sql, params, ttlSec} →
// {rows, meta, kv:"hit"|"miss"|"passthrough"}. Ошибки KV НЕ ломают ответ —
// деградация в прямой D1-запрос (приложение считает kv:"miss"/"error").
async function handleKvCache(env, body) {
  const { key, sql, params, ttlSec } = body ?? {};
  if (typeof key !== "string" || !KVCACHE_KEY_RE.test(key)) {
    return json({ error: "invalid key (expected ^[A-Za-z0-9_:.-]{1,128}$)" }, 400);
  }
  if (typeof sql !== "string" || sql.length === 0) return json({ error: "sql required" }, 400);
  if (!Array.isArray(params)) return json({ error: "params must be an array" }, 400);
  if (params.length > KVCACHE_PARAMS_MAX) {
    return json({ error: `too many params (max ${KVCACHE_PARAMS_MAX})` }, 400);
  }
  // Контракт клиента (edge-gateway.ts): ttlSec по умолчанию 30 — поле
  // опционально; не-число/вне диапазона → честная 400 (клиент фолбэчится).
  const ttl = Math.floor(Number(ttlSec ?? 30));
  if (!Number.isFinite(ttl) || ttl < KVCACHE_TTL_MIN_SEC || ttl > KVCACHE_TTL_MAX_SEC) {
    return json({ error: `ttlSec out of range (${KVCACHE_TTL_MIN_SEC}..${KVCACHE_TTL_MAX_SEC})` }, 400);
  }

  // Только SELECT (read-only ветка вайтлиста): в кэш не должно попадать ни
  // DML, ни новые глаголы — даже с валидным секретом вызова.
  const violation = validateStatement(sql, true);
  if (violation) return json({ error: "forbidden", reason: violation }, 403);

  // 1) Lookup. Отсутствие биндинга KV = «passthrough» (обратная
  // совместимость: воркер без KV не меняет контракт приложения).
  if (env.KV && typeof env.KV.get === "function") {
    try {
      const cached = await env.KV.get(key, "text");
      if (cached != null) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed && Array.isArray(parsed.rows)) {
            return json({
              rows: parsed.rows,
              meta: { kv: "hit", rowsRead: 0, durationMs: 0 },
              kv: "hit",
            });
          }
        } catch {
          // битая запись (частичная запись/эволюция формата) — выметаем
          await env.KV.delete(key).catch(() => {});
        }
      }
    } catch {
      // KV сбой (квота/сеть) — не мешаем: идём в D1 напрямую
    }
  }

  // 2) Прямое исполнение (miss-путь) — те же нормализации, что /query.
  let stmt = env.DB.prepare(sql);
  if (params.length > 0) stmt = stmt.bind(...params.map(normParam));
  const res = await stmt.all();
  const rows = bigintSafe(res.results ?? []);

  // 3) Populate — best-effort: ошибка/перегруз не ломает ответ, ключ
  // просто не закэшируется (следующий вызов снова miss).
  if (env.KV && typeof env.KV.put === "function") {
    try {
      const text = JSON.stringify({ rows });
      if (text.length <= KVCACHE_VALUE_MAX_CHARS) {
        await env.KV.put(key, text, {
          expirationTtl: Math.max(ttl, KV_PLATFORM_MIN_TTL_SEC),
        });
      }
    } catch {
      // populate не удался — осознанно тихо
    }
  }

  return json({
    rows,
    meta: {
      rowsRead: res.meta?.rows_read ?? null,
      rowsWritten: res.meta?.rows_written ?? null,
      durationMs: res.meta?.duration ?? null,
    },
    kv: env.KV && typeof env.KV.get === "function" ? "miss" : "passthrough",
  });
}

// ——— v2.40.9 (Pack C §P0-b): сырой KV-store для персистентных артефактов ———
// /kvcache кэширует SELECT-результаты; heavy-segments (N-7) кэширует ГОТОВЫЙ
// JSON-ответ (watermark-ключ), которому не соответствует никакой одиночный
// SELECT. Пара /kvstore/get|put — тот же гейт (секрет + rate-limit + кап
// тела 64 КБ), значение ≤512 КБ, TTL 1..3600 (пол KV 60с). Обратная
// совместимость: нет биндинга KV → get {value:null}, put {ok:false,kv:"disabled"}.
async function handleKvStoreGet(env, body) {
  const { key } = body ?? {};
  if (typeof key !== "string" || !KVCACHE_KEY_RE.test(key)) {
    return json({ error: "invalid key" }, 400);
  }
  if (!env.KV || typeof env.KV.get !== "function") {
    return json({ value: null, kv: "disabled" });
  }
  try {
    const value = await env.KV.get(key, "text");
    return json({ value: value == null ? null : value, kv: value == null ? "miss" : "hit" });
  } catch (err) {
    return json({ value: null, kv: "error", error: String(err?.message ?? err) }, 200);
  }
}

async function handleKvStorePut(env, body) {
  const { key, value, ttlSec } = body ?? {};
  if (typeof key !== "string" || !KVCACHE_KEY_RE.test(key)) {
    return json({ error: "invalid key" }, 400);
  }
  if (typeof value !== "string" || value.length === 0) {
    return json({ error: "value required (string)" }, 400);
  }
  if (value.length > KVCACHE_VALUE_MAX_CHARS) {
    return json({ error: `value too large (max ${KVCACHE_VALUE_MAX_CHARS} chars)`, limitChars: KVCACHE_VALUE_MAX_CHARS }, 413);
  }
  const ttl = Number(ttlSec);
  if (!Number.isFinite(ttl) || ttl < KVCACHE_TTL_MIN_SEC || ttl > KVCACHE_TTL_MAX_SEC) {
    return json({ error: `ttlSec out of range (${KVCACHE_TTL_MIN_SEC}..${KVCACHE_TTL_MAX_SEC})` }, 400);
  }
  if (!env.KV || typeof env.KV.put !== "function") {
    return json({ ok: false, kv: "disabled" });
  }
  try {
    await env.KV.put(key, value, { expirationTtl: Math.max(ttl, KV_PLATFORM_MIN_TTL_SEC) });
    return json({ ok: true, kv: "put" });
  } catch (err) {
    return json({ ok: false, kv: "error", error: String(err?.message ?? err) }, 200);
  }
}

// ——— v2.40.9 (Pack C §P1-a): БЮДЖЕТ-МЕТР ДНЯ (rows_read/rows_written) ———
// Счётчик приложения (d1_rows_read_total, db-d1.ts) умирает с каждым ресайклом
// Render free (2 за 40 минут 20.09) — квота «невидима» большую часть суток.
// Шлюз видит КАЖДЫЙ ответ D1 (meta.rows_read) — суммируем их в изолейте и
// троттл-флашим в KV-ключ дня (quota:day:YYYY-MM-DD UTC):
//   • pending копится в памяти изолейта; флаш — не чаще 60 с (KV-квота free
//     1 тыс. записей/день; flush 1/мин = 1 440 — на пределе, поэтому флаш
//     только при ненулевом pending и по waitUntil);
//   • слияние read-modify-write: параллельные изолейты могут потерять ≤окна
//     флаша — счётчик для наблюдаемости, не для биллинга;
//   • исчерпание (D1_ERROR «exceeded … row read limit») пишется в запись дня
//     как quotaExhaustedAt — приложение читает это в /admin/cron-status
//     (алерт d1_quota_70/90, alerts.ts P1-a) и в честный /health (m-20).
const BUDGET_KV_PREFIX = "quota:day:";
const BUDGET_FLUSH_MIN_MS = 60_000;
const BUDGET_DAILY_READ_LIMIT = 5_000_000; // free tier D1 (для процента в ответе)

const globalForBudget = globalThis;
if (!globalForBudget.__d1GatewayBudget) {
  globalForBudget.__d1GatewayBudget = { day: "", read: 0, written: 0, quotaExhaustedAt: null, lastFlushAt: 0, flushInFlight: false };
}
const budgetState = globalForBudget.__d1GatewayBudget;

function budgetDayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Учёт ответа D1 (после успешного /query или каждого элемента /batch). */
function budgetTrack(rowsRead, rowsWritten) {
  const day = budgetDayKey();
  if (budgetState.day !== day) {
    // полночь UTC: pending прошлого дня уходит флашем до сброса
    if (budgetState.read > 0 || budgetState.written > 0 || budgetState.quotaExhaustedAt) {
      flushBudgetPending({ forceDay: budgetState.day });
    }
    budgetState.day = day;
    budgetState.read = 0;
    budgetState.written = 0;
    budgetState.quotaExhaustedAt = null;
  }
  const read = Number(rowsRead);
  const written = Number(rowsWritten);
  if (Number.isFinite(read) && read > 0) budgetState.read += read;
  if (Number.isFinite(written) && written > 0) budgetState.written += written;
}

/** Отметка исчерпания read-квоты (из catch /query,/batch — текст D1_ERROR). */
function budgetMarkExhausted(errMessage) {
  if (/exceeded D1'?s free tier daily row read limit/i.test(String(errMessage))) {
    if (!budgetState.quotaExhaustedAt) {
      budgetState.quotaExhaustedAt = new Date().toISOString();
      if (budgetState.day === "") budgetState.day = budgetDayKey(); // прайм для snapshot
    }
  }
}

/** Флаш pending в KV (merge). Троттл 60 с; вызовы из waitUntil/scheduled.
 * Payload захвачен СИНХРОННО ДО первого await — гонка с budgetTrack исключена
 * (сброс после await защищён повторной сверкой state.day: полночь в полёте
 * не затирает pending НОВОГО дня; ≤60-секундное окно на самой границе суток
 * может потерять хвост старого — счётчик наблюдаемости, не биллинг). */
async function flushBudgetPending(opts = {}) {
  const state = budgetState;
  if (state.flushInFlight) return;
  const day = opts.forceDay ?? state.day;
  const isCurrent = day === state.day;
  const payload = isCurrent
    ? { read: state.read, written: state.written, quotaExhaustedAt: state.quotaExhaustedAt }
    : (opts.pending ?? { read: 0, written: 0, quotaExhaustedAt: null });
  if (payload.read <= 0 && payload.written <= 0 && !payload.quotaExhaustedAt) return;
  if (isCurrent && Date.now() - state.lastFlushAt < BUDGET_FLUSH_MIN_MS && !opts.force) return;
  const kv = globalEnvKV();
  if (!kv) return; // нет KV — счётчик живёт только в изолейте (snapshot честен)
  state.flushInFlight = true;
  try {
    const key = BUDGET_KV_PREFIX + day;
    let base = { rowsRead: 0, rowsWritten: 0, quotaExhaustedAt: null };
    try {
      const raw = await kv.get(key, "text");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Number.isFinite(Number(parsed?.rowsRead))) base.rowsRead = Number(parsed.rowsRead);
        if (Number.isFinite(Number(parsed?.rowsWritten))) base.rowsWritten = Number(parsed.rowsWritten);
        if (typeof parsed?.quotaExhaustedAt === "string") base.quotaExhaustedAt = parsed.quotaExhaustedAt;
      }
    } catch { /* битая запись = начинаем с нуля */ }
    const record = {
      day,
      rowsRead: base.rowsRead + payload.read,
      rowsWritten: base.rowsWritten + payload.written,
      quotaExhaustedAt: payload.quotaExhaustedAt ?? base.quotaExhaustedAt,
      updatedAt: new Date().toISOString(),
    };
    await kv.put(key, JSON.stringify(record), { expirationTtl: 2 * 24 * 60 * 60 });
    if (isCurrent && state.day === day) {
      state.read = 0;
      state.written = 0;
      state.lastFlushAt = Date.now();
    }
  } catch { /* KV сбой — pending остаётся, следующий флаш донесёт */ }
  finally {
    state.flushInFlight = false;
  }
}

// текущий env.KV для флаша из запланированных путей (fetch/scheduled держат env
// в замыкании, budgetTrack — синхронный; глобальная ссылка обновляется в fetch)
let __envKV = null;
function globalEnvKV() {
  return __envKV && typeof __envKV.get === "function" ? __envKV : null;
}

/** Полный бюджет дня (KV + pending изолейта) — для /admin/cron-status. */
async function budgetSnapshot(env) {
  const day = budgetDayKey();
  let record = { day, rowsRead: 0, rowsWritten: 0, quotaExhaustedAt: null, updatedAt: null };
  try {
    if (env.KV && typeof env.KV.get === "function") {
      const raw = await env.KV.get(BUDGET_KV_PREFIX + day, "text");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Number.isFinite(Number(parsed?.rowsRead))) record.rowsRead = Number(parsed.rowsRead);
        if (Number.isFinite(Number(parsed?.rowsWritten))) record.rowsWritten = Number(parsed.rowsWritten);
        if (typeof parsed?.quotaExhaustedAt === "string") record.quotaExhaustedAt = parsed.quotaExhaustedAt;
        if (typeof parsed?.updatedAt === "string") record.updatedAt = parsed.updatedAt;
      }
    }
  } catch { /* KV недоступен — только pending */ }
  if (budgetState.day === day) {
    record.rowsRead += budgetState.read;
    record.rowsWritten += budgetState.written;
    record.quotaExhaustedAt = record.quotaExhaustedAt ?? budgetState.quotaExhaustedAt;
  }
  record.quota = BUDGET_DAILY_READ_LIMIT;
  return record;
}

// ——— v2.39.1 (§B2): инвалидация кэша по префиксу ———
// list с пагинацией + параллельные delete; счётчик — по факту выполненных
// delete (не по списку: гонки с populate честно сходятся к «лишний» delete).
async function handleKvInvalidate(env, body) {
  const { prefix } = body ?? {};
  if (typeof prefix !== "string" || !KVCACHE_KEY_RE.test(prefix)) {
    return json({ error: "invalid prefix" }, 400);
  }
  if (!env.KV || typeof env.KV.list !== "function") {
    return json({ invalidated: 0, kv: "disabled" });
  }
  let invalidated = 0;
  let cursor;
  try {
    for (let page = 0; page < KVCACHE_INVALIDATE_MAX_PAGES; page++) {
      const list = await env.KV.list({ prefix, cursor });
      const keys = Array.isArray(list?.keys) ? list.keys : [];
      if (keys.length === 0) break;
      const settled = await Promise.allSettled(
        keys.map((k) => env.KV.delete(k.name))
      );
      invalidated += settled.filter((s) => s.status === "fulfilled").length;
      // пагинация: продолжаем, ТОЛЬКО пока страница не последняя и есть курсор
      if (list?.list_complete || !list?.cursor) break;
      cursor = list.cursor;
    }
  } catch {
    // частичный сбой — отдаём честный счётчик того, что успели
  }
  return json({ invalidated });
}

// ——— v2.40.0 (§B5 + §T-DELTA, docs/OPTIMIZATION-PROPOSAL.md): Cron Triggers ———
// Замена cron-сервисов Render (retention 03:00 / alerts */5 / backup 03:30 /
// github-backup ВС 04:00 / finalize-sessions */5) на Cloudflare Cron Triggers
// воркера + новый */1 worker-tick (драйвер инжест-воркера на безынтервальном
// рантайме — CF Workers; попутно держит приложение тёплым). Планировщик
// живёт в воркере (schedules через Workers API / wrangler.toml [triggers]),
// ИСПОЛНИТЕЛИ остаются в приложении: воркер делает POST APP_ORIGIN+path с
// Bearer CRON_SECRET (те же каналы, что признавали cron-сервисы Render —
// authorizeRequest("cron") / authorizeAdminOrCron). Расписания взяты из
// render.yaml 1:1 ( Blueprint-синк не нужен, cron-сервисы не создаются).
// NB: free-план CF — максимум 5 cron-триггеров на аккаунт, поэтому мигратор
// Turso-дельты свёрнут в общий */5-триггер (шаги миграции троттлятся состоянием
// в KV: blocked → только проба чтения; running → один шаг на тик).
// Нормализация: CF присылает controller.cron в канонической форме («* * * * *»
// вместо «*/1 * * * *», «0» вместо «SUN») — сверяем через нормализатор обе
// стороны, чтобы диспетчер не промахнулся по формату строки.
function normalizeCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return String(expr);
  const dowMap = { SUN: "0", MON: "1", TUE: "2", WED: "3", THU: "4", FRI: "5", SAT: "6" };
  const fixed = parts.map((p) => (p === "*/1" ? "*" : p));
  const dow = dowMap[String(fixed[4]).toUpperCase()] ?? fixed[4];
  return [fixed[0], fixed[1], fixed[2], fixed[3], dow].join(" ");
}
// v3 (CR-C F1): СХЛОПНУТО до двух триггеров (PUT /workers/scripts/d1-gateway/
// schedules). Прежние */5 / 30 3 / 0 4 SUN убраны:
//   • finalize-sessions + alerts + turso-migrate (быв. */5) запускаются ИЗ
//     тика — на минутах, где getUTCMinutes() % 5 === 0 (см. scheduled()):
//     раньше */1 и */5 падали в одну минуту :00/:05/:10… и вызывали
//     приложение ДВАЖДЫ; теперь — одна инвокация, джобы последовательно;
//   • backup (30 3) и backup-github (0 4 SUN) — in-worker полный дамп
//     невозможен на free-CPU (1102, OPERATIONS.md §12), бэкап живёт ТОЛЬКО
//     в GitHub Actions (workflow backup.yml, cron 03:30 UTC). KV-ключи
//     cron:last:backup* и пути в CRON_APP_PATHS СОХРАНЕНЫ (наблюдаемость
//     истории в /admin/cron-status; повторное добавление триггера через
//     дашборд БЕЗ отката кода станет no-op — это осознанно).
const CRON_SCHEDULES = {
  "*/1 * * * *": ["tick"],
  "0 3 * * *": ["retention"],
};
const CRON_SCHEDULES_BY_NORM = new Map(
  Object.entries(CRON_SCHEDULES).map(([expr, jobs]) => [normalizeCron(expr), jobs])
);
const CRON_APP_PATHS = {
  tick: "/api/worker/tick",
  "finalize-sessions": "/api/cron/finalize-sessions",
  alerts: "/api/cron/alerts",
  retention: "/api/cron/retention",
  backup: "/api/admin/backup",
  "backup-github": "/api/admin/backup/github",
};
const CRON_ALL_JOBS = [
  ...Object.keys(CRON_APP_PATHS),
  "turso-migrate",
];
const CRON_LAST_PREFIX = "cron:last:";
const CRON_BACKUP_TIMEOUT_MS = 14 * 60_000; // дамп+GitHub-аплоад — до 14 мин (лимит cron-инвокации ~15)
// v2.40.3 (ревью 19-j, C-1): ДОЛГИЕ крон-джобы. backup-github делает полный дамп +
// GitHub-релиз с аплоадом — с тем же бюджетом, что и backup. Раньше получал дефолтные
// 60 с: на реальной БД дамп не успевал даже начаться — AbortError, ok:false, без ретрая.
const LONG_CRON_JOBS = new Set(["backup", "backup-github"]);

// ——— v2.40.5 (квота-M-13 Pack B, аудит Task 22): троттлинг KV-записей ———
// Проблема: шлюз писал в KV ~2600–3000 раз/день при квоте free-плана 1000
// записей/день: cron:last:tick 1440 + cron:last:{finalize,alerts,turso} 864
// + turso-state 288 (пробы «blocked»). С ~10:00 UTC квота записи исчерпана →
// ЗАМИРАЕТ и /kvcache-populate (те же KV-put) → edge-кэш не наполняется →
// каскад: read-пути идут напрямую в D1 и жгут квоту чтений (та самая
// деградация 19.09). Решение: «мусорные» записи (одинаковый успех подряд)
// пишутся редко, информативные (смена ok↔fail, статусы мигратора) — сразу:
//   • cron:last:<job> — минимальный интервал между записями ПРИ НЕИЗМЕННОМ
//     ok-статусе (map ниже); смена статуса всегда пишется мгновенно;
//   • turso-state — только статус «blocked» (счётчик проб) пишется не чаще
//     раза в 15 мин; «running»/переходы статусов — каждую запись (прогресс
//     миграции не теряем).
// Бюджет после: tick ≤288 + прочие ≤173 + turso ≤96 + суточные ~3 ≈ ≤560/день
// — запас ~44% квоты записи остаётся под /kvcache-populate. Читаемость
// cron-status почти не страдает: «последний успешный прогон ≤5 мин назад»
// (tick) / «≤25 мин назад» (5-минутные джобы) — свежее и не нужно.
const CRON_LAST_WRITE_MIN_MS = {
  tick: 4.5 * 60_000, // ~каждый 5-й тик при стабильном ok
  "finalize-sessions": 24 * 60_000, // ~каждый 5-й прогон */5
  alerts: 24 * 60_000,
  "turso-migrate": 24 * 60_000,
  // retention / backup / backup-github — суточные, всегда пишутся (0)
};
const TURSO_STATE_BLOCKED_SAVE_MIN_MS = 15 * 60_000;

/** cron:last:<job> с троттлингом: при неизменном ok-статусе и свежей записи
 *  (интервал из CRON_LAST_WRITE_MIN_MS) — KV.put пропускается (одна лишняя
 *  KV.get на промах-проверку — квота чтений KV 100k/день, неузаметна).
 *  Смена ok↔fail или истечение интервала — запись как раньше. */
async function putCronLastThrottled(env, job, record) {
  if (!env.KV || typeof env.KV.put !== "function") return;
  try {
    const intervalMs = CRON_LAST_WRITE_MIN_MS[job] ?? 0;
    if (intervalMs > 0) {
      const raw = await env.KV.get(TURSO_CRON_LAST_KEY(job)).catch(() => null);
      if (raw) {
        try {
          const prev = JSON.parse(raw);
          const prevAt = Date.parse(prev && prev.at);
          if (
            Number.isFinite(prevAt) &&
            prev.ok === record.ok &&
            Date.now() - prevAt < intervalMs
          ) {
            return; // тот же исход недавно — не тратим квоту записи
          }
        } catch (e) {
          // v3 (CR-C): битая/чужая запись cron:last — троттл-промах, пишем как
          // новую (ниже); в лог, чтобы видеть деградацию формата KV-записей.
          console.warn(JSON.stringify({ level: "warn", msg: "cron:last parse failed (throttle miss)", job, error: String((e && e.message) || e) }));
        }
      }
    }
    await env.KV.put(TURSO_CRON_LAST_KEY(job), JSON.stringify(record));
  } catch {
    // KV сбой — не мешает cron-прогону (как прежде)
  }
}

async function callAppCron(env, path, timeoutMs = 60_000) {
  if (!env.APP_ORIGIN) return { ok: false, error: "APP_ORIGIN not configured" };
  if (!env.CRON_SECRET) return { ok: false, error: "CRON_SECRET not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(env.APP_ORIGIN + path, {
      method: "POST",
      headers: { authorization: "Bearer " + env.CRON_SECRET, "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    const bodyText = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: bodyText.slice(0, 2000) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ——— v2.40.0 (§T-DELTA): самовосстанавливающийся мигратор Turso-дельты в D1 ———
// ИНЦИДЕНТ 17-18.09: после деплоя v2.38.2 (21:06 17.09) env-пара D1_GATEWAY_*
// не была выставлена в Render → приложение ушло в законный фолбэк v2.37.0 на
// Turso; записи с 17.09 21:06 → 18.09 08:10 ушли в Turso (чтения Turso
// блокированы квотой free — дельту нельзя вытащить руками). Инцидент закрыт
// 18.09 08:10 (env-пара выставлена через Render API, prod на D1), дельта
// осталась заморожена в Turso ДО сброса квоты чтений.
// Этот конвейер переносит дельту САМ: Cron Trigger каждые 30 мин (и ручной
// POST /admin/turso-migrate {steps:N}) делает ограниченные шаги (лимит строк
// на шаг — под CPU-бюджет инвокации): проба чтения Turso (BLOCKED → статус
// "blocked", ретрай через 30 мин) → выгрузка пачки дельта-строк →
// идемпотентная запись в D1 → прогресс в KV (turso_delta:v1).
// Идемпотентность: GpsPoint/IngestMessage/AuditLog/Route — INSERT OR IGNORE
// по PK; Session/Trip/TrafficJob/User/Setting — сравнение updatedAt, пишется
// ТОЛЬКО более свежая Turso-строка (защита от отката D1-изменений, сделанных
// ПОСЛЕ возвращения прода на D1). Маркер окна = 21:00 17.09 (запас 6 мин до
// реального разъезда); строка «на стыке» идемпотентно дедуплицируется.
const TURSO_STATE_KEY = "turso_delta:v1";
const TURSO_SPLIT_ISO = "2026-09-17T21:00:00.000Z";
const TURSO_SPLIT_MS = Date.parse(TURSO_SPLIT_ISO);
const TURSO_GPS_PAGE = 1500; // строк на шаг GpsPoint (1500 × ~10 колонок ≈ 15k параметров чанками)
const TURSO_SMALL_LIMIT = 5000; // верхний порог «малой» таблицы (один шаг целиком)
const TURSO_PHASES = [
  { table: "User", mode: "compare", where: null },
  { table: "Setting", mode: "compare", where: null },
  { table: "Session", mode: "compare", where: "updatedAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "Trip", mode: "compare", where: "updatedAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "TrafficJob", mode: "compare", where: "updatedAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "Route", mode: "ignore", where: "createdAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "IngestMessage", mode: "ignore", where: "firstSeenAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "AuditLog", mode: "ignore", where: "createdAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "GpsPoint", mode: "ignore-keyset", where: null },
];

function newTursoState() {
  return {
    status: "pending",
    phase: 0,
    lastTs: TURSO_SPLIT_MS,
    lastId: "",
    stats: {},
    blockedCount: 0,
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    lastAttemptAt: null,
    lastError: null,
  };
}

async function loadTursoState(env) {
  if (!env.KV) return { ...newTursoState(), status: "no-kv" };
  try {
    const raw = await env.KV.get(TURSO_STATE_KEY);
    if (!raw) return newTursoState();
    const s = JSON.parse(raw);
    if (s && typeof s === "object" && typeof s.phase === "number" && s.stats && typeof s.stats === "object") {
      return { ...newTursoState(), ...s };
    }
  } catch {
    // битая запись KV — начинаем сначала (идемпотентность миграции это позволяет)
  }
  return newTursoState();
}

async function saveTursoState(env, state) {
  if (!env.KV) return;
  try {
    // v2.40.5 (M-13): статус «blocked» (Turso-квота, пробы каждые 5 мин) —
    // persist не чаще раза в 15 мин: между ними меняется только blockedCount.
    // Прочие статусы/переходы (running/done/error/pending) — каждая запись:
    // прогресс миграции дороже KV-квоты.
    if (
      state &&
      state.status === "blocked" &&
      Date.now() - lastTursoBlockedSaveAt < TURSO_STATE_BLOCKED_SAVE_MIN_MS
    ) {
      return;
    }
    await env.KV.put(TURSO_STATE_KEY, JSON.stringify(state));
    lastTursoBlockedSaveAt = Date.now();
  } catch {
    // KV недоступен — состояние живёт только в памяти текущей инвокации
  }
}
let lastTursoBlockedSaveAt = 0; // globalThis-область изолейта; рестарт → одна лишняя запись

// Turso libSQL-over-HTTP (v2/pipeline, чистый fetch — без клиентов):
// толерантный парсер значений — v2-формат {type,value} и сырые JSON-скаляры.
function tursoValueToJs(v) {
  if (v == null) return null;
  if (typeof v !== "object") return v;
  const t = String(v.type || "");
  const val = v.value;
  if (t === "integer" || t === "float") return val == null ? null : Number(val);
  if (t === "text") return val == null ? null : String(val);
  if (t === "blob") {
    if (typeof val !== "string" || val === "") return null;
    try {
      const bin = atob(val);
      return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    } catch {
      return null;
    }
  }
  return val ?? null;
}

async function tursoExecute(env, sql, args = []) {
  const url = env.TURSO_URL || "";
  const token = env.TURSO_AUTH_TOKEN || "";
  if (!url || !token) return { ok: false, code: "CONFIG", error: "TURSO_URL/TURSO_AUTH_TOKEN not configured" };
  try {
    const res = await fetch(String(url).replace(/\/+$/, "") + "/v2/pipeline", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql, args } }] }),
    });
    if (!res.ok) return { ok: false, code: "HTTP_" + res.status, error: "turso http " + res.status };
    const data = await res.json();
    const first = data && data.results && data.results[0];
    if (!first) return { ok: false, code: "EMPTY", error: "turso: empty pipeline response" };
    if (first.type === "error") {
      const e = first.error || {};
      return { ok: false, code: String(e.code || "ERROR"), error: String(e.message || "turso error") };
    }
    const result = (first.response && first.response.result) || {};
    const cols = (result.cols || []).map((c) => c.name);
    const rows = (result.rows || []).map((raw) => {
      const row = {};
      cols.forEach((c, i) => {
        row[c] = tursoValueToJs(raw[i]);
      });
      return row;
    });
    return { ok: true, rows, cols };
  } catch (err) {
    return { ok: false, code: "NETWORK", error: String((err && err.message) || err) };
  }
}

// D1-значения для bind: BigInt→Number (эпоха-мс < 2^53, см. backup.ts),
// Uint8Array→ArrayBuffer, прочее как есть.
function d1BindValue(v) {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Uint8Array) return v.buffer && v.byteLength ? v : null;
  return String(v);
}

// Идентификаторы колонок приходят из СХЕМЫ Turso (SELECT *) — доверенные,
// но валидируем паттерном перед интерполяцией в SQL-текст (defense-in-depth).
const SAFE_IDENT_RE = /^[A-Za-z0-9_]+$/;

// Многострочный INSERT (OR IGNORE|OR REPLACE) чанками ≤90 параметров на
// стейтмент (лимит D1 — 100; запас — как в db.ts/multiRowInsertChunk).
function d1InsertChunks(table, rows, mode) {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]).filter((c) => SAFE_IDENT_RE.test(c));
  if (!cols.length) return [];
  const rowsPerStmt = Math.max(1, Math.floor(90 / cols.length));
  const action = mode === "replace" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
  const colList = cols.map((c) => '"' + c + '"').join(",");
  const out = [];
  for (let i = 0; i < rows.length; i += rowsPerStmt) {
    const slice = rows.slice(i, i + rowsPerStmt);
    const placeholders = slice.map(() => "(" + cols.map(() => "?").join(",") + ")").join(",");
    const params = [];
    for (const r of slice) {
      for (const c of cols) params.push(d1BindValue(r[c]));
    }
    out.push({ sql: action + ' INTO "' + table + '" (' + colList + ") VALUES " + placeholders, params });
  }
  return out;
}

async function d1RunInserts(env, table, rows, mode) {
  const chunks = d1InsertChunks(table, rows, mode);
  let written = 0;
  for (let i = 0; i < chunks.length; i += 100) {
    const batch = chunks.slice(i, i + 100).map((s) => {
      const st = env.DB.prepare(s.sql);
      return s.params.length ? st.bind(...s.params) : st;
    });
    const results = await env.DB.batch(batch);
    for (const r of results) written += Number((r.meta && r.meta.changes) || 0);
  }
  return written;
}

function bumpTableStat(state, table, key, n) {
  if (!state.stats[table]) state.stats[table] = { scanned: 0, written: 0 };
  state.stats[table][key] = (state.stats[table][key] || 0) + n;
}

// Фаза «compare»: таблицы с updatedAt (User/Setting/Session/Trip/TrafficJob).
// Из Turso — строки дельта-окна (или все), из D1 — текущие updatedAt тех же id;
// переносим ТОЛЬКО строки, которых в D1 нет ИЛИ где Turso-строка свежее.
async function migrateCompareTable(env, phase, state) {
  const sql = phase.where
    ? 'SELECT * FROM "' + phase.table + '" WHERE ' + phase.where
    : 'SELECT * FROM "' + phase.table + '"';
  const t = await tursoExecute(env, sql, phase.args || []);
  if (!t.ok) return t;
  const rows = t.rows.slice(0, TURSO_SMALL_LIMIT);
  const idCol = phase.table === "Setting" ? "key" : "id";
  const d1map = new Map();
  for (let i = 0; i < rows.length; i += 400) {
    const slice = rows.slice(i, i + 400).map((r) => String(r[idCol]));
    if (!slice.length) continue;
    const st = env.DB.prepare(
      'SELECT "' + idCol + '" AS k, "updatedAt" AS u FROM "' + phase.table + '" WHERE "' + idCol + '" IN (' + slice.map(() => "?").join(",") + ")"
    ).bind(...slice);
    const res = await st.all();
    for (const r of res.results || []) d1map.set(String(r.k), r.u == null ? null : String(r.u));
  }
  const fresh = rows.filter((r) => {
    const id = String(r[idCol]);
    if (!d1map.has(id)) return true;
    const d1u = d1map.get(id) || "";
    const tu = r.updatedAt == null ? "" : String(r.updatedAt);
    return tu > d1u; // Turso свежее → перенос; D1 уже обновлён после разъезда → пропускаем
  });
  const written = await d1RunInserts(env, phase.table, fresh, "replace");
  bumpTableStat(state, phase.table, "scanned", rows.length);
  bumpTableStat(state, phase.table, "written", written);
  return { ok: true, phaseDone: true, scanned: rows.length, written };
}

// Фаза «ignore»: immutable-таблицы по PK (Route/IngestMessage/AuditLog).
async function migrateIgnoreTable(env, phase, state) {
  const t = await tursoExecute(env, 'SELECT * FROM "' + phase.table + '" WHERE ' + phase.where, phase.args || []);
  if (!t.ok) return t;
  const rows = t.rows.slice(0, TURSO_SMALL_LIMIT);
  const written = await d1RunInserts(env, phase.table, rows, "ignore");
  bumpTableStat(state, phase.table, "scanned", rows.length);
  bumpTableStat(state, phase.table, "written", written);
  return { ok: true, phaseDone: true, scanned: rows.length, written };
}

// Фаза «ignore-keyset»: GpsPoint — страницы по (timestamp, id) от маркера.
async function migrateGpsPointsStep(env, state) {
  const lastTs = typeof state.lastTs === "number" && Number.isFinite(state.lastTs) ? state.lastTs : TURSO_SPLIT_MS;
  const lastId = typeof state.lastId === "string" ? state.lastId : "";
  const t = await tursoExecute(
    env,
    "SELECT * FROM GpsPoint WHERE timestamp > ? OR (timestamp = ? AND id > ?) ORDER BY timestamp, id LIMIT " + TURSO_GPS_PAGE,
    [lastTs, lastTs, lastId]
  );
  if (!t.ok) return t;
  const rows = t.rows;
  const written = rows.length ? await d1RunInserts(env, "GpsPoint", rows, "ignore") : 0;
  bumpTableStat(state, "GpsPoint", "scanned", rows.length);
  bumpTableStat(state, "GpsPoint", "written", written);
  if (rows.length < TURSO_GPS_PAGE) {
    return { ok: true, phaseDone: true, scanned: rows.length, written };
  }
  const last = rows[rows.length - 1];
  state.lastTs = Number(last.timestamp) || lastTs;
  state.lastId = String(last.id || "");
  return { ok: true, phaseDone: false, scanned: rows.length, written };
}

// Один вызов = до maxSteps фазовых шагов (каждый ограничен по строкам —
// CPU-бюджет инвокации воркера). Проба чтения Turso ДО работы: BLOCKED →
// статус "blocked" (cron повторит через 30 мин), состояние не портится.
async function runTursoMigrationStep(env, maxSteps = 1) {
  const state = await loadTursoState(env);
  if (state.status === "done") return { state, alreadyDone: true };
  state.attempts = (state.attempts || 0) + 1;
  state.lastAttemptAt = new Date().toISOString();
  const probe = await tursoExecute(env, "SELECT 1 AS ok");
  if (!probe.ok) {
    if (probe.code === "BLOCKED") {
      state.status = "blocked";
      state.blockedCount = (state.blockedCount || 0) + 1;
      state.lastError = "turso read quota still blocked (probe)";
    } else {
      state.status = "error";
      state.lastError = probe.error;
    }
    await saveTursoState(env, state);
    return { state, probe: probe.code };
  }
  if (!state.startedAt) state.startedAt = new Date().toISOString();
  state.status = "running";
  state.lastError = null;
  let steps = 0;
  let last = null;
  while (steps < maxSteps && state.phase < TURSO_PHASES.length) {
    const phase = TURSO_PHASES[state.phase];
    if (phase.mode === "ignore-keyset") last = await migrateGpsPointsStep(env, state);
    else if (phase.mode === "compare") last = await migrateCompareTable(env, phase, state);
    else last = await migrateIgnoreTable(env, phase, state);
    if (!last.ok) {
      state.status = "error";
      state.lastError = last.error || "unknown migration step error";
      break;
    }
    steps++;
    if (last.phaseDone) state.phase++;
  }
  if (state.phase >= TURSO_PHASES.length && state.status !== "error") {
    state.status = "done";
    state.finishedAt = new Date().toISOString();
  }
  await saveTursoState(env, state);
  return { state, steps, last };
}

async function readCronStatus(env) {
  const cron = {};
  for (const job of CRON_ALL_JOBS) {
    const raw = env.KV ? await env.KV.get(TURSO_CRON_LAST_KEY(job)) : null;
    try {
      cron[job] = raw ? JSON.parse(raw) : null;
    } catch {
      cron[job] = null;
    }
  }
  return cron;
}

// cron:last:<job> — KV-запись последнего прогона (наблюдаемость без дашборда CF)
function TURSO_CRON_LAST_KEY(job) {
  return CRON_LAST_PREFIX + job;
}

// ——— v2.42.3-FM (CR-C v3): FM-движок замороженных суточных метрик ———
// Порт из прод-бандла d1-gateway (раунд frozen-metrics-fix, деплой
// 2026-09-30 ~08:05 UTC; до v3 существовал ТОЛЬКО в прод-бандле — см.
// worklog Task frozen-metrics-fix/verify и docs/OPERATIONS.md §13).
// Архитектура «суточные записи + замороженная история»:
//   1) backfill-once всей истории (KV-маркер fm:backfill:v1, идемпотентно,
//      чистка мусорных строк StatsRollup NOT IN живым составам);
//   2) суточная строка «сегодня» пересчитывается КАЖДУЮ МИНУТУ из дневного
//      окна сессий (±18 ч от границ суток — запас TZ Europe/Saratov);
//   3) заморозка при смене суток (KV fm:frozenThru): прошедший день
//      пересчитывается один раз и навсегда;
//   4) часовой refresh последних 7 дней (самолечение дрейфа rollup);
//   5) раз в 5 мин: рекон stuck BackupJob (>2 ч running → failed),
//      fmAdoptOrphans (v3 F2), fmMergeUndercut (v3 F3), прогрев tsw —
//      «старые» поездки со statsComputedAt IS NULL пересчитываются САМИМ
//      ПРИЛОЖЕНИЕМ (GET /api/trips/batch?ids= с Bearer User.apiKey из БД —
//      методология приложения = 100% согласованность, ключ не логируется).
// Перехватчики fmInterceptQuery в /query нейтрализуют CPU-пожиратели
// приложения (heal 1970-01-01, fallback-скан GpsPoint) — KPI всегда из rollup.
const FM_ENABLED = true;

/** Следующий rollup-день (UTC-ключ YYYY-MM-DD + 1 сутки). */
function fmNextDayKey(key) {
  return new Date(Date.parse(key + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
}

/** Парсер Session.statsCache (копия методологии приложения): дистанция/
 *  длительность/эко из кэша финальной записи. Битый/oversized кэш → нули. */
function fmParseStatsCache(s) {
  const t = { distanceM: 0, durationSec: 0, ecoSum: 0, ecoCount: 0 };
  if (typeof s != "string" || s.length === 0 || s === "__TELEMAT_CACHE_OVERSIZED__") return t;
  try {
    const n = JSON.parse(s);
    if (n?.kind !== "full" || !n.payload) return t;
    const a = Number(n.payload.distance);
    if (Number.isFinite(a) && a > 0) t.distanceM += a;
    const d = Number(n.payload.duration);
    if (Number.isFinite(d) && d > 0) t.durationSec += d;
    const e = n.payload?.methodology?.ecoScore?.value;
    if (e != null && Number.isFinite(Number(e))) {
      t.ecoSum += Number(e);
      t.ecoCount += 1;
    }
  } catch {
    // битый JSON кэша — вклад нулевой (как в приложении)
  }
  return t;
}

/** UPSERT-стейтменты StatsRollup (ON CONFLICT day|userId DO UPDATE). */
function fmRollupUpserts(rows, nowIso) {
  return rows.map((r) => ({
    sql: `INSERT INTO StatsRollup (day, userId, sessions, points, distanceM, durationSec, ecoSum, ecoCount, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(day, userId) DO UPDATE SET
  sessions = excluded.sessions,
  points = excluded.points,
  distanceM = excluded.distanceM,
  durationSec = excluded.durationSec,
  ecoSum = excluded.ecoSum,
  ecoCount = excluded.ecoCount,
  updatedAt = excluded.updatedAt`,
    args: [r.day, r.userId, r.sessions, r.points, Math.round(r.distanceM), Math.round(r.durationSec), Math.round(1000 * r.ecoSum) / 1000, r.ecoCount, nowIso],
  }));
}

/** Живые сессии окна [fromMs, toMs) — индекс Session_startTime_idx. */
async function fmSessionsInRange(env, fromMs, toMs) {
  const res = await env.DB.prepare(
    "SELECT startTime, userId, pointCount, statsCache FROM Session WHERE deletedAt IS NULL AND startTime >= ? AND startTime < ?"
  ).bind(new Date(fromMs).toISOString(), new Date(toMs).toISOString()).all();
  return res.results ?? [];
}

/** Агрегация сессий по rollup-дням (день — в TZ оператора, rollupDayKey из
 *  ingest-port.js = тот же расчёт, что у приложения). */
function fmComputeDays(rows, dayFrom, dayTo, zone) {
  const agg = new Map();
  for (const s of rows) {
    const ts = Date.parse(String(s.startTime));
    if (!Number.isFinite(ts)) continue;
    const day = rollupDayKey(ts, zone);
    if (day < dayFrom || day > dayTo) continue;
    const uid = s.userId == null ? "" : String(s.userId);
    const k = day + "|" + uid;
    let d = agg.get(k);
    if (!d) {
      d = { day, userId: uid, sessions: 0, points: 0, distanceM: 0, durationSec: 0, ecoSum: 0, ecoCount: 0 };
      agg.set(k, d);
    }
    d.sessions += 1;
    d.points += Number(s.pointCount ?? 0);
    const sc = fmParseStatsCache(s.statsCache);
    d.distanceM += sc.distanceM;
    d.durationSec += sc.durationSec;
    d.ecoSum += sc.ecoSum;
    d.ecoCount += sc.ecoCount;
  }
  return [...agg.values()];
}

/** Запись дневных строк чанками ≤100 стейтментов (D1-батч). */
async function fmWriteDayRows(env, rows) {
  if (rows.length === 0) return 0;
  const nowIso = new Date().toISOString();
  const stmts = fmRollupUpserts(rows, nowIso);
  for (let i = 0; i < stmts.length; i += 100) {
    const chunk = stmts.slice(i, i + 100).map((s) => env.DB.prepare(s.sql).bind(...s.args));
    await env.DB.batch(chunk);
  }
  return rows.length;
}

// ——— v3.6 (CR-G A1-durable): day-audit замороженных дней ———

/** Пересчёт ОДНОГО rollup-дня из живых сессий (методология fmComputeDays)
 *  + прунинг строк userId, исчезнувших из состава дня (все сессии юзера
 *  удалены → его строка дня не остаётся призраком). Возвращает кол-во строк. */
async function fmRecomputeDay(env, zone, day) {
  const fromMs = Date.parse(day + "T00:00:00Z") - 64800000;
  const toMs = Date.parse(fmNextDayKey(day) + "T00:00:00Z") + 64800000;
  const rows = fmComputeDays(await fmSessionsInRange(env, fromMs, toMs), day, day, zone);
  await fmWriteDayRows(env, rows);
  if (rows.length > 0) {
    const keep = rows.map((r) => r.userId);
    const ph = keep.map(() => "?").join(", ");
    await env.DB.prepare(`DELETE FROM StatsRollup WHERE day = ? AND userId NOT IN (${ph})`).bind(day, ...keep).run();
  } else {
    await env.DB.prepare("DELETE FROM StatsRollup WHERE day = ?").bind(day).run();
  }
  return rows.length;
}

/** Day-audit: живые суточные счётчики против StatsRollup; грязные дни —
 *  на пересчёт. Дёшево: 2 запроса (~сессии + ~25 Rollup-строк), без GpsPoint
 *  и без JSON-парсинга. Группировка — В JS тем же rollupDayKey(ts, zone),
 *  что fmComputeDays (SQL substr дал бы UTC-день ≠ локальный день rollup —
 *  ложные несовпадения в вечерних сессиях). МАСШТАБ: выборка всех живых
 *  сессий (~сотни строк сегодня) растёт линейно с историей — при десятках
 *  тысяч записей перевести на инкрементальные окна (day-audit уже имеет
 *  флаг-триггер для этого).
 *  ВНИМАНИЕ: дистанции/длительности замороженных дней НЕ сверяются — это
 *  архитектура заморозки (история вычислена один раз); reconcilится только
 *  состав и счётчики (сессии/точки), которые видит KPI. */
async function fmDayAudit(env, zone, todayKey) {
  const live = await env.DB.prepare(
    "SELECT startTime, userId, pointCount FROM Session WHERE deletedAt IS NULL"
  ).all();
  const liveMap = new Map(); // "day|uid" → {day, c, p}
  for (const s of live.results ?? []) {
    const ts = Date.parse(String(s.startTime));
    if (!Number.isFinite(ts)) continue;
    const day = rollupDayKey(ts, zone);
    const uid = s.userId == null ? "" : String(s.userId);
    const k = day + "|" + uid;
    let d = liveMap.get(k);
    if (!d) {
      d = { day, c: 0, p: 0 };
      liveMap.set(k, d);
    }
    d.c += 1;
    d.p += Number(s.pointCount ?? 0);
  }
  const roll = await env.DB.prepare(
    "SELECT day, COALESCE(userId, '') AS uid, sessions AS c, points AS p FROM StatsRollup"
  ).all();
  const rollMap = new Map(); // "day|uid" → {day, c, p}
  for (const r of roll.results ?? []) {
    if (typeof r.day !== "string") continue;
    rollMap.set(r.day + "|" + String(r.uid), { day: r.day, c: Number(r.c), p: Number(r.p) });
  }
  const dirtyDays = new Set();
  for (const [k, l] of liveMap) {
    if (l.day >= todayKey) continue; // «сегодня» живёт в минутном пересчёте (шаг 2)
    const rr = rollMap.get(k);
    if (!rr || rr.c !== l.c || rr.p !== l.p) dirtyDays.add(l.day);
  }
  for (const [k, rr] of rollMap) {
    if (rr.day >= todayKey) continue;
    if (!liveMap.has(k)) dirtyDays.add(rr.day); // исчезнувший состав/юзер/зомби-строка
  }
  let rows = 0;
  for (const day of dirtyDays) {
    rows += await fmRecomputeDay(env, zone, day);
  }
  if (dirtyDays.size > 0) {
    console.log(JSON.stringify({ level: "info", msg: "fm day-audit: dirty days reconciled", days: [...dirtyDays], rows }));
  }
  return { days: liveMap.size, dirty: dirtyDays.size, rows };
}

/** SQL-паттерн мутации СОСТАВА Session (soft-delete/restore/hard-delete) —
 *  триггер флага fm:dirtyScan. deletedAt ищется ТОЛЬКО в SET-ветке (WHERE-
 *  упоминания — например tripId-обновки сегментации — не триггерят). INSERT
 *  НЕ триггерит: ингест создаёт только сегодняшние сессии (день живёт в
 *  минутном пересчёте), а редкий импорт в старый день ловит гарантийный
 *  10-минутный аудит. */
function fmSessionMutationSql(sql) {
  if (typeof sql !== "string") return false;
  const s = sql.replace(/\s+/g, " ").trim();
  if (/^UPDATE Session SET /i.test(s)) {
    const setPart = s.split(/\bWHERE\b/i)[0];
    return /(^|[\s,(])deletedAt([\s=,]|$)/i.test(setPart);
  }
  return /^DELETE FROM Session\b/i.test(s);
}

/** Постановка флага грязного day-audit (KV, TTL 2 ч — флаг не гниёт). */
async function fmMarkDirtyScan(env) {
  try {
    if (env.KV) await env.KV.put("fm:dirtyScan", new Date().toISOString(), { expirationTtl: 7200 });
  } catch (e) {
    console.warn(JSON.stringify({ level: "warn", msg: "fm dirtyScan flag put failed", error: String((e && e.message) || e) }));
  }
}

/** Сравнение семвер-строк приложения («2.43.1» ≥ «2.44.0»?) — гейт ресинка. */
function fmAppVersionAtLeast(ver, min) {
  const a = String(ver).split(".").map((x) => parseInt(x, 10) || 0);
  const b = String(min).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** Разовый бэкфилл всей истории + чистка мусорных StatsRollup-строк.
 *  KV-маркер fm:backfill:v1 — идемпотентность (повтор = no-op). */
async function fmBackfillOnce(env, zone, yesterdayKey) {
  const kv = env.KV;
  if (!kv) return;
  const marker = await kv.get("fm:backfill:v1").catch(() => null);
  if (marker) return;
  const res = await env.DB.prepare("SELECT startTime, userId, pointCount, statsCache FROM Session WHERE deletedAt IS NULL").all();
  const rows = fmComputeDays(res.results ?? [], "0000-00-00", "9999-12-31", zone);
  const written = await fmWriteDayRows(env, rows);
  const keep = rows.map((r) => r.day + "|" + r.userId);
  if (keep.length > 0) {
    const ph = keep.map(() => "?").join(", ");
    await env.DB.prepare(`DELETE FROM StatsRollup WHERE (day || '|' || userId) NOT IN (${ph})`).bind(...keep).run();
  } else {
    await env.DB.prepare("DELETE FROM StatsRollup").run();
  }
  await kv.put("fm:backfill:v1", JSON.stringify({ at: new Date().toISOString(), days: rows.length, written }));
  await kv.put("fm:frozenThru", yesterdayKey);
  console.log(JSON.stringify({ level: "info", msg: "fm backfill-once complete (history frozen)", days: rows.length, written, frozenThru: yesterdayKey }));
}

// ——— v3 (CR-C F2): fmAdoptOrphans — усыновление сессий-сирот ———
// Проблема (CR-B D1.2): устройство phone шлёт через /ingest-порт ГОТОВЫЕ
// (born-completed) сессии — finalize-крон приложения смотрит только
// status='recording' и их не видит → сессии висят tripId IS NULL (78 шт на
// 2026-09-30, из них 8 «настоящих» поездок на 10–1523 точек — их метрики не
// видны в аналитике вовсе). Движок раз в 5 минут подбирает ≤3 сирот с
// pointCount ≥ 3 (≤36/ч — фонтан 1–2-точечных парковочных сердцебиений
// НЕ трогаем: канон «парковка между поездками не принадлежит никому»):
//   • attach: живая поездка ТОГО ЖЕ устройства с пересечением по времени —
//     session.startTime ≤ Trip.spanEnd И session.endTime ≥ Trip.spanStart
//     (обе стороны через datetime() — в D1 даты лежат ISO-строками, «сырое»
//     лексикографическое сравнение смешанных форматов ломается); из кандидатов
//     берётся максимальный по перекрытию; spanStart/spanEnd расширяются
//     min/max (НИКОГДА не сжимаются), sessionIds = объединение JSON-массивов,
//     sessionCount = |объединение|;
//   • create: подходящей поездки нет → INSERT новой (образец — INSERT
//     recomputeTripsForDevice, src/lib/trip-grouping.ts: колонки сверены с
//     prisma/schema.prisma; startLat/Lon,endLat/Lon — первый/последний фикс
//     сессии по индексу (sessionId, timestamp); pointCountActual =
//     pointCount сессии; status='completed'; statsComputedAt=NULL);
//   • TrafficJob: ensure-INSERT — ТОЧНАЯ копия приложения (trip-grouping.ts:481 /
//     closeStaleTrips:635: INSERT … WHERE NOT EXISTS pending/running —
//     идемпотентен) + trafficJobId = COALESCE(последний джоб, прежний);
//   • метрики обнуляются (список инвалидации — как у приложения в
//     trip-grouping.ts «compositionChanged»: distanceM/movingTime/…/
//     statsComputedAt = NULL) → tsw-прогрев пересчитает их сам через
//     GET /api/trips/batch?ids= (методология приложения).
// Идемпотентно: после UPDATE Session.tripId сирота выпадает из выборки;
// каждый шаг — только чтение + атомарный D1-batch (UPDATE/INSERT).
async function fmAdoptOrphans(env, now, out) {
  const orphans = await env.DB.prepare(
    `SELECT id, deviceId, userId, startTime, endTime, pointCount
       FROM Session
      WHERE tripId IS NULL AND status = 'completed' AND deletedAt IS NULL
        AND pointCount >= 3
      ORDER BY startTime ASC LIMIT 3`
  ).all();
  for (const s of orphans.results ?? []) {
    const sid = String(s.id);
    const startMs = Date.parse(String(s.startTime));
    const endMs = s.endTime == null ? startMs : Date.parse(String(s.endTime));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    // поездка-кандидат: пересечение по времени (datetime() на ОБЕИХ сторонах)
    const cands = await env.DB.prepare(
      `SELECT id, sessionIds, sessionCount, spanStart, spanEnd, startTime, endTime, userId
         FROM Trip
        WHERE deviceId = ? AND deletedAt IS NULL
          AND datetime(spanEnd) >= datetime(?)
          AND datetime(spanStart) <= datetime(?)
        ORDER BY datetime(spanStart) ASC LIMIT 5`
    ).bind(String(s.deviceId), startIso, endIso).all();
    let best = null;
    let bestOverlap = -Infinity;
    for (const t of cands.results ?? []) {
      const tStart = Date.parse(String(t.spanStart));
      const tEnd = t.spanEnd == null ? null : Date.parse(String(t.spanEnd));
      if (!Number.isFinite(tStart)) continue;
      const lo = Math.max(tStart, startMs);
      const hi = tEnd == null ? endMs : Math.min(tEnd, endMs);
      const overlap = hi - lo;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = t;
      }
    }
    const nowIso = new Date(now).toISOString();
    const userId = s.userId == null ? null : String(s.userId);
    if (best) {
      // — attach: присоединяем сироту к существующей поездке —
      const tid = String(best.id);
      let ids;
      try { ids = JSON.parse(String(best.sessionIds ?? "[]")); } catch { ids = []; }
      if (!Array.isArray(ids)) ids = [];
      const set = new Set(ids.map(String));
      set.add(sid);
      const arr = [...set];
      const tStartMs = Date.parse(String(best.spanStart));
      const tEndMs = best.spanEnd == null ? null : Date.parse(String(best.spanEnd));
      const newStartIso = new Date(Math.min(Number.isFinite(tStartMs) ? tStartMs : startMs, startMs)).toISOString();
      const newEndIso = new Date(Math.max(tEndMs != null && Number.isFinite(tEndMs) ? tEndMs : endMs, endMs)).toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE Trip SET sessionIds = ?, sessionCount = ?, spanStart = ?, spanEnd = ?,
                  statsComputedAt = NULL, activeDurationSec = NULL, movingTimeSec = NULL,
                  idleTimeSec = NULL, gapTimeSec = NULL, internalStopTimeSec = NULL,
                  distanceM = NULL, pointCountActual = NULL, maxSpeedMs = NULL, ecoScore = NULL,
                  planDistanceM = NULL, planDurationSec = NULL, planComparable = NULL,
                  planCoverage = NULL, routingLegCount = NULL, updatedAt = ?
            WHERE id = ?`
        ).bind(JSON.stringify(arr), arr.length, newStartIso, newEndIso, nowIso, tid),
        env.DB.prepare(`UPDATE Session SET tripId = ?, updatedAt = ? WHERE id = ?`)
          .bind(tid, nowIso, sid),
        // ensure-INSERT план-джоба — точная копия приложения (идемпотентен)
        env.DB.prepare(
          `INSERT INTO TrafficJob (id, tripId, status, priority, attempts, createdAt, updatedAt)
                 SELECT ?, ?, 'pending', 0, 0, ?, ?
                 WHERE NOT EXISTS (SELECT 1 FROM TrafficJob WHERE tripId = ? AND status IN ('pending', 'running'))`
        ).bind(crypto.randomUUID(), tid, nowIso, nowIso, tid),
        env.DB.prepare(
          `UPDATE Trip SET trafficJobId = COALESCE(
                      (SELECT id FROM TrafficJob WHERE tripId = ? ORDER BY createdAt DESC LIMIT 1), trafficJobId)
            WHERE id = ? AND trafficJobId IS NULL`
        ).bind(tid, tid),
      ]);
      console.log(JSON.stringify({ t: "fm:adopt", sessionId: sid, tripId: tid, mode: "attach" }));
      out.adopted = (out.adopted ?? 0) + 1;
    } else {
      // — v3.1 (CR-G F6): гейт движения — стационарная сирота НЕ поездка —
      // MAX(speed) < 2 м/с И bbox < 250 м → пропускаем (парковка между
      // поездками не принадлежит никому — канон §6). Сбой проверки — тоже
      // пропуск (консервативно, повторится следующим тиком).
      try {
        const mv = await env.DB.prepare(
          `SELECT MAX(speed) AS maxSpeed, MIN(lat) AS minLat, MAX(lat) AS maxLat, MIN(lon) AS minLon, MAX(lon) AS maxLon FROM GpsPoint WHERE sessionId = ?`
        ).bind(sid).first();
        if (mv) {
          const maxSpeed = mv.maxSpeed == null ? null : Number(mv.maxSpeed);
          const latSpanM = Math.abs(Number(mv.maxLat) - Number(mv.minLat)) * 111320;
          const midLat = (Number(mv.maxLat) + Number(mv.minLat)) / 2;
          const lonSpanM = Math.abs(Number(mv.maxLon) - Number(mv.minLon)) * 111320 * Math.cos((midLat * Math.PI) / 180);
          const speedStill = maxSpeed == null || maxSpeed < 2.0;
          const bboxStill = latSpanM < 250 && lonSpanM < 250;
          if (speedStill && bboxStill) {
            console.log(JSON.stringify({ t: "fm:adopt:skip", sessionId: sid, reason: "stationary (no movement)" }));
            continue;
          }
        }
      } catch (e) {
        console.warn(JSON.stringify({ level: "warn", msg: "fm adopt movement check failed (skip this tick)", sessionId: sid, error: String((e && e.message) || e) }));
        continue;
      }
      // — create: новой поездке — координаты первого/последнего фикса сессии —
      let startLat = null;
      let startLon = null;
      let endLat = null;
      let endLon = null;
      try {
        const first = await env.DB.prepare(
          `SELECT lat, lon FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC LIMIT 1`
        ).bind(sid).first();
        const last = await env.DB.prepare(
          `SELECT lat, lon FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp DESC LIMIT 1`
        ).bind(sid).first();
        if (first) { startLat = Number(first.lat); startLon = Number(first.lon); }
        if (last) { endLat = Number(last.lat); endLon = Number(last.lon); }
      } catch (e) {
        console.warn(JSON.stringify({ level: "warn", msg: "fm adopt coords lookup failed", sessionId: sid, error: String((e && e.message) || e) }));
      }
      const nid = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO Trip (id, deviceId, userId, status, startTime, endTime, spanStart, spanEnd,
                  startLat, startLon, endLat, endLon, sessionIds, sessionCount,
                  interFragmentGapSec, pointCountActual, statsComputedAt, createdAt, updatedAt)
           VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`
        ).bind(
          nid, String(s.deviceId), userId,
          startIso, endIso, startIso, endIso,
          startLat, startLon, endLat, endLon,
          JSON.stringify([sid]), 1,
          Number(s.pointCount ?? 0), nowIso, nowIso
        ),
        env.DB.prepare(`UPDATE Session SET tripId = ?, updatedAt = ? WHERE id = ?`)
          .bind(nid, nowIso, sid),
        // новая закрытая поездка — план-джоб (§9 ТЗ; копия приложения)
        env.DB.prepare(
          `INSERT INTO TrafficJob (id, tripId, status, priority, attempts, createdAt, updatedAt)
                 SELECT ?, ?, 'pending', 0, 0, ?, ?
                 WHERE NOT EXISTS (SELECT 1 FROM TrafficJob WHERE tripId = ? AND status IN ('pending', 'running'))`
        ).bind(crypto.randomUUID(), nid, nowIso, nowIso, nid),
        env.DB.prepare(
          `UPDATE Trip SET trafficJobId = COALESCE(
                      (SELECT id FROM TrafficJob WHERE tripId = ? ORDER BY createdAt DESC LIMIT 1), trafficJobId)
            WHERE id = ? AND trafficJobId IS NULL`
        ).bind(nid, nid),
      ]);
      console.log(JSON.stringify({ t: "fm:adopt", sessionId: sid, tripId: nid, mode: "create" }));
      out.adopted = (out.adopted ?? 0) + 1;
    }
  }
}

// ——— v3 (CR-C F3): fmMergeUndercut — слияние «недосклеенных» кусков ———
// Проблема (CR-B D1.1): пары живых Trip ОДНОГО устройства с гэпом между
// spanEnd(a) и spanStart(b) < TRIP_SPLIT_SEC (900 c) — по канону «поездка
// не рвётся» (trip-grouping.ts: соседние интервалы < 900 c — одна поездка)
// это ОДНА поездка; куски возникли из-за поздно пришедших мостов точек и
// матчинга ±120 c (MATCH_MS) в recomputeTripsForDevice. На 2026-09-30 таких
// пар ровно 3 (гэпы 582/867/899 с).
// Алгоритм (≤2 пар за прогон, идемпотентно — слитая пара исчезает из выборки):
//   1) пары по span-гэпу < 900 c (datetime() на обеих сторонах, дедуб a-b/b-a
//      условием a.spanStart < b.spanStart — a = более ранний, keeper);
//   2) ПЕРЕД слиянием — проверка по СЫРЫМ данным (сессии, не span):
//      MAX(endTime сессий a) vs MIN(startTime сессий b) (чанками ≤90 id —
//      лимит D1 на параметры); реальный гэп ≥ 900 c → НЕ сливаем (span мог
//      быть растянут back-extension поверх парковки — кейс e9b7947c/
//      27280f61, у которого сессии между кусками — стоянка);
//   3) слияние (один атомарный batch): keeper a ← spanStart/startTime = min,
//      spanEnd/endTime = max, sessionIds = объединение, sessionCount = сумма,
//      метрики/statsComputedAt = NULL (tsw пересчитает; список инвалидации —
//      как у приложения); userId = COALESCE(a, b); Session.tripId b → a;
//      план-джоб keeper'а переочередью (ensure-INSERT приложения),
//      pending/running-джобы b — DELETE; b — ЖЁСТКИЙ DELETE Trip (ровно как
//      recomputeTripsForDevice, trip-grouping.ts:507 «DELETE FROM Trip WHERE
//      id = ?»). Сырые данные (Session/GpsPoint) НЕ трогаются — поездка
//      восстановима каноническим POST /api/admin/backfill-trips.
const TRIP_SPLIT_MS = 900_000; // = TRIP_SPLIT_SEC (900 c) приложения, src/lib/env.ts
// v3.1 (CR-G F8): окно слияния — биндинг FM_TRIP_MERGE_MAX_SEC (сек; дефолт
// 1800 = «один выезд со стоянкой до 30 минут»). Спека 900 c остаётся
// ГРАНИЦЕЙ при каноническом пересчёте приложения; это окно — досклейка
// готовых кусков (в т.ч. самоисцеление recompute-флип-флопа: canonical
// re-split → merge-движок вклеивает обратно).
function fmMergeMaxMs(env) {
  const v = Number(env && env.FM_TRIP_MERGE_MAX_SEC);
  return Number.isFinite(v) && v >= 60 ? v * 1000 : 1_800_000;
}

/** MAX(endTime)/MIN(startTime) живых сессий по списку id (чанки ≤90 — лимит
 *  связанных параметров D1). Возвращает мс или null. */
async function fmSessionBound(env, ids, agg) {
  const isMax = agg.startsWith("MAX");
  let acc = null;
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const ph = chunk.map(() => "?").join(", ");
    const r = await env.DB.prepare(
      `SELECT ${agg} AS v FROM Session WHERE id IN (${ph}) AND deletedAt IS NULL`
    ).bind(...chunk.map(String)).first();
    if (!r || r.v == null) continue;
    const v = Date.parse(String(r.v));
    if (!Number.isFinite(v)) continue;
    if (acc == null) acc = v;
    else acc = isMax ? Math.max(acc, v) : Math.min(acc, v);
  }
  return acc;
}

async function fmMergeUndercut(env, now, out) {
  const mergeSec = String(Math.floor(fmMergeMaxMs(env) / 1000));
  const pairs = await env.DB.prepare(
    `SELECT a.id AS idA, b.id AS idB, a.deviceId AS deviceId,
            a.sessionIds AS idsA, b.sessionIds AS idsB,
            a.spanStart AS aSpanStart, a.spanEnd AS aSpanEnd,
            a.startTime AS aStartTime, a.endTime AS aEndTime,
            b.spanStart AS bSpanStart, b.spanEnd AS bSpanEnd,
            b.startTime AS bStartTime, b.endTime AS bEndTime,
            a.userId AS aUserId, b.userId AS bUserId,
            CAST((julianday(datetime(b.spanStart)) - julianday(datetime(a.spanEnd))) * 86400000 AS INTEGER) AS gapMs
       FROM Trip a
       JOIN Trip b ON a.deviceId = b.deviceId AND a.id <> b.id
         AND datetime(a.spanStart) < datetime(b.spanStart)
         AND datetime(b.spanStart) >= datetime(a.spanEnd)
         AND datetime(b.spanStart) < datetime(a.spanEnd, '+' || ? || ' seconds')
      WHERE a.deletedAt IS NULL AND b.deletedAt IS NULL
      ORDER BY datetime(a.spanEnd) DESC LIMIT 2`
  ).bind(mergeSec).all(); // v3.1 F8: динамическое окно (дефолт 1800 c)
  for (const p of pairs.results ?? []) {
    const idA = String(p.idA);
    const idB = String(p.idB);
    let idsA;
    let idsB;
    try { idsA = JSON.parse(String(p.idsA ?? "[]")); } catch { idsA = []; }
    try { idsB = JSON.parse(String(p.idsB ?? "[]")); } catch { idsB = []; }
    if (!Array.isArray(idsA)) idsA = [];
    if (!Array.isArray(idsB)) idsB = [];
    // проверка по сессиям (сырьё, не span) — до любых записей
    let gapMs = Number(p.gapMs);
    if (idsA.length > 0 && idsB.length > 0) {
      try {
        const aEnd = await fmSessionBound(env, idsA, "MAX(endTime)");
        const bStart = await fmSessionBound(env, idsB, "MIN(startTime)");
        if (aEnd != null && bStart != null) {
          const realGap = bStart - aEnd;
          if (realGap >= fmMergeMaxMs(env)) {
            console.log(JSON.stringify({ t: "fm:merge:skip", tripA: idA, tripB: idB, spanGapMs: gapMs, sessionGapMs: realGap, reason: "session-gap >= merge window (FM_TRIP_MERGE_MAX_SEC)" }));
            continue;
          }
          gapMs = realGap;
        }
      } catch (e) {
        // сбой проверки — консервативно пропускаем пару в этом прогоне
        console.warn(JSON.stringify({ level: "warn", msg: "fm merge session-verify failed (skip pair this run)", tripA: idA, tripB: idB, error: String((e && e.message) || e) }));
        continue;
      }
    }
    // — слияние: keeper = a (ранний) —
    const set = new Set([...idsA.map(String), ...idsB.map(String)]);
    const arr = [...set];
    const aSpanStart = Date.parse(String(p.aSpanStart));
    const bSpanStart = Date.parse(String(p.bSpanStart));
    const aSpanEnd = p.aSpanEnd == null ? null : Date.parse(String(p.aSpanEnd));
    const bSpanEnd = p.bSpanEnd == null ? null : Date.parse(String(p.bSpanEnd));
    const aStartTime = Date.parse(String(p.aStartTime));
    const bStartTime = Date.parse(String(p.bStartTime));
    const aEndTime = p.aEndTime == null ? null : Date.parse(String(p.aEndTime));
    const bEndTime = p.bEndTime == null ? null : Date.parse(String(p.bEndTime));
    const spanStartIso = new Date(Math.min(aSpanStart, bSpanStart)).toISOString();
    const spanEndIso = new Date(
      Math.max(
        aSpanEnd != null && Number.isFinite(aSpanEnd) ? aSpanEnd : bSpanStart,
        bSpanEnd != null && Number.isFinite(bSpanEnd) ? bSpanEnd : bSpanStart
      )
    ).toISOString();
    const startTimeIso = new Date(Math.min(aStartTime, bStartTime)).toISOString();
    const endCandidates = [aEndTime, bEndTime].filter((v) => v != null && Number.isFinite(v));
    const endTimeIso = endCandidates.length > 0 ? new Date(Math.max(...endCandidates)).toISOString() : null;
    const userId = p.aUserId != null ? String(p.aUserId) : (p.bUserId != null ? String(p.bUserId) : null);
    const nowIso = new Date(now).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE Trip SET startTime = ?, endTime = ?, spanStart = ?, spanEnd = ?,
                sessionIds = ?, sessionCount = ?, userId = ?,
                statsComputedAt = NULL, activeDurationSec = NULL, movingTimeSec = NULL,
                idleTimeSec = NULL, gapTimeSec = NULL, internalStopTimeSec = NULL,
                distanceM = NULL, pointCountActual = NULL, maxSpeedMs = NULL, ecoScore = NULL,
                planDistanceM = NULL, planDurationSec = NULL, planComparable = NULL,
                planCoverage = NULL, routingLegCount = NULL, updatedAt = ?
          WHERE id = ?`
      ).bind(startTimeIso, endTimeIso, spanStartIso, spanEndIso, JSON.stringify(arr), arr.length, userId, nowIso, idA),
      env.DB.prepare(`UPDATE Session SET tripId = ?, updatedAt = ? WHERE tripId = ?`).bind(idA, nowIso, idB),
      // джобы b: живые — как у приложения при удалении поездки (DELETE pending/running)
      env.DB.prepare(`DELETE FROM TrafficJob WHERE tripId = ? AND status IN ('pending', 'running')`).bind(idB),
      // план-джоб keeper'а — переочередь (ensure-INSERT приложения)
      env.DB.prepare(
        `INSERT INTO TrafficJob (id, tripId, status, priority, attempts, createdAt, updatedAt)
               SELECT ?, ?, 'pending', 0, 0, ?, ?
               WHERE NOT EXISTS (SELECT 1 FROM TrafficJob WHERE tripId = ? AND status IN ('pending', 'running'))`
      ).bind(crypto.randomUUID(), idA, nowIso, nowIso, idA),
      env.DB.prepare(
        `UPDATE Trip SET trafficJobId = COALESCE(
                    (SELECT id FROM TrafficJob WHERE tripId = ? ORDER BY createdAt DESC LIMIT 1), trafficJobId)
          WHERE id = ? AND trafficJobId IS NULL`
      ).bind(idA, idA),
      // b — жёсткий DELETE (как recomputeTripsForDevice; сырьё не трогаем)
      env.DB.prepare(`DELETE FROM Trip WHERE id = ?`).bind(idB),
    ]);
    console.log(JSON.stringify({ t: "fm:merge", tripA: idA, tripB: idB, gapMs }));
    out.merged = (out.merged ?? 0) + 1;
  }
}

// ——— v3.1 (CR-G F7): fmRetireStaticTrips — вывод «фейковых» поездок ———
// RC1 (docs/OPERATIONS.md §14): adopt v3 без гейта движения создал Trip'ы
// из стационарных сессий — «поездки» 0 км / 0 мин движения. Критерий честный:
// метрики УЖЕ посчитаны приложением (statsComputedAt NOT NULL — не «ещё не
// знаем», а «точно не ехали») и distanceM < 100 м И movingTimeSec < 60 c.
// ≤2/тик (свежие первыми — они в текущем UI): отцепить сессии (tripId=NULL),
// DELETE pending/running TrafficJob, hard-DELETE Trip (как у приложения в
// recomputeTripsForDevice — сырьё восстановимо POST /api/admin/backfill-trips).
// Идемпотентно: удалённая поездка выпадает из выборки.
async function fmRetireStaticTrips(env, now, out) {
  const rows = await env.DB.prepare(
    `SELECT id, deviceId FROM Trip
      WHERE deletedAt IS NULL AND statsComputedAt IS NOT NULL
        AND distanceM IS NOT NULL AND distanceM < 100
        AND movingTimeSec IS NOT NULL AND movingTimeSec < 60
      ORDER BY updatedAt DESC LIMIT 2`
  ).all();
  for (const r of rows.results ?? []) {
    const id = String(r.id);
    const nowIso = new Date(now).toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE Session SET tripId = NULL, updatedAt = ? WHERE tripId = ? AND deletedAt IS NULL`).bind(nowIso, id),
      env.DB.prepare(`DELETE FROM TrafficJob WHERE tripId = ? AND status IN ('pending', 'running')`).bind(id),
      env.DB.prepare(`DELETE FROM Trip WHERE id = ?`).bind(id),
    ]);
    console.log(JSON.stringify({ t: "fm:retire", tripId: id, deviceId: String(r.deviceId) }));
    out.retired = (out.retired ?? 0) + 1;
  }
}

// ——— v3.2 (CR-I F10): fmSoftDeleteStandingOrphans — санитайзер мусорных сирот ———
// Порт шага 2 GHA-моста trip-heal.ts (боевой режим 01-03.10). RC2-хвост:
// даже с SESSION_GAP_MS=900000 одиночные сердцебиения через >15 мин тишины
// рождают 1-точечные completed-сироты — движок adopt их игнорирует
// (pointCount < 3), а счётчик «записей» FM-роллапа их видит (deletedAt
// IS NULL). Чистим мягко: стационарная сирота → Session.deletedAt (точки
// НЕ трогаем — восстановимо снятием deletedAt). Движущаяся сирота НЕ
// трогается — её усыновит fmAdoptOrphans (гейт движения F6).
// Дискриминатор стоянки — геометрия (speed-поле непригодно, N-5):
//   maxSpeed < 2 м/с И (bbox < 250 м ИЛИ bbox/длительность < 1,4 м/с)
// ( GPS-дрейф на стоянке даёт bbox 250-400 м, но скорость смещения < 5 км/ч —
//   кейс f53153d4; реальная езда даёт либо maxSpeed ≥ 2, либо км-масштаб ).
// ≤20 кандидатов/тик (свежие первыми), окно 2 суток, pointCount ≤ 3000.
async function fmSoftDeleteStandingOrphans(env, now, out) {
  const sinceIso = new Date(now - 2 * 86400000).toISOString();
  const orphans = await env.DB.prepare(
    `SELECT id, deviceId, startTime, endTime, pointCount FROM Session
      WHERE tripId IS NULL AND status = 'completed' AND deletedAt IS NULL AND startTime > ?
      ORDER BY startTime DESC LIMIT 20`
  ).bind(sinceIso).all();
  for (const s of orphans.results ?? []) {
    const sid = String(s.id);
    const pc = Number(s.pointCount ?? 0);
    if (pc <= 0 || pc > 3000) continue; // пустые/гиганты — не наш мусор
    const m = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(speed) AS maxSpeed, MIN(lat) AS minLat, MAX(lat) AS maxLat, MIN(lon) AS minLon, MAX(lon) AS maxLon
         FROM GpsPoint WHERE sessionId = ?`
    ).bind(sid).first();
    const n = Number(m && m.n) || 0;
    if (n === 0) continue; // нет точек — оставляем (не наш мусор)
    const maxSpeed = m.maxSpeed == null ? null : Number(m.maxSpeed);
    const minLat = Number(m.minLat);
    const maxLat = Number(m.maxLat);
    const minLon = Number(m.minLon);
    const maxLon = Number(m.maxLon);
    const latSpanM = Math.abs(maxLat - minLat) * 111320;
    const midLat = (maxLat + minLat) / 2;
    const lonSpanM = Math.abs(maxLon - minLon) * 111320 * Math.cos((midLat * Math.PI) / 180);
    const speedStill = maxSpeed == null || maxSpeed < 2.0; // < 7,2 км/ч
    const bboxMaxM = Math.max(latSpanM, lonSpanM);
    const durSec = Math.max(
      Math.abs(Date.parse(String(s.endTime ?? s.startTime)) - Date.parse(String(s.startTime))) / 1000,
      60
    );
    const rateStill = bboxMaxM / durSec < 1.4; // < 5 км/ч — пешеход/дрейф
    if (speedStill && (bboxMaxM < 250 || rateStill)) {
      const nowIso = new Date(now).toISOString();
      await env.DB.prepare(
        `UPDATE Session SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL`
      ).bind(nowIso, nowIso, sid).run();
      console.log(JSON.stringify({ t: "fm:softDelete", sessionId: sid, deviceId: String(s.deviceId), points: pc, bboxM: Math.round(bboxMaxM) }));
      out.softDeleted = (out.softDeleted ?? 0) + 1;
    }
  }
}

/** Тик FM-движка — вызывается из scheduled() на минутном триггере (до джобов).
 *  Каждый шаг в своём try/catch: сбой одного не роняет остальные.
 *  Возвращает счётчики для структурного лога "fm engine tick". */
async function fmEngineTick(env) {
  if (!FM_ENABLED || !env.DB) return { ok: false, reason: "disabled" };
  const zone = env.TELEMAT_TIMEZONE || "UTC";
  const now = Date.now();
  const todayKey = rollupDayKey(now, zone);
  const yesterdayKey = rollupDayKey(now - 86400000, zone);
  const kv = env.KV;
  const out = { todayRows: 0, froze: 0, refresh7d: false, tsw: null, backupReaped: 0, adopted: 0, merged: 0, retired: 0, silentAudits: 0, softDeleted: 0, dayAudit: null, resyncStatsV3: null }; // v3.6: +dayAudit/+resyncStatsV3
  // 1) backfill-once (идемпотентен по KV-маркеру)
  try {
    await fmBackfillOnce(env, zone, yesterdayKey);
  } catch (e) {
    console.log(JSON.stringify({ level: "warn", msg: "fm backfill step failed", error: String((e && e.message) || e) }));
  }
  // 2) суточная строка «сегодня» — каждую минуту (±18 ч запас TZ)
  try {
    const fromMs = Date.parse(todayKey + "T00:00:00Z") - 64800000;
    const toMs = Date.parse(fmNextDayKey(todayKey) + "T00:00:00Z") + 64800000;
    const rows = fmComputeDays(await fmSessionsInRange(env, fromMs, toMs), todayKey, todayKey, zone);
    out.todayRows = await fmWriteDayRows(env, rows);
  } catch (e) {
    console.log(JSON.stringify({ level: "warn", msg: "fm today step failed", error: String((e && e.message) || e) }));
  }
  if (kv) {
    // 3) заморозка прошедшего дня при смене суток (fm:frozenThru, с валидацией формата)
    let frozenThru = null;
    try {
      frozenThru = await kv.get("fm:frozenThru").catch(() => null);
      if (typeof frozenThru !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(frozenThru)) frozenThru = null;
    } catch {
      // чтение маркера не удалось — заморозка пропускается (не критично)
    }
    try {
      if (frozenThru == null) {
        await kv.put("fm:frozenThru", yesterdayKey);
      } else if (frozenThru < yesterdayKey) {
        const from = fmNextDayKey(frozenThru);
        const fromMs = Math.max(Date.parse(from + "T00:00:00Z") - 64800000, 1262304e6); // 1262304e6 = 2010-01-01: нижний кламп заморозки
        const toMs = Date.parse(fmNextDayKey(yesterdayKey) + "T00:00:00Z") + 64800000;
        const rows = fmComputeDays(await fmSessionsInRange(env, fromMs, toMs), from, yesterdayKey, zone);
        await fmWriteDayRows(env, rows);
        await kv.put("fm:frozenThru", yesterdayKey);
        out.froze = rows.length;
        console.log(JSON.stringify({ level: "info", msg: "fm day-flip freeze", from, thru: yesterdayKey, rows: rows.length }));
      }
    } catch (e) {
      console.log(JSON.stringify({ level: "warn", msg: "fm freeze step failed", error: String((e && e.message) || e) }));
    }
    // 4) часовой refresh последних 7 дней (самолечение дрейфа rollup)
    try {
      const last7 = await kv.get("fm:refresh7d:at").catch(() => null);
      if (!last7 || now - Date.parse(last7) > 3600000) {
        const fromKey = rollupDayKey(now - 7 * 86400000, zone);
        const fromMs = Date.parse(fromKey + "T00:00:00Z") - 64800000;
        const rows = fmComputeDays(await fmSessionsInRange(env, fromMs, now + 64800000), fromKey, todayKey, zone);
        await fmWriteDayRows(env, rows);
        await kv.put("fm:refresh7d:at", new Date(now).toISOString());
        out.refresh7d = true;
      }
    } catch (e) {
      console.log(JSON.stringify({ level: "warn", msg: "fm refresh7d step failed", error: String((e && e.message) || e) }));
    }
  }
  // 4b) v3.6 (CR-G A1-durable): day-audit — реконсайл ЗАМОРОЖЕННЫХ дней.
  // Живые суточные счётчики (только Session, без GpsPoint-сканов и без
  // парсинга statsCache) против StatsRollup; несовпавшие дни пересчитываются
  // и прунятся от исчезнувших составов. Триггеры: флаг fm:dirtyScan (ставится
  // /query|/batch сразу после Session-мутаций состава — удаления юзера видны
  // в KPI ≤ минуты) + гарантия каждые 10 минут (импорт в старый день,
  // внутренние мутации движка, любые прочие источники дрейфа). День «сегодня»
  // исключён — его строка и так пересчитывается каждую минуту (шаг 2).
  try {
    const flagged = kv ? await kv.get("fm:dirtyScan").catch(() => null) : null;
    if (flagged || new Date(now).getUTCMinutes() % 10 === 0) {
      out.dayAudit = await fmDayAudit(env, zone, todayKey);
      if (flagged && kv) await kv.delete("fm:dirtyScan").catch(() => {});
    }
  } catch (e) {
    console.log(JSON.stringify({ level: "warn", msg: "fm day-audit step failed", error: String((e && e.message) || e) }));
  }
  // 5) раз в 5 минут: рекон BackupJob → adopt (F2) → merge (F3) → прогрев tsw
  if (new Date(now).getUTCMinutes() % 5 === 0) {
    try {
      const bj = await env.DB.prepare(
        "UPDATE BackupJob SET status = 'failed', error = 'fm: reclaimed stuck running > 2h (worker CPU limit)', completedAt = ? WHERE status = 'running' AND createdAt < ?"
      ).bind(new Date(now).toISOString(), new Date(now - 7200000).toISOString()).run();
      out.backupReaped = Number(bj.meta?.changes ?? 0);
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "fm BackupJob reap failed", error: String((e && e.message) || e) }));
    }
    try {
      await fmRetireStaticTrips(env, now, out); // v3.1 F7: фейки — до adopt
    } catch (e) {
      console.log(JSON.stringify({ level: "warn", msg: "fm retire failed", error: String((e && e.message) || e) }));
    }
    try {
      await fmSoftDeleteStandingOrphans(env, now, out); // v3.2 F10: мусорные сироты — до adopt (мусор наружу, движущиеся — adopt'у)
    } catch (e) {
      console.log(JSON.stringify({ level: "warn", msg: "fm softDelete standing orphans failed", error: String((e && e.message) || e) }));
    }
    try {
      await fmAdoptOrphans(env, now, out);
    } catch (e) {
      console.log(JSON.stringify({ level: "warn", msg: "fm adopt failed", error: String((e && e.message) || e) }));
    }
    try {
      await fmMergeUndercut(env, now, out);
    } catch (e) {
      console.log(JSON.stringify({ level: "warn", msg: "fm merge failed", error: String((e && e.message) || e) }));
    }
    // v3.1 (CR-G F9): device-silence аудит — RC4 «вечерняя поездка не
    // записалась, потому что приложение умерло утром»: молчание устройства
    // 3-9 ч / 21-27 ч при локальных часах 7..23 → AuditLog device.silent.
    // Троттлинг 20 ч (индекс action,createdAt); тест-девайсы не будоражим.
    try {
      const devs = await env.DB.prepare(
        `SELECT deviceId, MAX(endTime) AS lastEnd FROM Session WHERE deletedAt IS NULL AND startTime > ? GROUP BY deviceId`
      ).bind(new Date(now - 7 * 86400000).toISOString()).all();
      const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hour12: false });
      const localHour = Number(hourFmt.format(new Date(now)));
      for (const d of devs.results ?? []) {
        const dev = String(d.deviceId);
        if (/^(proxy-|diag-)|-test$|e2e/i.test(dev)) continue;
        const lastEnd = Date.parse(String(d.lastEnd));
        if (!Number.isFinite(lastEnd)) continue;
        const silentMs = now - lastEnd;
        const inBand = (silentMs >= 3 * 3600000 && silentMs < 9 * 3600000) || (silentMs >= 21 * 3600000 && silentMs < 27 * 3600000);
        if (!inBand || localHour < 7 || localHour > 23) continue;
        const seen = await env.DB.prepare(
          `SELECT 1 FROM AuditLog WHERE action = 'device.silent' AND targetId = ? AND createdAt > ? LIMIT 1`
        ).bind(dev, new Date(now - 20 * 3600000).toISOString()).first();
        if (seen) continue;
        await env.DB.prepare(
          `INSERT INTO AuditLog (id, userId, action, targetId, targetType, actorType, actorId, metadata, sessionId, createdAt)
           VALUES (?, NULL, 'device.silent', ?, 'Device', 'system', 'fm-engine', ?, NULL, ?)`
        ).bind(
          crypto.randomUUID(),
          dev,
          JSON.stringify({ silentHours: Math.round(silentMs / 3600000), lastPointAt: new Date(lastEnd).toISOString(), hint: "нет данных с устройства — приложение закрыто/убито ОС; поездки НЕ записываются" }),
          new Date(now).toISOString()
        ).run();
        out.silentAudits = (out.silentAudits ?? 0) + 1;
        console.log(JSON.stringify({ t: "fm:deviceSilent", deviceId: dev, silentHours: Math.round(silentMs / 3600000) }));
      }
    } catch (e) {
      console.log(JSON.stringify({ level: "warn", msg: "fm device-silence audit failed", error: String((e && e.message) || e) }));
    }
    // v3.6 (CR-G A6/A7): ОДНОРАЗОВЫЙ ресинк метрик поездок на методологию
    // v2.44.0 (MaxSpeed: геометрическая корроборация спайк-поездов + гео-
    // фоллбек для NULL-speed). Безопасен при ЛЮБОМ порядке деплоев: шаг ждёт
    // приложение версии ≥ 2.44.0 (GET /health), только тогда NULL-ит
    // statsComputedAt всех финальных поездок — прогрев tsw ниже пересчитает
    // их НОВЫМ кодом (9 поездок/тик, ~30 мин на весь парк). KV-маркер
    // fm:resync:statsv3 — идемпотентность.
    try {
      if (kv && env.APP_ORIGIN && !(await kv.get("fm:resync:statsv3").catch(() => null))) {
        const ctrl = new AbortController();
        const tm = setTimeout(() => ctrl.abort(), 10000);
        let ver = null;
        try {
          const r = await fetch(env.APP_ORIGIN + "/health", { signal: ctrl.signal });
          if (r.ok) {
            const hv = await r.json().catch(() => null);
            ver = hv && typeof hv.version === "string" ? hv.version : null;
          }
        } finally {
          clearTimeout(tm);
        }
        if (ver && fmAppVersionAtLeast(ver, "2.44.0")) {
          const u = await env.DB.prepare(
            "UPDATE Trip SET statsComputedAt = NULL WHERE statsComputedAt IS NOT NULL AND deletedAt IS NULL"
          ).run();
          const trips = Number(u.meta?.changes ?? 0);
          await kv.put("fm:resync:statsv3", JSON.stringify({ at: new Date(now).toISOString(), appVersion: ver, trips }));
          out.resyncStatsV3 = { appVersion: ver, trips };
          console.log(JSON.stringify({ level: "info", msg: "fm resync statsv3: trips queued for recompute", appVersion: ver, trips }));
        }
      }
    } catch (e) {
      console.log(JSON.stringify({ level: "warn", msg: "fm resync statsv3 step failed", error: String((e && e.message) || e) }));
    }
    try {
      // v3.2 (CR-I): окно tsw 10 минут (было 6 ч — свежие поездки висели
      // «— км — мин» до 6 ч; боевая практика моста — 10 мин) + TTL маркера
      // 900 с (сбой ретраится через 15 мин, а не голодает 6 ч).
      const t = await env.DB.prepare(
        "SELECT id, userId FROM Trip WHERE deletedAt IS NULL AND statsComputedAt IS NULL AND status = 'completed' AND spanEnd < ? ORDER BY spanStart ASC LIMIT 9" // v3.1 (CR-G): 9 кандидатов — хвост очереди не голодает
      ).bind(new Date(now - 600000).toISOString()).all();
      for (const tr of t.results ?? []) {
        const id = String(tr.id);
        const key = "fm:tsw:" + id;
        const last = kv ? await kv.get(key).catch(() => null) : null;
        if (last) continue;
        if (kv) await kv.put(key, new Date(now).toISOString(), { expirationTtl: 900 });
        const uid = tr.userId == null ? null : String(tr.userId);
        let apiKey = null;
        if (uid) {
          const u = await env.DB.prepare("SELECT apiKey FROM User WHERE id = ?").bind(uid).first().catch(() => null);
          apiKey = u && u.apiKey ? String(u.apiKey) : null;
        }
        if (apiKey && env.APP_ORIGIN) {
          const ctrl = new AbortController();
          const tm = setTimeout(() => ctrl.abort(), 30000);
          try {
            const r = await fetch(env.APP_ORIGIN + "/api/trips/batch?ids=" + encodeURIComponent(id), { headers: { authorization: "Bearer " + apiKey }, signal: ctrl.signal });
            out.tsw = { tripId: id, status: r.status };
          } catch (e) {
            out.tsw = { tripId: id, error: String((e && e.message) || e) };
          } finally {
            clearTimeout(tm);
          }
        }
        // v3.1 (CR-G): убран break из v3 — грелся ровно 1 поездка за тик
        // (замерло: очередь 14 стояла 40+ мин при живых тиках). Теперь — до 3.
      }
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "fm tsw warm step failed", error: String((e && e.message) || e) }));
    }
  }
  return out;
}

// ——— FM: перехватчики SQL в /query (после validateStatement) ———
// Приложение (бандл telemat-web) слает дословные шаблоны; перехват до D1
// убирает CPU-пожиратели (полный heal истории 1970-01-01, fallback-сканы
// GpsPoint) — KPI всегда собирается из StatsRollup. Любой сбой — fallthrough
// на реальный запрос (перехватчик НИКОГДА не блокирует).

/** Скоуп-предикат приложения (userId = ? / IS NULL) → в rollup userId = ''. */
function fmScopeClause(sql) {
  if (/AND\s+userId\s+IS\s+NULL/i.test(sql)) return { clause: " WHERE userId = ''", param: null };
  if (/AND\s+userId\s*=\s*\?/i.test(sql)) return { clause: " WHERE userId = ?", param: 0 };
  return { clause: "", param: null };
}

async function fmInterceptQuery(env, sql, params) {
  if (!FM_ENABLED || typeof sql !== "string") return null;
  try {
    const s = sql.replace(/\s+/g, " ").trim();
    // Q4: heal 1970-01-01 (recomputeRollupRange всей истории) → пустой ответ
    if (/^SELECT startTime, userId, pointCount(, statsCache)? FROM Session WHERE deletedAt IS NULL AND startTime >= \? AND startTime < \?/i.test(s) && typeof params[0] === "string" && params[0] < "2001-01-01") {
      return json({ rows: [], rowsAffected: 0, meta: { rowsRead: 0, rowsWritten: 0, durationMs: 0, fm: "heal-neutralized" } });
    }
    // Q2: sessionScopeCounters (COUNT + MAX(updatedAt)) → SUM/MAX из rollup
    if (/^SELECT COUNT\(\*\) AS c, MAX\(updatedAt\) AS m FROM Session WHERE deletedAt IS NULL( AND userId = \?| AND userId IS NULL)?$/i.test(s)) {
      const scope = fmScopeClause(s);
      const stmt = env.DB.prepare("SELECT COALESCE(SUM(sessions), 0) AS c, MAX(updatedAt) AS m FROM StatsRollup" + scope.clause);
      const res = await (scope.param === 0 ? stmt.bind(params[0]) : stmt).all();
      budgetTrack(res.meta?.rows_read ?? 0, res.meta?.rows_written ?? 0);
      const r = (res.results ?? [])[0] ?? {};
      return json({ rows: [{ c: Number(r.c ?? 0), m: r.m ?? null }], rowsAffected: 0, meta: { rowsRead: res.meta?.rows_read ?? 0, rowsWritten: 0, durationMs: res.meta?.duration ?? 0, fm: "rollup-scope-counters" } });
    }
    // Q1: totalSessions → SUM(sessions) из rollup
    if (/^SELECT COUNT\(\*\) as count FROM Session WHERE deletedAt IS NULL( AND userId = \?| AND userId IS NULL)?$/i.test(s)) {
      const scope = fmScopeClause(s);
      const stmt = env.DB.prepare("SELECT COALESCE(SUM(sessions), 0) AS count FROM StatsRollup" + scope.clause);
      const res = await (scope.param === 0 ? stmt.bind(params[0]) : stmt).all();
      budgetTrack(res.meta?.rows_read ?? 0, res.meta?.rows_written ?? 0);
      const r = (res.results ?? [])[0] ?? {};
      return json({ rows: [{ count: Number(r.count ?? 0) }], rowsAffected: 0, meta: { rowsRead: res.meta?.rows_read ?? 0, rowsWritten: 0, durationMs: res.meta?.duration ?? 0, fm: "rollup-total-sessions" } });
    }
    // Q3: fallback COUNT точек (скан GpsPoint) → SUM(points) из rollup
    if (/^SELECT COUNT\(\*\) AS c FROM GpsPoint WHERE sessionId IN \(SELECT id FROM Session WHERE deletedAt IS NULL( AND userId = \?| AND userId IS NULL)?\)$/i.test(s)) {
      const scope = fmScopeClause(s);
      const stmt = env.DB.prepare("SELECT COALESCE(SUM(points), 0) AS c FROM StatsRollup" + scope.clause);
      const res = await (scope.param === 0 ? stmt.bind(params[0]) : stmt).all();
      budgetTrack(res.meta?.rows_read ?? 0, res.meta?.rows_written ?? 0);
      const r = (res.results ?? [])[0] ?? {};
      return json({ rows: [{ c: Number(r.c ?? 0) }], rowsAffected: 0, meta: { rowsRead: res.meta?.rows_read ?? 0, rowsWritten: 0, durationMs: res.meta?.duration ?? 0, fm: "rollup-total-points" } });
    }
  } catch (e) {
    console.log(JSON.stringify({ level: "warn", msg: "fm intercept failed (fallthrough)", error: String((e && e.message) || e) }));
  }
  return null;
}

// v2.38.2 (линт): воркер вынесен в именованную переменную ДО export default
// (import/no-anonymous-default-export) — поведение идентично module-syntax.
const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // v2.40.9 (Pack C §P1-a): глобальная ссылка KV для троттл-флаша бюджета
    // (budgetTrack синхронный; flush — из waitUntil/scheduled по этой ссылке)
    __envKV = env.KV ?? null;

    if (url.pathname === "/health") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      // v2.40.5 (Pack B): version — маркер деплоя шлюза (как APP_VERSION у
      // приложения): верификация «в воркере новый код» без wrangler tail.
      // v2.42.0: + TripCalc в ALLOWED_TABLES + CREATE_TRIPCALC_RE.
      // v3 (CR-C): gateway v3 — двойной секрет + схлопывание кронов + FM +
      // adopt/merge (полный список — шапка файла / docs/OPERATIONS.md §13).
      return json({ ok: true, gateway: "d1", db: env.DB ? "bound" : "missing-binding", version: "2.48.0" });
    }

    // v2.39.1 (§B1): edge-инжест — ДО гейта X-Gateway-Secret: канал имеет
    // собственную авторизацию (INGEST_TOKEN Bearer/?token= Sensor Logger
    // ИЛИ X-Gateway-Secret приложения). Метод/лимит/идемпотентность — внутри.
    // v2.40.0 (§B1-complete): алиас /api/ingest — Sensor Logger при переводе
    // на edge меняет ТОЛЬКО хост (https://d1-gateway.<sub>.workers.dev),
    // путь и токен остаются как у приложения — меньше мест для ошибки.
    if (url.pathname === "/ingest" || url.pathname === "/api/ingest") {
      return await handleEdgeIngest(request, env);
    }

    // v2.40.9 (Pack C §P2): SensorLogger-native канал на границе — Push URL
    // меняет ТОЛЬКО хост (push.poedzok.fun → d1-gateway…): путь, ?token=it_…
    // и ?deviceId= остаются как у приложения. Своя авторизация (глобальный
    // INGEST_TOKEN ИЛИ it_-токен с верификацией HMAC по User-таблице).
    if (url.pathname === "/api/ingest/sensorlogger") {
      return await handleEdgeSensorLogger(request, env);
    }

    // v2.40.0 (§B5/§T-DELTA): статус-эндпоинты наблюдаемости (GET, свой
    // секрет-гейт — до общего метод-чека POST-канала).
    // v3 (CR-C F0): гейт — ЛЮБОЙ из GATEWAY_SECRET | GHA_GATEWAY_SECRET
    // (gatewaySecretOk, constant-time для обоих).
    if (url.pathname === "/admin/turso-migrate/status" || url.pathname === "/admin/cron-status") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      if (!(await gatewaySecretOk(env, request.headers.get("x-gateway-secret") ?? ""))) {
        return json({ error: "unauthorized" }, 401);
      }
      const turso = await loadTursoState(env);
      const cron = await readCronStatus(env);
      // v2.40.9 (Pack C §P1-a): дневной бюджет чтений D1 — счётчик ШЛЮЗА
      // (KV-день + pending изолейта; переживает ресайклы/сны приложения).
      const budget = await budgetSnapshot(env);
      return json({ turso, cron, budget, schedules: CRON_SCHEDULES, appPaths: CRON_APP_PATHS });
    }

    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const secret = request.headers.get("x-gateway-secret") ?? "";
    // v2.38.2 (ревью F33): сравнение по SHA-256-дайджестам (constant-time).
    // v3 (CR-C F0): принимается ЛЮБОЙ из двух секретов — основной
    // GATEWAY_SECRET (приложение/рунбук) ИЛИ GHA_GATEWAY_SECRET (GitHub
    // Actions бэкап — ротируется независимо; не задан → проверка пропускается).
    // v3.4 (CR-J): гейт определяет КАНАЛ — GHA: SELECT/PRAGMA + DML только на
    // BackupJob/AuditLog (ночной бэкап); остальной DML — GATEWAY_GHA_DML;
    // User — read-only навсегда. Main-канал — полный вайтлист (как v3.2).
    const channel = await gatewaySecretChannel(env, secret);
    if (channel == null) {
      return json({ error: "unauthorized" }, 401);
    }

    // v2.38.1 (ревью F1): лимит тела — предчек по content-length (дёшево, до
    // чтения) и фактический по байтам стрима (readBodyLimited ниже).
    // v2.39.1 (§B2): /kvcache/* — отдельный меньший кап (64 КБ: sql+params).
    // v2.40.9 (Pack C): /kvstore/* — тот же малый кап (ключ+значение ≤512 КБ
    // значения при 64 КБ ЗАПРОСА перекрываются ниже валидацией; heavy-segments
    // ответ ~16 КБ — с запасом).
    const maxBody =
      Number(env.GATEWAY_MAX_BODY_BYTES) > 0 ? Number(env.GATEWAY_MAX_BODY_BYTES) : MAX_BODY_BYTES_DEFAULT;
    const bodyLimit =
      url.pathname === "/kvcache" || url.pathname === "/kvcache/invalidate" ||
      url.pathname === "/kvstore/get" || url.pathname === "/kvstore/put"
        ? Math.min(maxBody, KVCACHE_MAX_BODY_BYTES)
        : maxBody;
    const cl = Number(request.headers.get("content-length") || "0");
    if (cl > bodyLimit) {
      return json({ error: "payload too large", limitBytes: bodyLimit }, 413);
    }

    // v2.38.1 (ревью F1): rate-limit ПОСЛЕ auth (без секрета нельзя бесплатно
    // 429-нуть легитимного вызывающего) и ДО чтения тела.
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const rlMax =
      Number(env.GATEWAY_RATE_LIMIT_MAX) > 0 ? Number(env.GATEWAY_RATE_LIMIT_MAX) : RATE_LIMIT_MAX_DEFAULT;
    if (rateLimitExceeded(ip, rlMax, RATE_LIMIT_WINDOW_MS)) {
      return json({ error: "rate limit exceeded", retryAfterSec: 60, limit: rlMax }, 429);
    }

    const bodyRes = await readBodyLimited(request, bodyLimit);
    if (!bodyRes.ok) {
      return json({ error: bodyRes.error, limitBytes: bodyRes.limitBytes }, bodyRes.status);
    }
    let body;
    try {
      body = JSON.parse(bodyRes.text);
    } catch {
      return json({ error: "invalid json body" }, 400);
    }

    try {
      if (url.pathname === "/query") {
        const { sql, params } = body ?? {};
        if (typeof sql !== "string" || sql.length === 0) return json({ error: "sql required" }, 400);
        // v2.38.1 (ревью F1): вайтлист операций ДО prepare/exec.
        // v3.4 (CR-J): GATEWAY_READ_ONLY — только глобальный флаг; привилегии
        // GHA-канала — хирургические (ghaDmlViolation ниже).
        const violation = validateStatement(sql, isReadOnly(env));
        if (violation) return json({ error: "forbidden", reason: violation }, 403);
        if (channel === "gha") {
          const ghaViolation = ghaDmlViolation(sql, env);
          if (ghaViolation) return json({ error: "forbidden", reason: ghaViolation }, 403);
        }
        // v2.42.3-FM (CR-C v3): перехватчики FM-движка — ПОСЛЕ валидации, ДО
        // D1: CPU-пожиратели приложения (heal 1970-01-01, fallback-скан
        // GpsPoint) отвечаются из StatsRollup; промах шаблона — fallthrough.
        const fmRes = await fmInterceptQuery(env, sql, Array.isArray(params) ? params : []);
        if (fmRes) return fmRes;
        let stmt = env.DB.prepare(sql);
        if (Array.isArray(params) && params.length > 0) stmt = stmt.bind(...params.map(normParam));
        const res = await stmt.all();
        // v2.40.9 (Pack C §P1-a): учёт расхода в бюджет-метр дня
        budgetTrack(res.meta?.rows_read ?? 0, res.meta?.rows_written ?? 0);
        // v3.6 (CR-G A1-durable): Session-мутация состава (soft-delete/restore/
        // hard-delete) → флаг fm:dirtyScan — day-audit на следующем тике
        // пересчитает ЗАМОРОЖЕННЫЕ суточные строки (удаления старше 7-дневного
        // окна refresh7d больше не оставляют призраков в KPI — дрейф закрыт
        // конструктивно, а не разовым реконсайлом).
        if (FM_ENABLED && fmSessionMutationSql(sql) && ctx && ctx.waitUntil) {
          ctx.waitUntil(fmMarkDirtyScan(env));
        }
        if (ctx && ctx.waitUntil) ctx.waitUntil(flushBudgetPending({}));
        return json({
          rows: bigintSafe(res.results ?? []),
          rowsAffected: res.meta?.changes ?? 0,
          meta: {
            rowsRead: res.meta?.rows_read ?? null,
            rowsWritten: res.meta?.rows_written ?? null,
            durationMs: res.meta?.duration ?? null,
          },
        });
      }

      // v2.39.1 (§B2): KV-кэш и инвалидация — те же гейты (секрет,
      // rate-limit, лимит тела 64 КБ), handler-логика выше по файлу.
      if (url.pathname === "/kvcache") {
        return await handleKvCache(env, body);
      }
      if (url.pathname === "/kvcache/invalidate") {
        return await handleKvInvalidate(env, body);
      }

      // v2.40.9 (Pack C §P0-b): сырой KV-store персистентных артефактов
      // (watermark-кэш heavy-segments, N-7) — те же гейты, handler выше.
      if (url.pathname === "/kvstore/get") {
        return await handleKvStoreGet(env, body);
      }
      if (url.pathname === "/kvstore/put") {
        return await handleKvStorePut(env, body);
      }

      // v2.40.0 (§T-DELTA): ручной запуск мигратора Turso-дельты (шаги
      // ограничены телом {steps:1..40}; {reset:true} — сброс прогресса KV).
      // Гейты те же: секрет шлюза + rate-limit + лимит тела.
      if (url.pathname === "/admin/turso-migrate") {
        if (body && body.reset === true) {
          const state = newTursoState();
          await saveTursoState(env, state);
          return json({ state, reset: true });
        }
        const steps = Math.min(Math.max(Number((body && body.steps) || 1) || 1, 1), 40);
        const result = await runTursoMigrationStep(env, steps);
        return json(result);
      }

      if (url.pathname === "/batch") {
        const { statements } = body ?? {};
        if (!Array.isArray(statements) || statements.length === 0) {
          return json({ error: "statements required" }, 400);
        }
        if (statements.length > 500) {
          return json({ error: "too many statements (max 500 per batch)" }, 400);
        }
        // v2.38.1 (ревью F1): вайтлист операций — ВСЕ стейтменты батча ДО
        // построения prepare-объектов (атомарный batch не начинает исполняться)
        // v2.38.2 (ревью F33): + read-only флаг (один вызов isReadOnly на батч)
        // v3.4 (CR-J): GATEWAY_READ_ONLY — только глобальный флаг; привилегии
        // GHA-канала — хирургические (ghaDmlViolation ниже, по каждому стейтменту).
        const batchReadOnly = isReadOnly(env);
        for (const s of statements) {
          if (typeof s?.sql !== "string" || s.sql.length === 0) {
            return json({ error: "each statement requires non-empty sql" }, 400);
          }
          const violation = validateStatement(s.sql, batchReadOnly);
          if (violation) {
            return json({ error: "forbidden", reason: violation }, 403);
          }
          if (channel === "gha") {
            const ghaViolation = ghaDmlViolation(s.sql, env);
            if (ghaViolation) return json({ error: "forbidden", reason: ghaViolation }, 403);
          }
        }
        const stmts = statements.map((s) => {
          let st = env.DB.prepare(s.sql);
          if (Array.isArray(s.params) && s.params.length > 0) {
            st = st.bind(...s.params.map(normParam));
          }
          return st;
        });
        // env.DB.batch = АТОМАРНАЯ транзакция: либо все стейтменты, либо ничего.
        const results = await env.DB.batch(stmts);
        // v2.40.9 (Pack C §P1-a): бюджет-метр — сумма по стейтментам батча
        for (const r of results) {
          budgetTrack(r.meta?.rows_read ?? 0, r.meta?.rows_written ?? 0);
        }
        // v3.6 (CR-G A1-durable): Session-мутации в составе атомарного батча
        // (DELETE /api/trips/[id] шлёт сессии+поездку одним /batch)
        if (FM_ENABLED && ctx && ctx.waitUntil && statements.some((s) => fmSessionMutationSql(s.sql))) {
          ctx.waitUntil(fmMarkDirtyScan(env));
        }
        if (ctx && ctx.waitUntil) ctx.waitUntil(flushBudgetPending({}));
        return json(results.map((r) => ({
          rows: bigintSafe(r.results ?? []),
          rowsAffected: r.meta?.changes ?? 0,
          meta: {
            rowsRead: r.meta?.rows_read ?? null,
            rowsWritten: r.meta?.rows_written ?? null,
            durationMs: r.meta?.duration ?? null,
          },
        })));
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      // v2.40.9 (Pack C §P1-a/m-20): D1-ошибка квоты — отметка в бюджет-метре
      // (quotaExhaustedAt дня: алерт d1_quota_70/90 и честный /health приложения
      // читают это из /admin/cron-status без единой строки квоты)
      budgetMarkExhausted(String(err?.message ?? err));
      if (ctx && ctx.waitUntil) ctx.waitUntil(flushBudgetPending({ force: true }));
      return json({ error: String(err?.message ?? err), d1: true }, 500);
    }
  },

  // v2.40.0 (§B5): Cron Triggers — планировщик бывших cron-сервисов Render.
  // Каждый тик: разбор расписания → вызов исполнителей приложения (или
  // внутренний шаг мигратора Turso) → запись cron:last:<job> в KV
  // (наблюдаемость через GET /admin/cron-status) + структурный лог.
  // v2.42.3-FM (CR-C v3): на тике первым делом — FM-движок (замороженные
  // суточные метрики StatsRollup, рекон BackupJob, adopt/merge, прогрев tsw;
  // см. блок fm* выше по файлу).
  // v3 (CR-C F1): расписание схлопнуто до ДВУХ триггеров (минутный тик +
  // retention 03:00 UTC): джобы бывшего триггера каждые-5-минут
  // (finalize-sessions, alerts, turso-migrate) запускаются ИЗ ТИКА — на
  // минутах, кратных 5, последовательно, каждый в своём try/catch (цикл run
  // ниже исполняет их по одному за итерацию — как раньше в отдельной
  // инвокации; теперь НЕ будет двойного вызова приложения в одну минуту).
  // Записи cron:last:* и троттлы putCronLastThrottled не изменились —
  // наблюдаемость /admin/cron-status прежняя.
  async scheduled(controller, env, ctx) {
    // v2.40.9 (Pack C §P1-a): флаш бюджета дня (троттл внутри; минутный тик —
    // дожим хвоста после тихих минут)
    __envKV = env.KV ?? null;
    const budgetFlush = flushBudgetPending({ force: true }).catch(() => {});
    // нормализуем ОБЕ стороны (ключи карты и controller.cron): CF может
    // прислать выражение как в канонической форме («* * * * *»), так и
    // дословно («*/1 * * * *») — точное сравнение ненадёжно в обе стороны.
    // v3 (CR-C F1): копия массива — ниже пушим в неё свёрнутые 5-минутные
    // джобы (значения в CRON_SCHEDULES_BY_NORM общие, мутировать нельзя).
    const jobs = [...(CRON_SCHEDULES_BY_NORM.get(normalizeCron(controller.cron)) ?? [])];
    if (jobs.includes("tick") && new Date().getUTCMinutes() % 5 === 0) {
      jobs.push("finalize-sessions", "alerts", "turso-migrate");
    }
    if (jobs.includes("tick")) {
      try {
        const fmOut = await fmEngineTick(env);
        console.log(JSON.stringify({ level: "info", msg: "fm engine tick", today: fmOut.todayRows, froze: fmOut.froze, refresh7d: fmOut.refresh7d, tsw: fmOut.tsw, backupReaped: fmOut.backupReaped, adopted: fmOut.adopted, merged: fmOut.merged, retired: fmOut.retired, silentAudits: fmOut.silentAudits, dayAudit: fmOut.dayAudit, resyncStatsV3: fmOut.resyncStatsV3 })); // v3.6: +dayAudit/+resyncStatsV3
      } catch (e) {
        console.log(JSON.stringify({ level: "warn", msg: "fm engine tick failed", error: String((e && e.message) || e) }));
      }
    }
    const run = (async () => {
      const results = {};
      for (const job of jobs) {
        try {
          if (job === "turso-migrate") {
            const r = await runTursoMigrationStep(env, 1);
            results[job] = {
              ok: r.state.status !== "error",
              state: {
                status: r.state.status,
                phase: r.state.phase,
                stats: r.state.stats,
                blockedCount: r.state.blockedCount,
                lastError: r.state.lastError,
              },
            };
            if (env.KV) {
              // v2.40.5 (M-13): троттлинг записи — см. putCronLastThrottled
              await putCronLastThrottled(env, job, {
                at: new Date().toISOString(), ok: results[job].ok, state: results[job].state
              });
            }
          } else {
            const path = CRON_APP_PATHS[job];
            const timeout = LONG_CRON_JOBS.has(job) ? CRON_BACKUP_TIMEOUT_MS : 60_000;
            const r = await callAppCron(env, path, timeout);
            results[job] = r;
            if (env.KV) {
              // v2.40.5 (M-13): троттлинг записи — см. putCronLastThrottled
              await putCronLastThrottled(env, job, {
                at: new Date().toISOString(),
                ok: r.ok,
                status: r.status ?? null,
                error: r.error ?? null,
              });
            }
          }
        } catch (err) {
          results[job] = { ok: false, error: String((err && err.message) || err) };
        }
      }
      console.log(JSON.stringify({ level: "info", msg: "d1-gateway cron run", cron: controller.cron, jobs, results }));
    })();
    // v2.40.9 (Pack C §P1-a): run + флаш бюджета — ОБА под waitUntil (флаш
    // не должен потеряться при заморозке изолейта сразу после тика)
    ctx.waitUntil(Promise.allSettled([run, budgetFlush]));
  },
};

export default worker;
