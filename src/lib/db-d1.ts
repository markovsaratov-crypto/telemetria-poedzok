// src/lib/db-d1.ts — v2.37.0: клиент Cloudflare D1 через gateway-воркер.
//
// Миграция Turso → D1 (Task 43, сентябрь 2026): Turso заблокировал чтения
// (месячная квота исчерпана), D1 выбран как SQLite-диалект без переписывания
// SQL. Токен владельца не имеет прав D1 API → данные идут через воркер
// d1-gateway (Workers-биндинг), этот модуль — клиентская половина.
//
// Контракт = подмножество @libsql/client Client, которое использует приложение:
//   execute(stmt | sql)  → ResultSet { rows, rowsAffected, columns }
//   batch(stmts)         → ResultSet[]  (АТОМАРНАЯ транзакция на стороне D1)
//   transaction(...)     → НЕ поддержан (D1 без интерактивных транзакций);
//                          db.ts использует буферизованный batch-исполнитель.
//
// Отличия от @libsql/client, компенсируемые здесь:
//   • JSON-транспорт: BigInt → Number (все значения приложения < 2^53:
//     timestamp ~1.8e12, счётчики малы; точность не теряется);
//     Date → ISO-строка (норма normVal() из db.ts, дублируется защитно);
//   • HTTP-ошибки D1 приходят как { error, d1:true } — прокидываются как
//     Error с исходным сообщением.
//
// Ретраев НЕТ намеренно: повтор неотправленного-но-выполненного INSERT
// дублировал бы данные; идемпотентность обеспечивает прикладной слой
// (IngestMessage, уникальные ключи, worker attempts).

import type { Client, InStatement, InValue, ResultSet } from "@libsql/client";
// v2.38.2 (ревью F52): квота D1 — метрики rows_read/rows_written. metrics.ts
// не импортирует ничего (листь графа модулей) — цикла не возникает; db-d1
// используется только на ветке USING_D1 → счётчики растут только на D1.
import { inc, D1_ROWS_READ_TOTAL, D1_ROWS_WRITTEN_TOTAL } from "./metrics";
// v2.40.9 (Pack C, m-20): sticky-флаги квоты — ставятся на РЕАЛЬНЫХ ошибках
// шлюза (SELECT 1 не может их поймать — читает 0 строк и проходит),
// снимаются любым успешным ответом с фактами чтения/записи строк.
import {
  isD1ReadQuotaError,
  isD1WriteQuotaError,
  markD1ReadQuotaExhausted,
  markD1WriteQuotaExhausted,
  clearD1QuotaIfAlive,
} from "./d1-quota";

const REQUEST_TIMEOUT_MS = 30_000;

interface GatewayQueryResult {
  rows: Record<string, unknown>[];
  rowsAffected: number;
  meta?: { rowsRead?: number | null; rowsWritten?: number | null; durationMs?: number | null };
}

function toInValue(v: unknown): InValue {
  if (typeof v === "bigint") return Number(v); // JSON-транспорт; значения < 2^53
  if (v instanceof Date) return v.toISOString(); // дублируем normVal() из db.ts
  if (v === undefined) return null;
  if (
    typeof v === "object" &&
    v !== null &&
    (v instanceof ArrayBuffer ||
      (typeof Uint8Array === "function" && v instanceof Uint8Array) ||
      typeof (v as { byteLength?: unknown }).byteLength === "number")
  ) {
    throw new Error("D1-клиент: blob-параметры не поддерживаются (в схеме приложения их нет)");
  }
  return v as InValue;
}

