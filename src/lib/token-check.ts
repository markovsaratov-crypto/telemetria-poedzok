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
