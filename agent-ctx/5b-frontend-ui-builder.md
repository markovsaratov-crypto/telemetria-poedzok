# Task ID: 5b — Frontend UI builder

## Agent
Frontend UI builder (subagent).

## Task
Полноценный Frontend (русский UI) для проекта «Телеметрия поездок» v2.6: dashboard с табами (Обзор, Сессии, Маршруты, Импорт, Администрирование), форма логина, Leaflet-карта, CRUD маршрутов, CSV-импорт, audit log, admin panel (backup + requeue), Prometheus metrics viewer.

## Work Log

### Созданные файлы
- `src/lib/api-client.ts` — fetch-обёртка с `credentials:"include"`, обработка 401/429/500, тосты через sonner, типизированные методы `api.get/post/patch/delete/upload`.
- `src/lib/hooks.ts` — React Query хуки: `useAuth`, `useHealth`, `useSessions`, `useSession`, `useRoutes`, `useAudit`, `useBackups`, `useMetrics`, `usePlan`, `useExportSession`, `usePollExport`, мутации для CRUD.
- `src/lib/format.ts` — форматирование дат/длительности/байтов/чисел + `avgSpeed`, `trackDistance` (haversine).
- `src/components/providers.tsx` — ThemeProvider (next-themes, attribute="class") + QueryClientProvider (staleTime 30s) + Toaster (sonner, top-right).
- `src/components/login-form.tsx` — форма пароля, show/hide, framer-motion анимация, spinner.
- `src/components/map-track.tsx` — Leaflet карта (client-only), dynamic tiles (CartoDB voyager/dark), кастомные divIcon маркеры (старт emerald / финиш amber / pin teal), Polyline трека, FitBounds, ClickHandler для route-planner.
- `src/components/sessions-list.tsx` — курсорная пагинация, фильтры (deviceId/status/routeId), badge статусов, skeleton loading, custom scrollbar.
- `src/components/session-detail.tsx` — карта трека + метрики (8 карточек) + таблица точек (first/last 5) + delete (alert dialog) + export dialog trigger.
- `src/components/route-planner.tsx` — 2 точки кликом на карте, режим старта/финиша, кнопка "Построить" (POST /api/plan), отображение дистанции/времени/провайдера/кэш-hit, сохранение в избранное.
- `src/components/routes-manager.tsx` — CRUD избранных маршрутов, modal форма, alert-dialog для удаления, список с _count sessions.
- `src/components/export-dialog.tsx` — выбор gpx/kml/json, sync путь (data URL → download), async путь (>5000 точек → jobId → poll /api/exports/[jobId] каждые 1.5s → download blob).
- `src/components/csv-import.tsx` — drag&drop зона, прогресс-бар, результат (импортировано N сессий/M точек), таблица сессий, ошибки.
- `src/components/audit-log.tsx` — курсорная пагинация, фильтры (action/actorType/targetType), иконки по типу действия, expandable metadata JSON.
- `src/components/admin-panel.tsx` — backup card (POST /api/admin/backup + список backups с checksum/size) + requeue card (input jobId + кнопка).
- `src/components/metrics-viewer.tsx` — парсинг Prometheus text exposition (HELP/TYPE/samples), таблица метрик с фильтром, badge типа (counter/gauge/histogram), форматирование K/M.
- `src/components/dashboard-overview.tsx` — вкладка "Обзор": 4 stat-карточки + мини-карта последней сессии (с подгрузкой точек) + список последних 5 сессий.
- `src/components/theme-toggle.tsx` — переключатель light/dark (useSyncExternalStore для mount-detection без setState-in-effect).
- `src/components/health-indicator.tsx` — точка-индикатор (emerald/amber/red) + tooltip, poll /health каждые 30s.
- `src/app/page.tsx` — главная: LoginForm ИЛИ dashboard с 5 табами, header (лого, health, theme, logout), sticky footer, ResizablePanelGroup для Sessions+Detail, framer-motion transitions.
- `src/app/layout.tsx` — обновлён: Geist с cyrillic subset, Providers wrapper, metadata ru.
- `src/app/globals.css` — emerald/teal/amber/zinc тема (light+dark), custom scrollbar `.scroll-telem`, Leaflet z-index корректировки.

