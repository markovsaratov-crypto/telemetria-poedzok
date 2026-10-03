# CR-C — Реализация gateway v3 (F0-F3) в исходниках репо

- Дата: 2026-09-30 (песочница), агент CR-C (кодер).
- Прод НЕ тронут: 0 деплоев / 0 пушей / 0 SQL-записей. Только исходники репо + локальная сборка артефакта.
- Репо: `/tmp/tel-repo`, ветка **`ops/gateway-v3-20260930`**, коммит **`4b4b094`** (main @ 969d965 — родитель). `.git/config` CLEAN (PAT не записан, проверено grep).
- Артефакт деплоя: **`/home/z/my-project/download/telemat-cr/gateway-v3.js`** (esbuild-бандл 99 КБ, ESM, ingest-port.js инлайн — структура как у задеплоенного patched-d1-gateway.js).

---

## 1. Изменённые файлы (коммит 4b4b094: 4 файла, +941/−24)

| Файл | Что сделано |
|---|---|
| `cloudflare-worker/d1-gateway.js` (1389 → 2115 строк) | **Главный файл.** (а) шапка-заголовок v3 (версия/дата/список изменений F0-F3); (б) **F0** — новый хелпер `gatewaySecretOk()` (двойной секрет, оба constant-time через `secretEquals`) + оба гейта (GET /admin/*, основной POST-гейт) переведены на него; (в) **F1** — `CRON_SCHEDULES` сокращён до 2 записей (`*/1`→tick, `0 3`→retention; backup/backup-github/`*/5` удалены), в `scheduled()` — копия массива jobs + пуш `finalize-sessions`/`alerts`/`turso-migrate` на минутах `getUTCMinutes()%5===0` (последовательно, каждый в своём try/catch — цикл run не менялся); (г) **порт FM-движка** из прод-бандла (см. §2) + врезка `fmInterceptQuery` в `/query` после `validateStatement`, вызов `fmEngineTick` в `scheduled()` до джобов, лог «fm engine tick» дополнен `adopted`/`merged`; (д) **F2** `fmAdoptOrphans` + **F3** `fmMergeUndercut`/`fmSessionBound` (в %5-блоке fmEngineTick); (е) пустые `catch {}` (2 шт: `reader.cancel`, parse cron:last) → `console.warn` с контекстом; (ж) `/health` version `2.42.0`→`2.43.0`; (з) import `rollupDayKey` из `./ingest-port.js` (нужен FM-движку). |
| `cloudflare-worker/wrangler.toml` | `[triggers] crons` → 2 записи с комментарием-обоснованием (что убрано и почему; прежние 5 перечислены для отката); блок-документация `GHA_GATEWAY_SECRET` (plain_text-плейсхолдер-комментарий: значение генерируется при деплое, в репо НЕ хранится; пример `openssl rand -base64 32 \| tr -dc 'A-Za-z0-9'`). |
| `docs/OPERATIONS.md` | + §13 «Gateway v3 (2026-09-30)»: что изменено (6 пунктов), как откатиться (PUT `download/telemat-fm/patched-d1-gateway.js` + PUT 5 старых расписаний; восстановление данных — backfill-trips; журнал fm:adopt/fm:merge), как проверить (health/settings/schedules, KV cron:last:*, SQL-счётчики сирот/пар, GHA dispatch). |
| `CHANGELOG.md` (новый) | Запись [gateway v3] — 2026-09-30 (CR-C): Added/Changed/Removed/Fixed + краткие версии истории (v2.42.x, ссылки на git log). |

Не тронуты: `ingest-port.js` (его `GATEWAY_SECRET`-accept — только для /ingest-канала приложения, у GHA свой путь /query+/batch; своя авторизация INGEST_TOKEN не менялась), весь `src/`, `scripts/`, `prisma/`, workflows, тесты.

## 2. Аудит-подтверждение ПОЛНОГО переноса FM-движка

Метод: извлечение тел функций из задеплоенного `download/telemat-fm/patched-d1-gateway.js` (бандл :1706-1948) и нового исходника, нормализация (комментарии/`__name`/пробелы/числовые литералы `648e5`↔`64800000` и т.п.), посимвольный diff.

| FM-функция | Задеплоено | В v3 | Вердикт |
|---|---|---|---|
| `FM_ENABLED` | :1706 | да | значение `true` — то же |
| `fmNextDayKey` | :1707 | да | **IDENTICAL** |
| `fmParseStatsCache` | :1711 | да | **IDENTICAL** |
| `fmRollupUpserts` | :1731 | да | идентично (только хвостовая запятая в массиве args — косметика) |
| `fmSessionsInRange` | :1747 | да | **IDENTICAL** |
| `fmComputeDays` | :1752 | да | **IDENTICAL** |
| `fmWriteDayRows` | :1777 | да | **IDENTICAL** (после нормализации `/* @__PURE__ */ new Date()`) |
| `fmBackfillOnce` | :1788 | да | **IDENTICAL** |
| `fmEngineTick` | :1808 | да | семантика 1:1 + РОВНО три осознанных добавления v3: (1) `out` дополнен `adopted:0, merged:0`; (2) два пустых `catch {}` (BackupJob-рекон :1870, tsw-прогрев :1900) теперь логируют `console.warn` (требование «мелочи»); (3) новые try/catch-шаги `fmAdoptOrphans`/`fmMergeUndercut` (F2/F3). Числа-константы сохранены точно: `64800000`, `86400000`, `1262304e6` (= 2010-01-01, нижний кламп заморозки — сверено с бандлом `1262304e6`), `7200000`, `21600000`, `3600000`, TTL `21600`, таймаут tsw `30000`. |
| `fmScopeClause` | :1906 | да | **IDENTICAL** |
| `fmInterceptQuery` | :1912 | да | **IDENTICAL** (4 шаблона Q1-Q4 дословно: heal-kill 1970→пустой ответ, sessionScopeCounters, totalSessions, total-points — все с `budgetTrack` и meta.fm-метками) |
| Врезка `/query` | :2006-2007 | да | та же позиция: после `validateStatement`, до `prepare`; `if (fmRes) return fmRes` |
| Врезка `scheduled()` | :2101-2108 | да | `jobs.includes("tick")` → `await fmEngineTick(env)` + структурный лог; сбой — warn-лог, не роняет тик |
| `rollupDayKey` | импорт бандла из ingest-port | да | импортирован из `./ingest-port.js` (экспорт существует, :216 ingest-port.js) |

Прочие не-FM-функции шлюза не менялись (diff исходника с main — только описанные блоки; функции ingest/kvcache/turso/budget — нетронуты).

## 3. Ключевые фрагменты нового кода

### F0 — dual secret (d1-gateway.js, после secretEquals)
```js
async function gatewaySecretOk(env, presented) {
  const s = typeof presented === "string" ? presented : "";
  const hasPrimary = typeof env.GATEWAY_SECRET === "string" && env.GATEWAY_SECRET.length > 0;
  const hasGha = typeof env.GHA_GATEWAY_SECRET === "string" && env.GHA_GATEWAY_SECRET.length > 0;
  if (!hasPrimary && !hasGha) return false;
  if (hasPrimary && (await secretEquals(s, env.GATEWAY_SECRET))) return true;
  if (hasGha && (await secretEquals(s, env.GHA_GATEWAY_SECRET))) return true;
  return false;
}
// оба гейта:
if (!(await gatewaySecretOk(env, request.headers.get("x-gateway-secret") ?? ""))) return json({ error: "unauthorized" }, 401);
```
GHA-канал подтверждён по исходникам: `scripts/backup-remote.ts` → `src/lib/github-backup.ts` → `src/lib/db-d1.ts` `createD1Client()` — заголовок **`x-gateway-secret`** со значением env `D1_GATEWAY_SECRET` (репо-секрет), эндпоинты **POST /query и POST /batch** — оба за основным POST-гейтом. Не задан/пуст → вторая проверка пропускается; ни один не задан → гейт закрыт.

### F1 — CRON_SCHEDULES + свёртка в scheduled()
```js
const CRON_SCHEDULES = {
  "*/1 * * * *": ["tick"],
  "0 3 * * *": ["retention"],
};
// scheduled():
const jobs = [...(CRON_SCHEDULES_BY_NORM.get(normalizeCron(controller.cron)) ?? [])];
if (jobs.includes("tick") && new Date().getUTCMinutes() % 5 === 0) {
  jobs.push("finalize-sessions", "alerts", "turso-migrate");
}
if (jobs.includes("tick")) {
  try {
    const fmOut = await fmEngineTick(env);
    console.log(JSON.stringify({ level: "info", msg: "fm engine tick", today: fmOut.todayRows, froze: fmOut.froze,
      refresh7d: fmOut.refresh7d, tsw: fmOut.tsw, backupReaped: fmOut.backupReaped, adopted: fmOut.adopted, merged: fmOut.merged }));
  } catch (e) { console.log(JSON.stringify({ level: "warn", msg: "fm engine tick failed", error: String((e && e.message) || e) })); }
}
```
Копия массива обязательна (значения Map — общие). Джобы исполняет НЕизменённый цикл `run` (последовательно, каждый в своём try/catch, `putCronLastThrottled` сохранён — cron:last:* наблюдаемость прежняя). Обратная совместимость матчинга: `CRON_SCHEDULES_BY_NORM` строится из новой таблицы — консистентно; `CRON_APP_PATHS`/`CRON_ALL_JOBS` НЕ менялись (backup-ключи читаются в /admin/cron-status для истории).

### F2 — fmAdoptOrphans (в %5-блоке fmEngineTick, ≤3 сессии)
```js
async function fmAdoptOrphans(env, now, out) {
  const orphans = await env.DB.prepare(
    `SELECT id, deviceId, userId, startTime, endTime, pointCount FROM Session
      WHERE tripId IS NULL AND status = 'completed' AND deletedAt IS NULL AND pointCount >= 3
      ORDER BY startTime ASC LIMIT 3`).all();
  for (const s of orphans.results ?? []) {
    // ... parse start/end → ISO
    const cands = await env.DB.prepare(
      `SELECT id, sessionIds, sessionCount, spanStart, spanEnd, startTime, endTime, userId FROM Trip
        WHERE deviceId = ? AND deletedAt IS NULL
          AND datetime(spanEnd) >= datetime(?) AND datetime(spanStart) <= datetime(?)
        ORDER BY datetime(spanStart) ASC LIMIT 5`).bind(deviceId, startIso, endIso).all();
    // кандидат с МАКСИМАЛЬНЫМ перекрытием (JS-расчёт);
    // attach  → batch: UPDATE Trip (sessionIds=объединение, sessionCount, spanStart=min, spanEnd=max,
    //           метрики/statsComputedAt=NULL — список инвалидации как у приложения) +
    //           UPDATE Session SET tripId + TrafficJob ensure-INSERT (копия trip-grouping.ts:481) +
    //           trafficJobId COALESCE;
    // create  → batch: INSERT Trip (id, deviceId, userId, 'completed', startTime=endTime=startIso..endIso,
    //           spanStart/spanEnd, startLat/Lon/endLat/Lon из первого/последнего GpsPoint по индексу
    //           (sessionId,timestamp), sessionIds=[sid], sessionCount=1, interFragmentGapSec=0,
    //           pointCountActual=pointCount, statsComputedAt=NULL, createdAt/updatedAt) +
    //           UPDATE Session SET tripId + TrafficJob ensure-INSERT + trafficJobId COALESCE;
    // лог: {t:'fm:adopt', sessionId, tripId, mode:'attach'|'create'}
  }
}
```

### F3 — fmMergeUndercut (тот же %5-блок, ≤2 пары)
```js
const pairs = await env.DB.prepare(
  `SELECT a.id AS idA, b.id AS idB, a.sessionIds AS idsA, b.sessionIds AS idsB, ...,
          CAST((julianday(datetime(b.spanStart)) - julianday(datetime(a.spanEnd))) * 86400000 AS INTEGER) AS gapMs
     FROM Trip a JOIN Trip b ON a.deviceId = b.deviceId AND a.id <> b.id
       AND datetime(a.spanStart) < datetime(b.spanStart)          -- дедуб a-b/b-a, a=ранний
       AND datetime(b.spanStart) >= datetime(a.spanEnd)
       AND datetime(b.spanStart) < datetime(a.spanEnd, '+900 seconds')
    WHERE a.deletedAt IS NULL AND b.deletedAt IS NULL
    ORDER BY datetime(a.spanEnd) ASC LIMIT 2`).all();
// ПЕРЕД слиянием: fmSessionBound(idsA,'MAX(endTime)') vs fmSessionBound(idsB,'MIN(startTime)')
// (чанки ≤90 id — лимит параметров D1; deletedAt IS NULL): realGap >= 900000 →
// console.log {t:'fm:merge:skip', reason:'session-gap >= 900s'} + continue;
// сбой проверки → warn + continue (консервативно);
// слияние (ОДИН атомарный batch):
//   UPDATE Trip a: startTime=min, endTime=max, spanStart=min, spanEnd=max, sessionIds=объединение,
//                  sessionCount=|объ|, userId=COALESCE(a,b), метрики/statsComputedAt=NULL, updatedAt
//   UPDATE Session SET tripId=a WHERE tripId=b
//   DELETE FROM TrafficJob WHERE tripId=b AND status IN ('pending','running')   -- как у приложения
//   INSERT TrafficJob ensure (a) + trafficJobId COALESCE (a)                     -- переочередь плана
//   DELETE FROM Trip WHERE id = b                                                -- как recomputeTripsForDevice
// лог: {t:'fm:merge', tripA, tripB, gapMs}
```

## 4. Верификация кода (все пройдены)

- `node --check` — исходник `/tmp/tel-repo/cloudflare-worker/d1-gateway.js` **OK**; бандл `download/telemat-cr/gateway-v3.js` **OK**.
- `npx eslint cloudflare-worker/d1-gateway.js` — **0 ошибок** (exit 0).
- `npx tsc --noEmit` + `npx tsc --noEmit -p tsconfig.test.json` — **0 ошибок** (как в ci.yml).
- **`npx vitest run` — 22 файла / 299 тестов PASS** (включая `tests/kvcache-server.test.ts`, который импортирует d1-gateway.js напрямую — 28/28). Чужие импорты не сломаны: единственный import исходника — `./ingest-port.js` (3 имени: handleEdgeIngest, handleEdgeSensorLogger, rollupDayKey — все экспортированы); бандл самодостаточен (esbuild, ingest-port инлайн, `export default`).
- diff-аудит FM — §2 выше.
- Сборка артефакта: `esbuild cloudflare-worker/d1-gateway.js --bundle --format=esm --platform=neutral --target=es2022` → `/home/z/my-project/download/telemat-cr/gateway-v3.js` (99.1 КБ). В бандле проверено: CRON_SCHEDULES = 2 записи; `getUTCMinutes() % 5 === 0` ×2 (FM-блок + scheduled); GHA_GATEWAY_SECRET в gatewaySecretOk; fm:adopt/fm:merge логи; export default на месте.

## 5. Отклонения от плана (с обоснованием)

1. **F3, удаление b: ЖЁСТКИЙ `DELETE FROM Trip` (не мягкая tombstone из плана CR-B).** Задача прямо требовала «сверь с тем, как удаляет recomputeTripsForDevice … и сделай так же» — приложение делает `DELETE FROM Trip WHERE id = ?` (trip-grouping.ts:507) + `DELETE FROM TrafficJob … pending/running`. Выполнено в точности. Безопасность эквивалентна tombstone: Trip — ПРОИЗВОДНАЯ сущность, сырые Session/GpsPoint не трогаются; ошибочное слияние обратимо каноническим `POST /api/admin/backfill-trips` (пересобирает поездки из точек). Пары с логируются (`fm:merge` tripA/tripB/gapMs).
2. **F2, обнуление метрик: расширенный список.** Задача требовала только `statsComputedAt = NULL`; я обнуляю полный список инвалидации приложения (compositionChanged в trip-grouping.ts:437: distanceM/movingTimeSec/…/planCoverage/routingLegCount + statsComputedAt). Обоснование: паритет с приложением (оно NULL-ит все метрики при изменении состава) + до пересчёта tsw UI не показывает СТАРЫЕ метрики нового состава. `pointCountActual` в attach NULL-ится, в create = pointCount сессии (как в задаче).
3. **F2, кандидаты attach: добавлены `deletedAt IS NULL` и выбор по максимальному перекрытию.** Задача задала только условие пересечения; фильтр удалённых поездок необходим (иначе сироты прицепятся к tombstone и станут невидимы), выбор из нескольких пересекающихся — детерминированный max-overlap.
4. **F3, endTime/startTime keeper: обновляются (min/max), userId = COALESCE(a,b).** Задача упоминала только spanEnd/sessionIds/sessionCount; расширение семантически корректно (b позже a — окно движения должно охватить оба) и не противоречит канону.
5. **TrafficJob: применён ensure-INSERT (не UPDATE-requeue).** Задача просила «повтори тот же INSERT» — INSERT приложения (trip-grouping.ts:481/closeStaleTrips:635) самодостаточен: при живом pending/running — no-op, при completed/dead/failed/отсутствии — создаёт НОВЫЙ pending-джоб = переочередь. Таки «простая и однозначная» схема — выполнено; отдельный UPDATE-requeue приложения не потребовался.
6. **CRON_SCHEDULES: записи backup убраны полностью (без dead-safe, как предлагал CR-B).** Прямое требование задачи. Наблюдаемость истории сохранена через CRON_APP_PATHS/CRON_ALL_JOBS (KV-ключи cron:last:backup* читаются в /admin/cron-status). Откат расписаний — PUT старых 5 (рунбук §13).
7. **`/health` version = `2.43.0`** (маркер деплоя v3; был 2.42.0 в исходнике / 2.42.1 в прод-бандле).
8. Добавлены 2 SQL-запроса на create-сироту (первый/последний GpsPoint для координат startLat/Lon/endLat/Lon) — сверх минимального списка колонок задачи, для паритета с INSERT приложения; колонки nullable, сбой lookup → NULL (не блокирует).

## 6. ДЕПЛОЙ-ИНСТРУКЦИЯ (следующему агенту; прод сейчас НЕ тронут)

Контексты: аккаунт CF `b8e4eee2f19ba22f8d9ccce80691e719`; CF API-токен в песочнице `.cloudflare/dns-token.txt` ([REDACTED:CF_TOKEN]; права Workers Scripts/KV/Schedules — D1 REST закрыт, не нужен); воркер `d1-gateway`; БД D1 `9dec0a90-7d38-46ae-9921-29eb83706b3d`; KV `be49735094b14ad3a41e053c4b1cd308`; GitHub PAT для репо-секретов — из карточки задачи ([REDACTED:GITHUB_PAT], только в askpass/заголовке, НЕ на диск). Артефакт: `/home/z/my-project/download/telemat-cr/gateway-v3.js`. <!-- # public-placeholder: публичные ID аккаунта/БД/KV/DNS, не секреты -->

### Шаг 0. Прекомпьютер-проверка (read-only)
```bash
ACC=b8e4eee2f19ba22f8d9ccce80691e719
CF=$(cat /home/z/my-project/.cloudflare/dns-token.txt)   # проверить способ доступа к токену
curl -s -H "Authorization: Bearer $CF" https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/d1-gateway/settings \
  | python3 -m json.tool | less     # зафиксировать ТЕКУЩИЙ список биндингов (12: 5 secret + 5 text + DB + KV)
curl -s -H "Authorization: Bearer $CF" https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/d1-gateway/schedules
```
Биндинги бери ИЗ ЭТОГО ответа (истина прода); ожидаемо text: `APP_ORIGIN=https://poedzok.fun`, `EDGE_INGEST_MAX_BYTES=1048576`, `EDGE_INGEST_ROLLUP_ENABLED=true`, `TELEMAT_TIMEZONE=Europe/Saratov`, `TURSO_URL=https://tele-markovsaratov-crypto.aws-ap-south-1.turso.io`; secret: GATEWAY_SECRET, INGEST_TOKEN, CRON_SECRET, SESSION_SECRET, TURSO_AUTH_TOKEN (+ возможные прочие — сохранить).

### Шаг 1. Сгенерировать GHA-секрет S
```bash
S=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9'); echo "len=${#S}"   # ~43 символа base62
echo -n "$S" | sha256sum   # сохранить хэш для сверки (сам S — в переменной сессии, не на диск)
```

### Шаг 2. Обновить репо-секрет D1_GATEWAY_SECRET = S (GitHub API + libsodium)
```bash
cd /tmp && bun add libsodium-wrappers   # если ещё нет
GH_PAT='[REDACTED:GITHUB_PAT]'   # из карточки задачи; в команде — через env, НЕ писать в файлы
KEY_JSON=$(curl -s -H "Authorization: Bearer $GH_PAT" \
  https://api.github.com/repos/markovsaratov-crypto/telemetria-poedzok/actions/secrets/public-key)
# key_id из KEY_JSON (на 09-30 был 3380204578043523366 — сверить свежий)
S=$S bun -e '
import sodium from "libsodium-wrappers"; await sodium.ready;
const pk = sodium.from_base64(process.env.PK);
const sealed = sodium.crypto_box_seal(sodium.from_string(process.env.S), pk);
console.log(sodium.to_base64(sealed));'   # PK = key из KEY_JSON (передать через env)
curl -s -X PUT -H "Authorization: Bearer $GH_PAT" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/markovsaratov-crypto/telemetria-poedzok/actions/secrets/D1_GATEWAY_SECRET \
  -d "{\"encrypted_value\":\"$ENC\",\"key_id\":\"$KEY_ID\"}"   # ожидать HTTP 201/204
```
(Рецепт проверен раундом CR-B, /tmp/nacl-test.)

### Шаг 3. PUT воркера v3 (multipart, keep_secrets, ЯВНЫЕ не-секретные биндинги + НОВЫЙ GHA_GATEWAY_SECRET)
```bash
# metadata.json:
cat > /tmp/meta.json <<EOF
{"main_module":"gateway-v3.js","compatibility_date":"2026-09-01","keep_secrets":true,
 "bindings":[
  {"type":"plain_text","name":"APP_ORIGIN","text":"https://poedzok.fun"},
  {"type":"plain_text","name":"EDGE_INGEST_MAX_BYTES","text":"1048576"},
  {"type":"plain_text","name":"EDGE_INGEST_ROLLUP_ENABLED","text":"true"},
  {"type":"plain_text","name":"TELEMAT_TIMEZONE","text":"Europe/Saratov"},
  {"type":"plain_text","name":"TURSO_URL","text":"https://tele-markovsaratov-crypto.aws-ap-south-1.turso.io"},
  {"type":"plain_text","name":"GHA_GATEWAY_SECRET","text":"$S"},
  {"type":"d1","name":"DB","id":"9dec0a90-7d38-46ae-9921-29eb83706b3d"},
  {"type":"kv_namespace","name":"KV","namespace_id":"be49735094b14ad3a41e053c4b1cd308"}
 ]}
EOF
# значения text-биндингов СВЕРИТЬ со settings из шага 0 (если отличаются — брать прод);
curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/d1-gateway" \
  -H "Authorization: Bearer $CF" \
  -F 'metadata=@/tmp/meta.json;type=application/json' \
  -F 'gateway-v3.js=@/home/z/my-project/download/telemat-cr/gateway-v3.js;type=application/javascript+module'
# сразу после: rm /tmp/meta.json  (в нём S!)
```
`keep_secrets=true` наследует 5 secret-биндингов от текущего деплоя (метод проверен раундом frozen-metrics-fix). НЕ задевать telemat-web (мина секретов, worklog:437).

### Шаг 4. PUT расписаний (атомарно, одним вызовом)
```bash
curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/d1-gateway/schedules" \
  -H "Authorization: Bearer $CF" -H "Content-Type: application/json" \
  -d '{"schedules":[{"cron":"*/1 * * * *"},{"cron":"0 3 * * *"}]}'
```

### Шаг 5. Проверка GHA-бэкапа
```bash
curl -s -X POST -H "Authorization: Bearer $GH_PAT" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/markovsaratov-crypto/telemetria-poedzok/actions/workflows/backup.yml/dispatches \
  -d '{"ref":"main"}'    # HTTP 204
# следить:
curl -s -H "Authorization: Bearer $GH_PAT" \
  "https://api.github.com/repos/markovsaratov-crypto/telemetria-poedzok/actions/runs?event=workflow_dispatch&per_page=3"
# успех = шаг "Run backup" содержит «=== БЭКАП ГОТОВ ===»; далее проверить draft-релиз
# backup-2026-09-30-* и BackupJob completed (~68 МБ) в БД.
```

### Критерии успеха (все обязательны)
1. `GET /health` шлюза → `{"ok":true,"gateway":"d1","db":"bound","version":"2.43.0"}`.
2. settings → 13 биндингов (было 12; +GHA_GATEWAY_SECRET plain_text; 5 секретов на месте).
3. schedules → ровно 2 записи.
4. Через 1-2 мин: KV `cron:last:tick` ok (свежая at); через ≤6 мин: `cron:last:finalize-sessions` / `alerts` / `turso-migrate` ok (теперь пишутся ИЗ тика — at обновляется каждые ~5 мин).
5. GHA dispatch run → success; релиз backup-*; BackupJob completed ~68 МБ (новый, от GHA).
6. SQL (read-only, напр. через audit-воркер /q): `SELECT count(*) FROM Session WHERE tripId IS NULL AND status='completed' AND pointCount>=3` — уменьшение (движок ≤3/тик с минуты, кратной 5); запрос пар кусков (§13) → 0 или стабильные skip-пары (fm:merge:skip в логах — session-gap ≥ 900 c).
7. GraphQL workersInvocationsAdaptive: d1-gateway errors = 0; telemat-web ошибок не больше базовой линии.

### Откат
1. Код: `PUT /workers/scripts/d1-gateway` с `download/telemat-fm/patched-d1-gateway.js` тем же методом (keep_secrets + те же явные биндинги; GHA_GATEWAY_SECRET можно сохранить — до-v3 код его игнорирует; приложение работает со старым GATEWAY_SECRET — не трогаем).
2. Расписания: PUT обратно `["*/1 * * * *","*/5 * * * *","0 3 * * *","30 3 * * *","0 4 * * SUN"]` (замечание: 30 3/0 4 SUN на до-v3 коде снова падают 1102/530 — это известное до-v3 поведение, §12).
3. Данные adopt/merge: кодом не обратимы — при ошибочном слиянии `POST /api/admin/backfill-trips` (канонический пересчёт из точек; восстановит и слитые b-поездки). Журнал — логи `fm:adopt`/`fm:merge`.
4. GHA при откате кода: снова 401 (секрет репо = S, воркер его уже не знает) — вернуть репо-секрет на старое значение или оставить v3-код.

## 7. Артефакты

- `/home/z/my-project/download/telemat-cr/gateway-v3.js` — деплой-артефакт (бандл).
- `/home/z/my-project/tmp-scripts/cr-c-work/` — рабочие копии изменённых файлов (для чтения инструментами песочницы).
- `/tmp/tel-repo` — клон на ветке `ops/gateway-v3-20260930` @ 4b4b094 (esbuild установлен как devDep, package.json/bun.lock ОТКАЧЕНЫ к исходным — рабочий каталог чист).