function toResultSet(r: GatewayQueryResult): ResultSet {
  // v2.38.2 (ревью F52): meta.rows_read/rows_written от шлюза больше НЕ
  // выбрасываются — агрегируются в счётчики metrics.ts (экспонируются в
  // /api/metrics). До инцидента выгорания дневной квоты чтений D1
  // (16.09.2026, OPERATIONS.md §5а) телеметрии расхода не было вовсе;
  // теперь дневной бюджет наблюдаем (алерт по приросту — задача дашборда).
  // Работает и для /query, и для каждого результата /batch (map ниже).
  const read = r.meta?.rowsRead;
  const written = r.meta?.rowsWritten;
  if (typeof read === "number" && read > 0) inc(D1_ROWS_READ_TOTAL, "", read);
  if (typeof written === "number" && written > 0) inc(D1_ROWS_WRITTEN_TOTAL, "", written);
  // v2.40.9 (Pack C, m-20): успешный ответ с фактами строк — квота жива,
  // sticky-флаги сняты (см. d1-quota.ts: раннее восстановление после 00:00 UTC,
  // если показ данных случился раньше первого /health).
  clearD1QuotaIfAlive(
    typeof read === "number" ? read : 0,
    typeof written === "number" ? written : 0
  );
  return {
    columns: Object.keys(r.rows[0] ?? {}),
    rows: r.rows,
    rowsAffected: r.rowsAffected,
    lastInsertRowid: undefined,
  } as unknown as ResultSet;
}

export function createD1Client(baseUrl: string, secret: string): Client {
  const url = baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-gateway-secret": secret,
  };

  async function call(path: string, body: unknown): Promise<unknown> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    let data: { error?: string } & Record<string, unknown>;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`D1 gateway ${path}: не-JSON ответ (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const err = new Error(data.error ?? `D1 gateway ${path}: HTTP ${res.status}`);
      (err as Error & { d1?: boolean }).d1 = data.d1 === true;
      // v2.40.9 (Pack C, m-20): РЕАЛЬНАЯ ошибка квоты от D1 — единственное место,
      // где исчерпание видно достоверно (SELECT 1 в /health при мёртвой квоте
      // проходит — читает 0 строк). Флаг живёт до полуночи UTC или до первого
      // успешного чтения строк — /health перестаёт рисовать db:ok впустую.
      if (data.d1 === true) {
        if (isD1ReadQuotaError(err)) markD1ReadQuotaExhausted();
        if (isD1WriteQuotaError(err)) markD1WriteQuotaExhausted();
      }
      throw err;
    }
    return data;
  }

  function normStmt(stmt: string | InStatement): { sql: string; args: InValue[] } {
    if (typeof stmt === "string") return { sql: stmt, args: [] };
    const raw = stmt.args;
    if (raw == null) return { sql: stmt.sql, args: [] };
    if (!Array.isArray(raw)) {
      // InArgs допускает Record (именованные параметры) — приложение такими
      // не пользуется (все запросы позиционные «?»)
      throw new Error("D1-клиент: именованные параметры не поддерживаются");
    }
    return { sql: stmt.sql, args: raw.map((v) => toInValue(v)) };
  }

  const client = {
    async execute(stmt: string | InStatement): Promise<ResultSet> {
      const s = normStmt(stmt);
      const r = (await call("/query", { sql: s.sql, params: s.args })) as GatewayQueryResult;
      return toResultSet(r);
    },
    async batch(stmts: InStatement[]): Promise<ResultSet[]> {
      if (!Array.isArray(stmts) || stmts.length === 0) return [];
      const list = stmts.map(normStmt);
      const r = (await call("/batch", { statements: list.map((s) => ({ sql: s.sql, params: s.args })) })) as GatewayQueryResult[];
      return r.map(toResultSet);
    },
    // D1 не имеет интерактивных транзакций: db.ts маршрутизирует $transaction
    // в буферизованный атомарный batch (USING_D1). Вызов сюда = баг маршрутизации.
    async transaction(): Promise<never> {
      throw new Error("D1-клиент: интерактивные транзакции не поддерживаются (см. db.ts $transaction)");
    },
    async close(): Promise<void> {
      /* HTTP-клиент: нечего закрывать */
    },
    closed: false,
    async sync(): Promise<void> {
      /* нет локальной реплики (HTTP-клиент, не embedded) */
    },
    async interrupt(): Promise<void> {
      /* нет локальной реплики */
    },
  } as unknown as Client;
  return client;
}
