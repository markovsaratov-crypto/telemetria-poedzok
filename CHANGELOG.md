# Changelog

Все заметные изменения сервиса телеметрии poedzok.fun. Формат — близкий к
Keep a Changelog; версии соответствуют /health приложения и шлюза.

## [v2.43.1] — 2026-09-30 (CR-E, ветка ops/gateway-v3-20260930): толерантность консистент-чека бэкапа

### Исправлено
- **`src/lib/backup.ts` (исполняется GHA-раннером из репо через
  `scripts/backup-remote.ts`; деплой воркеров не требуется):** пост-чек
  снапшота `Σ pointCount активных сессий == точки в дампе` падал на
  стабильном историческом дрейфе ±единицы — точки purged/archived-сессий
  остаются в GpsPoint, а Σ pointCount считается только по активным
  (purgedAt IS NULL). GHA-раны 2026-09-30 17:11/17:17 failed при Δ=1
  (97100 vs 97101, телефон offline — не гонка). Теперь расхождение
  ≤ max(10, 0.1% числа точек) → WARN «consistency drift tolerated
  (known purged-session drift)» и дамп продолжается; больше порога —
  fail-closed, как раньше (настоящая гонка инжеста/retention ловится
  ретраями C-2). Workflow `backup.yml` не менялся — плановый запуск
  03:30 UTC возьмёт починенный код из main.

### Операции
- Артефакты раундов в `ops/`: `rollback/d1-gateway-v2-deployed.js`
  (задеплоенный до-v3 бандл для отката), `patches/` (патч-воркер
  аналитики, патченый чанк 2b9wi93rqd8od, FM-engine), `reports/
  2026-09-30/` (cr-b, cr-c, cr-d2-state, worklog-sanitized — все секреты
  заменены на [REDACTED:…]). Деплой-журнал 2026-09-30 — docs/OPERATIONS.md
  §13.

## [gateway v3] — 2026-09-30 (CR-C, ветка ops/gateway-v3-20260930)

Воркер `d1-gateway` (исходник `cloudflare-worker/d1-gateway.js`,
`/health` → `2.43.0`). Подробности и рунбук отката/проверки —
docs/OPERATIONS.md §13.

### Добавлено
- **F0: двойной секрет.** Гейты шлюза принимают ЛЮБОЙ из `GATEWAY_SECRET`
  (основной, secret_text) ИЛИ `GHA_GATEWAY_SECRET` (plain_text, канал
  GitHub Actions). Оба — constant-time (SHA-256). Чинит сломанный GHA-бэкап:
  репо-секрет `D1_GATEWAY_SECRET` протух после ротации основного секрета
  2026-09-29 (401 → 25+ ч без durable-копий). Не задан → проверка
  пропускается.
- **FM-движок замороженных суточных метрик перенесён в исходник репо**
  (до этого существовал только в прод-бандле, раунд frozen-metrics-fix):
  `fmEngineTick` на минутном тике (суточная строка StatsRollup, заморозка
  дня, часовой refresh7d, backfill-once), SQL-перехватчики в `/query`
  (heal 1970-01-01 нейтрализован, KPI-счётчики из rollup), рекон stuck
  BackupJob (>2 ч running → failed), прогрев tsw — пересчёт «старых»
  поездок самим приложением (`GET /api/trips/batch?ids=`).
- **F2: fmAdoptOrphans** — усыновление сессий-сирот (born-completed через
  /ingest-порт, tripId IS NULL, pointCount ≥ 3): attach к пересекающейся
  по времени поездке или create новой; метрики NULL → tsw пересчитает;
  TrafficJob ensure-INSERT как у приложения. Мусор 1–2-точечных парковочных
  сердцебиений не трогается.
- **F3: fmMergeUndercut** — слияние «недосклеенных» кусков Trip (гэп <
  TRIP_SPLIT_SEC = 900 с), ≤2 пары за прогон, проверка реального гэпа по
  сессиям (сырьё, не span), keeper = ранний, b — жёсткий DELETE как в
  recomputeTripsForDevice; сырые Session/GpsPoint не трогаются.

### Изменено
- **F1: схлопывание расписаний** — триггеры `*/1` (tick) + `0 3`
  (retention); джобы `finalize-sessions`/`alerts`/`turso-migrate` (бывший
  `*/5`) запускаются ИЗ тика на минутах %5===0 — последовательно, каждый в
  своём try/catch (закрывает двойной вызов приложения в одну минуту).
- wrangler.toml: [triggers] 2 крона; задокументирован plain_text-биндинг
  `GHA_GATEWAY_SECRET` (значение не хранится в репо).
- Лог «fm engine tick» дополнен полями `adopted`/`merged`.

### Удалено
- Крон-записи `30 3 * * *` (backup) и `0 4 * * SUN` (backup-github) из
  CRON_SCHEDULES: полный дамп на воркере невозможен (CPU 1102, §12
  OPERATIONS.md) — бэкап живёт ТОЛЬКО в GitHub Actions (03:30 UTC).
  KV-ключи `cron:last:backup*` сохранены для наблюдаемости истории.

### Исправлено
- Пустые `catch {}` → `console.warn` с контекстом (readBodyLimited
  reader.cancel, putCronLastThrottled parse).

## [v2.42.2] — 2026-09-25

- Эвакуация с Render (§11-12 OPERATIONS.md): бэкапы в GitHub Actions
  (workflow backup.yml), fs-толерантность бэкапа/restore на edge-рантайме,
  ротация секрета шлюза, фикс консистентности снапшот-чека.

## [v2.42.1] — 2026-09-2x

- Pack C доводки шлюза (квота-бюджет, точечная инвалидация кэша,
  персистентные KV-артефакты, edge-телефон SensorLogger).

## [v2.42.0] — 2026-09-xx

- «Вариант 1»: расчётные снапшоты TripCalc финальных записей (>24 ч);
  ALLOWED_TABLES/CREATE-регексы шлюза расширены.

(Более ранняя история — по git log; версионирование начинается с v2.37.0
— миграция Turso → D1.)
