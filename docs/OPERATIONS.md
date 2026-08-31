# Operations — алерты (§14.4) и резервное копирование: фактическое состояние

Документ отражает ФАКТИЧЕСКОЕ поведение системы после пакета P2 и расхождения
со спецификацией (актуальная — v2.10.4). Обновлять при изменениях.

## 1. Алерты (спека §14.4) — реализовано в P2-16

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
| `worker_stuck` | pending > 50 в течение 10 мин | серия снапшотов pending, накапливается между оценками cron |

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
4. **Slack-уведомления шлются при каждой оценке с горящими правилами** (каждые
   5 минут cron), дедупликации нет — при желании добавить состояние
   «уведомлён» в `_AlertState`.
5. `PRAGMA page_size`/`page_count` на Turso может быть недоступен — правило
   вернёт `detail: "PRAGMA недоступен…"`, не падая.

## 2. Резервное копирование: фактическое поведение и ограничения restore

Реализовано (`src/lib/backup.ts`, `src/lib/github-backup.ts`, воркер):

- Логический дамп БД в `BackupJob` с checksum и верификацией (§9.8);
  файл в `BACKUP_STORAGE_DIR` (/tmp/backups на Render — **эфемерно**).
- Выгрузка в GitHub Releases (`GITHUB_BACKUP_*` env) — долговременный уровень.
- Ретраи `BACKUP_MAX_ATTEMPTS=3`, интервал `BACKUP_RETRY_INTERVAL_HOURS=1`.
- Cron `backup-cron` создаёт дампы по расписанию (render.yaml).

**Restore (фактическое состояние):**

- `POST /api/admin/restore` — **заглушка**: создаёт задание и отвечает
  `202 "Restore queued. Run scripts/restore-backup.ts manually."`.
  Автоматического восстановления из UI нет.
- Восстановление выполняется **вручную** скриптом restore из дампа BackupJob
  (скачать дамп из BACKUP_STORAGE_DIR или GitHub Release, восстановить в
  Turso/libsql, сверить checksum).
- Требование спеки «restore не чаще 1 раза/час» на уровне API **не
  реализовано** (throttle отсутствует) — актуально только как дисциплина
  ручной операции. Риск блокировки на время restore: БД недоступна для
  записи, ingest в это время вернёт 5xx.
- Дампы в /tmp/backups живут до следующего деплоя/рестарта инстанса —
  единственный долговременный уровень сейчас GitHub Releases.

До доработки restore считать RTO ≈ 30–60 мин (ручная операция), RPO =
интервал backup-cron.

## 3. Метрики /api/metrics (связанное)

- `alert_firing_current` (gauge) — сколько правил горят сейчас;
- `alert_firing_total` (counter) — оценки cron, завершившиеся срабатыванием;
- остальные счётчики — см. `src/lib/metrics.ts` (реестр на globalThis,
  воркер и API делят один экземпляр с P1-10).

## 4. Диагностика канала приёма (ingest) — DIAG-1, v2.10.6

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

Типовые интерпретации L1:

| Что видно | Вывод |
|---|---|
| «попыток приёма не зафиксировано» (алый) | запросы приложения не доходят до сервера — проверить URL/токен в приложении |
| `no_gps` (янтарный) | запрос доходит, но в батче нет location — проверить разрешение геолокации в приложении |
| `dropped_all` (янтарный) | слабый GPS-сигнал, все точки точнее 100 м отброшены |
| `accepted` (сливовый) | канал работает, точки в БД |
