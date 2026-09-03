# Телеметрия Поездки (Telemetria Poedzok)

PWA-платформа записи и анализа телеметрии автомобильных поездок: приём GPS-батчей от Sensor Logger, 60+ метрик вождения, план-факт маршрутизации, аналитика, экспорт и администрирование.

- **Продакшен:** https://telemetria-poedzok.onrender.com
- **Health:** `GET /health`
- **Развёртывание:** push в `main` → Render autoDeploy (см. `render.yaml`)

## Документация

| Документ | Назначение |
|---|---|
| **[docs/TECHNICAL.md](docs/TECHNICAL.md)** | Полная техническая документация: архитектура, БД, безопасность, справочник API, бэкапы, runbook. Точка входа для администратора и техподдержки |
| [docs/METHODOLOGY.md](docs/METHODOLOGY.md) | Методология и метрики (62 метрики, формулы, границы применимости) |
| [docs/ADMIN_SPEC.md](docs/ADMIN_SPEC.md) | Спецификация администратора (детальные процедуры) |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Операционные заметки: алерты, бэкапы, инциденты |

## Быстрый старт (локально)

```bash
npm install
DATABASE_URL="file:./db/local.db" npm run db:push
npm run dev        # http://localhost:3000
```

Секреты — в `.env` (не коммитится). Прод-секреты задаются в дашборде Render (`sync: false`), в репозитории их нет.

## Стек

Next.js 16 (App Router) · React 19 · TypeScript 5 strict · Tailwind 4 + shadcn/ui · TanStack Query 5 · Prisma 6 + Turso (libSQL) · Leaflet · Zod · PWA.