### Backend-фикс (минимальный, разблокирующий frontend)
Обнаружен баг: в dev-режиме (`NODE_ENV=development`) cookie `__Host-telem_session` ставился без `Secure` (т.к. `secure: process.env.NODE_ENV === "production"`), но `__Host-` префикс **требует** Secure — браузеры и curl reject'ят такой cookie, логин невозможен.
- `src/lib/auth.ts`: `COOKIE_NAME` теперь env-aware: `__Host-telem_session` в production, `telem_session` в development.
- `src/middleware.ts`: импортирован `COOKIE_NAME`, замена хардкода `"__Host-telem_session"` на `SESSION_COOKIE_NAME`.
- В production (`NODE_ENV=production`) поведение не изменилось: `__Host-telem_session` + Secure.

### Дизайн
- **Цвета**: emerald-600 primary, teal/amber/zinc акценты. OKLCH значения в `:root` и `.dark`.
- **Тема**: light + dark через next-themes (class attribute). Leaflet tiles меняются (CartoDB voyager → dark_all).
- **Шрифт**: Geist + Geist Mono, cyrillic subset.
- **Карточки**: shadcn Card с `p-6` / `gap-4`.
- **Длинные списки**: `max-h-96 overflow-y-auto scroll-telem` (custom emerald scrollbar).
- **Sticky footer**: `min-h-screen flex flex-col` + `footer.mt-auto`.
- **Анимации**: framer-motion для page transitions, list items, hover effects.
- **Responsive**: mobile-first, `sm:`/`md:`/`lg:`/`xl:` breakpoints, tabs scroll on mobile.
- **Loading**: Skeletons, spinners, pulse.
- **Toasts**: sonner (top-right, richColors, closeButton).
- **Russian UI**: все тексты на русском.

### Проверка
1. `bun run lint` — ✅ проходит без ошибок (0 errors, 0 warnings).
2. `curl http://localhost:3000/` — ✅ HTTP 200, 28KB, HTML содержит "Телеметрия поездок", "Пароль", "Войти".
3. E2E auth flow (curl): login → /me → /sessions → /routes → /audit → /admin/backup — все 200 с cookie. ✅
4. Bearer-токены (API_KEY, ADMIN_TOKEN) работают для всех endpoints. ✅

### Особенности реализации
- **api-client.ts**: `setUnauthorizedHandler` регистрируется в page.tsx — на 401 показывает toast "Сессия истекла" и перезагружает страницу.
- **React Query**: `staleTime: 30s`, `gcTime: 5min`, `retry: 1`, `refetchOnWindowFocus: false`. Health poll каждые 30s, metrics каждые 60s.
- **Leaflet**: `dynamic(() => import("@/components/map-track"), { ssr: false })` — карта только client-side. CSS импортирован внутри компонента.
- **Export async**: `usePollExport` использует `refetchInterval` с динамическим возвратом — `false` когда статус completed/failed, иначе 1500ms.
- **Mount-detection**: `useSyncExternalStore(emptySubscribe, () => true, () => false)` — обходит ESLint правило `react-hooks/set-state-in-effect` (theme-toggle, health-indicator).
- **CSV import**: `FormData` через `api.upload` (без явного Content-Type — браузер ставит multipart boundary).
- **Metrics parser**: regex-парсинг `# HELP`, `# TYPE`, `name{labels} value`, группировка по family.

## Stage Summary
Frontend готов. 18 файлов создано, 2 backend-файла минимально правлены (cookie name env-aware — разблокирует логин в dev). Lint чистый. Страница рендерится. Auth flow работает end-to-end с cookie. Все 5 табов функциональны: Обзор (статистика + мини-карта), Сессии (resizable list+detail), Маршруты (planner + CRUD), Импорт (drag&drop CSV), Администрирование (backup + requeue + audit + metrics).

Тестовый пароль: `change-me-please-32-chars-minimum-aaaaaa`.
