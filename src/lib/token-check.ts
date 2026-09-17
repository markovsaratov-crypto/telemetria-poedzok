// src/lib/token-check.ts — timing-safe сравнение токенов, edge-safe (Web Crypto).
// Сравниваются SHA-256-дайджесты обоих значений: фиксированная длина (32 байта),
// XOR-сравнение за константное время — не зависит от длины и содержимого входа.
// §6.1 / P0-3: middleware обязан проверять ЗНАЧЕНИЯ INGEST_TOKEN/ADMIN_TOKEN/CRON_SECRET.
export async function tokenMatches(
  provided: string | null | undefined,
  expected: string | null | undefined
): Promise<boolean> {
  if (!provided || !expected) return false;
  const enc = new TextEncoder();
  const [got, want] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const a = new Uint8Array(got);
  const b = new Uint8Array(want);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// === v2.38.1 (ревью F11): производный инжест-токен пользователя (ingest-only) ===
// Формат: `it_<32 hex>` = первые 32 символа hex(HMAC-SHA256(SESSION_SECRET, "<apiKey>:ingest")).
// Свойства:
//   1) НЕ является apiKey — по нему выдаётся ТОЛЬКО ingest-скоп (api-скоп он не
//      проходит по построению);
//   2) ротация apiKey автоматически ротирует it_-токен (HMAC от apiKey);
//   3) ротация SESSION_SECRET инвалидирует все it_-токены (новые копируются из
//      /api/auth/me) — см. docs/SECURITY-ROTATION.md;
//   4) в query-string Push URL теперь ходит it_-токен, а не apiKey полного
//      api-скопа (утечка логов CDN больше не даёт доступ к аккаунту).
export const INGEST_TOKEN_PREFIX = "it_";
export const INGEST_TOKEN_RE = /^it_[0-9a-f]{32}$/;

// Вычисление it_-токена по apiKey. sessionSecret передаётся явным параметром —
// модуль остаётся без зависимостей (edge-safe), env читает вызывающий.
export async function deriveIngestToken(apiKey: string, sessionSecret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(sessionSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${apiKey}:ingest`));
  // hex без Buffer (модуль edge-safe): по 2 символа на байт
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${INGEST_TOKEN_PREFIX}${hex.slice(0, 32)}`;
}
