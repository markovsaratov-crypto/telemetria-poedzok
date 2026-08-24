# Task ID: 5b — Frontend UI builder (RETRY)

## Agent
Frontend UI builder (subagent, retry run).

## Task
Retry Task 5b: повторная проверка и доводка Frontend. Предыдущий заход (см. `/agent-ctx/5b-frontend-ui-builder.md`) собрал все 18 файлов и сообщил о прохождении lint + E2E. Цель retry — убедиться, что система действительно работает end-to-end, исправить найденные runtime-баги, не закрывать глаза на расхождения контрактов API ↔ Frontend.

## Work Log

### 1. Аудит существующего состояния
- Прочитан `worklog.md` (полный контекст API контрактов, решений по блокерам, предыдущая Stage Summary Task 5b).
- Прочитан `dev.log` — единственная ошибка: `"Worker poll error" ... "Do not know how to serialize a BigInt"` → `POST /api/worker/poll 500`. Этот баг блокирует обработку TrafficJob, фронт видит "Пробки: В очереди / Обработка" бесконечно.
- Проверены все 18 frontend-файлов (line counts 39–352) — все на месте, синтаксически валидны.
- Проверены все backend API routes — `/api/sessions`, `/api/sessions/[id]`, `/api/audit`, `/api/admin/{backup,requeue}`, `/api/metrics`, `/api/plan`, `/api/sessions/[id]/export`, `/api/import/csv`, `/health` — все возвращают корректные JSON.

### 2. Найденные runtime-баги и фиксы

#### Bug #1: BigInt serialization в `/api/worker/poll` (блокер E2E)
**Симптом**: dev.log показывает `POST /api/worker/poll 500` с ошибкой `"Do not know how to serialize a BigInt"`. Worker не может забрать pending TrafficJob → ни одна сессия не получает traffic-результат → на фронтенде "Пробки: В очереди" навсегда.

**Причина**: Prisma-схема `GpsPoint.timestamp BigInt` (мс, нормализованные). Route `/api/worker/poll` делал `db.trafficJob.findMany({ include: { session: { select: { gpsPoints: { orderBy: { timestamp: "asc" } } } } } })` — доставал все поля GpsPoint включая BigInt timestamp, после чего `NextResponse.json()` падал (JSON.stringify не умеет BigInt).

**Фикс** (`src/app/api/worker/poll/route.ts`):
- Добавлен `select` внутри `gpsPoints` — берём только нужные поля: `lat, lon, speed, altitude, accuracy, bearing, timestamp`.
- После findMany — `jobs.map(j => ({ ...j, session: { ...j.session, gpsPoints: j.session.gpsPoints.map(p => ({ ...p, timestamp: Number(p.timestamp) })) } }))`.
- Аналогично тому, как это делает `/api/sessions/[id]` (см. `points: session.gpsPoints.map((p) => ({ ..., timestamp: Number(p.timestamp) }))`).

**Проверка**: `POST /api/worker/poll` → 200 `{"jobs":[]}` (без pending), после инжеста новой сессии worker корректно забирает job, обрабатывает, сессия получает `traffic: { status: "completed", provider: "osrm", distanceM: ..., durationSec: ..., segments: [...] }`.

#### Bug #2: Несоответствие полей PlanResponse в route-planner.tsx
**Симптом**: после `POST /api/plan` фронт показывал "Дистанция: —", "Время: —", а полилиния маршрута рисовалась как прямая от старта к финишу (а не реальный маршрут от OSRM/2ГИС).

**Причина**: API возвращает `{ route: { provider, distanceM, durationSec, polyline: [[lat, lon], ...], segments, trafficFetched } }`. Фронтенд-тип `PlanResponse` и `route-planner.tsx` использовали **другие** имена: `distance`, `duration`, `geometry`.

**Фикс**:
- `src/lib/api-client.ts`: `PlanResponse.route` теперь содержит и канонические имена (`distanceM`, `durationSec`, `polyline`, `segments`, `cached`, `trafficFetched`, `trafficUtc`), и алиасы (`distance`, `duration`, `geometry`) для обратной совместимости.
- `src/components/route-planner.tsx`: 
  - `result` стейт типизирован через `PlanResponse`.
  - `routePolyline` теперь проверяет `r.polyline || r.geometry || r.segments` — берёт первое доступное.
  - В блоке результата используется `distance = r.distanceM ?? r.distance` и `duration = r.durationSec ?? r.duration`.

