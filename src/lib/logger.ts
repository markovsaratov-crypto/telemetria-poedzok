// src/lib/logger.ts — Pino-подобный логгер (без pino dep: простой structured logger с requestId).
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogContext {
  requestId?: string;
  [k: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function emit(level: LogLevel, msg: string, ctx: LogContext = {}) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    ...ctx,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, ctx?: LogContext) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: LogContext) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit("error", msg, ctx),
  child: (base: LogContext) => ({
    debug: (msg: string, ctx?: LogContext) => emit("debug", msg, { ...base, ...ctx }),
    info: (msg: string, ctx?: LogContext) => emit("info", msg, { ...base, ...ctx }),
    warn: (msg: string, ctx?: LogContext) => emit("warn", msg, { ...base, ...ctx }),
    error: (msg: string, ctx?: LogContext) => emit("error", msg, { ...base, ...ctx }),
  }),
};
