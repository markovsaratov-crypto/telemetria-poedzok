# Базлайн-миграция (0_init)

Полная схема БД (11 таблиц) как единый SQL-файл, сгенерированный из
`prisma/schema.prisma` (`prisma migrate diff --from-empty --to-schema-datamodel
prisma/schema.prisma --script`). Назначение — трассируемость эволюции схемы и
возможность просмотра будущих изменений как diff (см. TECHNICAL §7.3).

Применение схемы в эксплуатации остаётся `prisma db push` (expand-only):
миграционный движок Prisma (`prisma migrate deploy`) для Turso/libsql в этой
конфигурации не используется. Файл НЕ применяется автоматически никаким
процессом — это эталон и инструмент ревью изменений.
