// src/lib/scope.ts — v2.23.0: ИЗОЛЯЦИЯ ДАННЫХ ПОЛЬЗОВАТЕЛЕЙ (privacy fix).
//
// ПРОБЛЕМА (репорт владельца): «у новых пользователей после авторизации
// частично доступна чужая статистика». Регистрация (v2.20.0) выдаёт аккаунты
// role="user", но ВСЕ read-роуты (/api/sessions, /api/stats, /api/routes/*,
// батчи, экспорты, шеринг) фильтровали данные только по deletedAt — любой
// вошедший пользователь видел весь архив владельца. Write-роуты (notes,
// share, export, delete) тоже не проверяли принадлежность сессии.
//
// МОДЕЛЬ ВЛАДЕНИЯ (без миграции схемы — Session.userId уже есть, nullable):
//   • Session.userId IS NULL — «хозяйские» данные: весь исторический архив
//     (ингест владельца через глобальный INGEST_TOKEN) + будущие пуши
//     владельца. Видит владелец сервера (legacy LOGIN_PASSWORD / API_KEY).
//   • Session.userId = <uuid> — данные зарегистрированного пользователя:
//     ингест по ЛИЧНОМУ токену (User.apiKey в ?token= инжест-роутов) или
//     CSV/ZIP-импорт из-под его сессии. Видит только он сам.
//   • role="admin" — видит всё (администрирование, назначается вручную).
//
// Правила видимости по роли (из authorizeRequest):
//   user   → own        (только свои сессии)        [cookie | личный apiKey]
//   owner  → unclaimed  (хозяйские, userId IS NULL) [legacy cookie]
//   api    → unclaimed  (глобальный API_KEY = ключ владельца)
//   admin  → all                                      [cookie | apiKey]
//   cron   → all         (системные задачи)
//
// КРИТИЧНО для кэшей: TTL-кэши роутов обязаны включать режим скоупа в ключ,
// иначе ответ владельца утекает пользователю из общего кэша процесса
// (см. stats/speed-record, stats/events/track-batch).

import type { AuthResult } from "./auth";

export type DataScopeMode = "all" | "own" | "unclaimed";

export interface DataScope {
  mode: DataScopeMode;
  /** id владельца данных для mode="own" */
  userId?: string;
}

/** Успешный результат authorizeRequest (ок-ветка AuthResult). */
export type Authorized = Extract<AuthResult, { ok: true }>;

/** Определить режим видимости данных по результату authorizeRequest. */
export function dataScopeFor(auth: Authorized): DataScope {
  // Зарегистрированный пользователь (cookie или личный apiKey) — только свои данные
  if (auth.userId && auth.role === "user") {
    return { mode: "own", userId: auth.userId };
  }
  // Админ/крон — всё (администрирование, системные задачи)
  if (auth.role === "admin" || auth.role === "cron") {
    return { mode: "all" };
  }
  // Владелец (legacy cookie) и глобальный API_KEY — «хозяйские» данные
  return { mode: "unclaimed" };
}

/** Prisma-style фрагмент where для db.session.* (обёртка поддерживает userId с v2.23.0). */
export function sessionScopeWhere(scope: DataScope): Record<string, unknown> {
  if (scope.mode === "own") return { userId: scope.userId };
  if (scope.mode === "unclaimed") return { userId: null };
  return {};
}

/** SQL-предикат для сырых запросов. Без алиаса — " AND userId = ?" (запросы
 *  без псевдонима таблицы); с алиасом — " AND s.userId = ?".
 *  args возвращает соответствующие значения для libsql. */
export function sessionScopeSql(
  scope: DataScope,
  alias?: string
): { clause: string; args: unknown[] } {
  const col = alias ? `${alias}.userId` : "userId";
  if (scope.mode === "own") return { clause: ` AND ${col} = ?`, args: [scope.userId] };
  if (scope.mode === "unclaimed") return { clause: ` AND ${col} IS NULL`, args: [] };
  return { clause: "", args: [] };
}

/** Принадлежит ли строка Session (её userId) зоне видимости. Для проверок [id]-роутов. */
export function sessionVisibleTo(scope: DataScope, sessionUserId: unknown): boolean {
  if (scope.mode === "all") return true;
  if (scope.mode === "unclaimed") return sessionUserId == null;
  return sessionUserId != null && String(sessionUserId) === scope.userId;
}
