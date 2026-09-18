// v2.40.4 (ревью RR-1 / M-1): идемпотентность импорта.
// Проблема: CSV/ZIP-импорт генерировали clientId (и дефолтный deviceId ZIP)
// через randomUUID() на КАЖДЫЙ запрос — повторная загрузка того же файла
// обходила @@unique([deviceId, clientId]) и создавала полные дубликаты
// (сессия + точки + TrafficJob).
// Решение: детерминированный identity ИЗ КОНТЕНТА группы точек
// (deviceId + первый/последний таймстемп + их координаты + число точек).
// Повторный импорт того же файла даёт тот же (deviceId, clientId) → INSERT
// падает по @@unique → роут отвечает стабильным кодом already_imported.
// Работает даже при исчерпанной квоте чтений D1: обнаружение дубликата —
// это ошибка INSERT'а (запись), а не SELECT-проверка.
import { createHash } from "crypto";

export type ImportFingerprintPoint = { timestamp: number; lat: number; lon: number };

// SHA-256 отпечаток группы точек. Поля разделены \x1f (unit separator) —
// исключает склейку соседних значений («12» + «3» = «1» + «23»).
export function tripFingerprint(deviceId: string, points: readonly ImportFingerprintPoint[]): string {
  if (points.length === 0) throw new Error("tripFingerprint: пустая группа точек");
  const first = points[0];
  const last = points[points.length - 1];
  const h = createHash("sha256");
  h.update(deviceId);
  h.update("\x1f");
  h.update(
    [
      first.timestamp,
      `${first.lat.toFixed(6)},${first.lon.toFixed(6)}`,
      last.timestamp,
      `${last.lat.toFixed(6)},${last.lon.toFixed(6)}`,
      points.length,
    ].join("\x1f")
  );
  return h.digest("hex");
}

// CSV: fallback-clientId (когда в файле нет колонки client_id).
// Префикс «csv-» читается в UI/логах.
export function csvFallbackClientId(deviceId: string, points: readonly ImportFingerprintPoint[]): string {
  return `csv-${tripFingerprint(deviceId, points).slice(0, 24)}`;
}

// ZIP: clientId сессии — детерминирован по контенту (deviceId уже выверен:
// из Metadata.csv или дефолт из того же отпечатка).
export function zipImportClientId(deviceId: string, points: readonly ImportFingerprintPoint[]): string {
  return `zip-${tripFingerprint(deviceId, points).slice(0, 24)}`;
}

// ZIP: дефолтный deviceId, когда Metadata.csv не содержит device id.
// Раньше — randomUUID().slice(0,8) на каждый запрос: тот же архив дважды =
// два «разных устройства». Теперь — детерминирован по контенту точек.
export function zipDefaultDeviceId(points: readonly ImportFingerprintPoint[]): string {
  return `zip-${tripFingerprint("zip-default", points).slice(0, 8)}`;
}

// Обнаружение нарушения уникальности на ОБОИХ исполнителях:
//  • libsql/Prisma — PrismaClientKnownRequestError с кодом P2002;
//  • D1 (через шлюз) — Error с текстом «UNIQUE constraint failed: …»
//    (d1-gateway отдаёт { error: String(err.message), d1: true } → db-d1
//    прокидывает как Error с исходным сообщением).
export function isUniqueConstraintError(err: unknown): boolean {
  if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") return true;
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
