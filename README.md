# Телемат

PWA-платформа записи и анализа телеметрии автомобильных поездок: приём GPS-батчей от Sensor Logger, 60+ метрик вождения, план-факт маршрутизации, аналитика, экспорт и администрирование.

- **Продакшен:** https://poedzok.fun (origin — `telemetria-poedzok.onrender.com`, CDN TurboFlare — см. `docs/CUSTOM_DOMAIN.md`)
- **Статус:** прод **v2.40.0** (18.09.2026: этап A + B1 + B2 задеплоены; Turso-инцидент закрыт env-парой D1_GATEWAY_* через Render API; **§B5 Cron Triggers** — планировщик в d1-gateway-воркере (tick */1, finalize+alerts */5, retention 03:00, backup 03:30, github-backup ВС 04:00, turso-migrate */30), **§B1-complete** алиас `/api/ingest` на воркере, **§T-DELTA** самовосстанавливающийся мигратор Turso-дельты в D1, **§B6** OpenNext-сборка сайта под Cloudflare Workers; см. §0 и `docs/OPTIMIZATION-PROPOSAL.md`)
- **Health:** `GET /health` (отдаёт версию из `package.json`)
- **Развёртывание:** push в `main` → Render autoDeploy (см. `render.yaml`)
- **Бекап БД:** ежедневный приватный draft-релиз `backup-*` (03:30 UTC, вместе с локальным дампом) + read-back drill (проверка восстановимости); восстановление — `POST /api/admin/restore` из локального дампа или напрямую из GitHub-релиза (`{source:"github"}`) (см. `docs/TECHNICAL.md` §14)
- **Качество:** CI GitHub Actions (tsc + eslint + vitest, 50 unit-тестов вычислительных ядер) — `.github/workflows/ci.yml`

## Документация — где лежит

Вся документация лежит в папке **`docs/`** этого репозитория на GitHub:
**https://github.com/markovsaratov-crypto/telemetria-poedzok/tree/main/docs**

| Документ | Что внутри | Прямая ссылка на GitHub |
|---|---|---|
| **TECHNICAL.md** | Полная техническая документация: архитектура, БД, безопасность, справочник API, бэкапы, runbook. Точка входа для администратора и техподдержки | [docs/TECHNICAL.md](https://github.com/markovsaratov-crypto/telemetria-poedzok/blob/main/docs/TECHNICAL.md) |
| **METHODOLOGY.md** | Методология и метрики (62 метрики, формулы, границы применимости) | [docs/METHODOLOGY.md](https://github.com/markovsaratov-crypto/telemetria-poedzok/blob/main/docs/METHODOLOGY.md) |
| **ADMIN_SPEC.md** | Спецификация администратора: развёртывание, токены, API, бэкапы, наблюдаемость | [docs/ADMIN_SPEC.md](https://github.com/markovsaratov-crypto/telemetria-poedzok/blob/main/docs/ADMIN_SPEC.md) |
| **OPERATIONS.md** | Операционные заметки: алерты, бэкапы, инциденты | [docs/OPERATIONS.md](https://github.com/markovsaratov-crypto/telemetria-poedzok/blob/main/docs/OPERATIONS.md) |
| **CUSTOM_DOMAIN.md** | Ранбук домена poedzok.fun через TurboFlare CDN (РФ без VPN) | [docs/CUSTOM_DOMAIN.md](https://github.com/markovsaratov-crypto/telemetria-poedzok/blob/main/docs/CUSTOM_DOMAIN.md) |
| **SECURITY-ROTATION.md** | Ранбук ротации секретов после компрометации (v2.38.1) | [docs/SECURITY-ROTATION.md](https://github.com/markovsaratov-crypto/telemetria-poedzok/blob/main/docs/SECURITY-ROTATION.md) |
| **OPTIMIZATION-PROPOSAL.md** | Системное предложение по оптимизации потоков данных / снижению нагрузки / скорости (DRAFT — не исполнено) | [docs/OPTIMIZATION-PROPOSAL.md](https://github.com/markovsaratov-crypto/telemetria-poedzok/blob/main/docs/OPTIMIZATION-PROPOSAL.md) |

Правка документации: отредактировать файл в `docs/` → коммит в `main` → документ на GitHub обновится автоматически вместе с деплоем.

## Быстрый старт (локально)

```bash
npm install
DATABASE_URL="file:./db/local.db" npm run db:push
npm run dev        # http://localhost:3000
```

Секреты — в `.env` (не коммитится). Прод-секреты задаются в дашборде Render (`sync: false`), в репозитории их нет.

## Стек

Next.js 16 (App Router) · React 19 · TypeScript 5 strict · Tailwind 4 + shadcn/ui · TanStack Query 5 · Prisma 6 + Turso (libSQL) · Leaflet (тайлы без ключа: OSM / OpenTopoMap / Esri Imagery / Esri Dark Gray) · Zod · PWA.
