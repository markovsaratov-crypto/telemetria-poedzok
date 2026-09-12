# Телемат

PWA-платформа записи и анализа телеметрии автомобильных поездок: приём GPS-батчей от Sensor Logger, 60+ метрик вождения, план-факт маршрутизации, аналитика, экспорт и администрирование.

- **Продакшен:** https://poedzok.fun (origin — `telemetria-poedzok.onrender.com`, CDN TurboFlare — см. `docs/CUSTOM_DOMAIN.md`)
- **Health:** `GET /health` (отдаёт версию из `package.json`)
- **Развёртывание:** push в `main` → Render autoDeploy (см. `render.yaml`)
- **Текущая версия:** 2.29.0 (см. `package.json` / `render.yaml`)
- **Бекап БД:** еженедельный приватный draft-релиз `backup-*` (последний — `backup-v2.29.0`); восстановление — `POST /api/admin/restore` (см. `docs/TECHNICAL.md` §14)

## Документация — где лежит

Вся документация лежит в папке **`docs/`** этого репозитория на GitHub:
**https://github.com/markovsaratov-crypto/telemetria-poedzok/tree/main/docs**

| Документ | Что внутри | Прямая ссылка на GitHub |
|---|---|---|
| **TECHNICAL.md** | Полная техническая документация: архитектура, БД, безопасность, справочник API, бэкапы, runbook. Точка входа для администратора и техподдержки | [docs/TECHNICAL.md](https://github.com/markovsaratov-crypto/telemetria-poedzok/blob/main/docs/TECHNICAL.md) |
| **METHODOLOGY.md** | Методология и метрики (62 метрики, формулы, границы применимости) | [docs/METHODOLOGY.md](https://github.com/markovsaratov-crypto/telemetria-poedzok/blob/main/docs/METHODOLOGY.md) |
| **ADMIN_SPEC.md** | Спецификация администратора: детальные процедуры, история изменений по версиям (последние — в шапке) | [docs/ADMIN_SPEC.md](https://github.com/markovsaratov-crypto/telemetria-poedzok/blob/main/docs/ADMIN_SPEC.md) |
| **OPERATIONS.md** | Операционные заметки: алерты, бэкапы, инциденты | [docs/OPERATIONS.md](https://github.com/markovsaratov-crypto/telemetria-poedzok/blob/main/docs/OPERATIONS.md) |
| **CUSTOM_DOMAIN.md** | Ранбук домена poedzok.fun через TurboFlare CDN (РФ без VPN) | [docs/CUSTOM_DOMAIN.md](https://github.com/markovsaratov-crypto/telemetria-poedzok/blob/main/docs/CUSTOM_DOMAIN.md) |

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