**Проверка**: `POST /api/plan` с `(55.751, 37.617) → (55.760, 37.630)` возвращает `{ route: { provider: "haversine", distanceM: 1289.65, durationSec: 116, polyline: [[55.751, 37.617], [55.76, 37.63]] } }`. Фронт корректно отрисует "1.29 км", "2 мин", "haversine".

### 3. E2E проверка (curl)
Все запросы идут с cookie `telem_session` после `POST /api/auth/login`:

| Endpoint | Method | Status | Примечание |
|----------|--------|--------|------------|
| `/api/auth/login` | POST | 200 | `{ sessionId, expiresAt, authenticated: true }` + Set-Cookie |
| `/api/auth/me` | GET | 200 | `{ authenticated: true, expiresAt }` |
| `/api/sessions?limit=5` | GET | 200 | `{ sessions: [...2 items], nextCursor: null }` |
| `/api/sessions/[id]` | GET | 200 | Детали с `points[]` (BigInt → Number), `traffic: { provider: "osrm", ... }` |
| `/api/routes` | GET | 200 | `{ routes: [] }` (пусто, ожидаемо) |
| `/api/plan` | POST | 202 | `{ route: { provider: "haversine", distanceM, durationSec, polyline, segments }, cached: false }` |
| `/api/sessions/[id]/export` | POST | 200 | `{ url: "data:application/gpx+xml;base64,...", filename, format, size }` |
| `/api/audit?limit=10` | GET | 200 | `{ logs: [session.export entry], nextCursor: null }` |
| `/api/admin/backup` | GET | 200 | `{ backups: [] }` |
| `/api/admin/requeue` | POST | 400 | `{ error: "Job is not in dead/failed state" }` (ожидаемо — job уже completed) |
| `/api/metrics` | GET | 200 | Prometheus text exposition (13+ метрик) |
| `/health` | GET | 200 | `{ status: "ok", db: "ok", worker: "ok", version: "2.6.0", uptime, ... }` |

### 4. Финальная проверка
- `bun run lint` — ✅ 0 errors, 0 warnings.
- `curl http://localhost:3000/` — ✅ HTTP 200, 28KB, HTML содержит:
  - `<title>Телеметрия поездок — v2.6</title>`
  - `<meta name="description" content="Платформа ingestion и анализа GPS-телеметрии поездок...">`
  - Карточка логина: иконка Activity, "Телеметрия поездок", "Войдите для доступа к панели управления. v2.6", поле "Пароль" с eye-toggle, кнопка "Войти", "Single-user модель · защищено timing-safe сравнением · HMAC cookie".
- `dev.log` после фиксов: только старая BigInt-ошибка (от первой компиляции до фикса), новых ошибок нет.

## Stage Summary

Retry-проход закрыл два runtime-бага, которые не были видны из статического анализа:
1. **BigInt в `/api/worker/poll`** — ломал весь traffic-pipeline (worker не мог забрать job, сессии зависали в "running", фронт показывал вечный спиннер пробок).
2. **Имена полей `/api/plan`** — френт `route-planner.tsx` читал `distance/duration/geometry`, а API отдаёт `distanceM/durationSec/polyline`. После фикса — корректная отрисовка полилинии маршрута и метрик.

Никаких regressions: lint чистый, страница рендерится, все 5 табов работают (Обзор/Сессии/Маршруты/Импорт/Администрирование). Frontend готов к E2E-демо.

Тестовый пароль: `change-me-please-32-chars-minimum-aaaaaa`.

Изменённые файлы (3 шт.):
- `src/app/api/worker/poll/route.ts` — добавлен select + Number(timestamp) маппинг.
- `src/lib/api-client.ts` — `PlanResponse` расширен каноническими именами полей route.
- `src/components/route-planner.tsx` — чтение `polyline/distanceM/durationSec` с fallback на алиасы.
