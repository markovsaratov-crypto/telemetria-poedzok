// src/lib/agg-cache.ts — v2.38.2 · F48: маленький in-memory кэш СГЕНЕРИРОВАННЫХ
// артефактов экспорта (GPX/KML/JSON) для GET /api/exports/[jobId]/download.
//
// Проблема (F48): download-роут грузил ВСЕ точки сессии и строил контент на
// лету на КАЖДОЕ нажатие «Скачать» (результат воркера для fileSize выброшен —
// контент в ExportJob не хранится, файлового хранилища в sandbox нет;
// ExportJob.fileUrl — пустое, колонки под блоб в схеме нет — добавлять её =
// миграция Prisma, вне зоны этого фикса).
//
// Решение: LRU-кэш с бюджетом БАЙТ. Артефакт 56К-точечного GPX ≈ 4 МБ — лимит
// по ЧИСЛУ записей (как у ttl-cache.ts) здесь бесполезен, нужен именно
// суммарный объём: бюджет 16 МБ на инстанс 512 МБ. Ключ =
// jobId:format:pointCount — денормализованный Session.pointCount инкрементится
// инжестом каждым батчем → новые точки меняют ключ и артефакт пересобирается
// (самоинвалидация по данным, TTL — только гигиена памяти).
//
// Гарантии: запись живёт ≤ TTL 10 мин; переполнение бюджета выталкивает самую
// давнюю по ДОСТУПУ запись (Map хранит порядок вставки, get/set перекладывают
// в конец — тот же LRU-жест, что у TtlCache); Map на globalThis переживает
// HMR-пересоздания модуля. Рестарт/мультиинстанс — кэш холодный: первый
// download после рестарта пересобирает артефакт (корректно, просто не мгновенно).
import { logger } from "./logger";

export interface ExportArtifact {
  content: string;
  mime: string;
  ext: string;
  /** Фактический объём (байты) — для бюджета памяти. */
  bytes: number;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

interface Entry {
  artifact: ExportArtifact;
  expiresAt: number;
}

const GLOBAL_KEY = "__telemetriaExportArtifacts";
const g = globalThis as unknown as { [GLOBAL_KEY]?: Map<string, Entry> };

function store(): Map<string, Entry> {
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

/** Ключ кэша артефакта: jobId + формат + счётчик точек сессии (самоинвалидация). */
export function exportArtifactKey(jobId: string, format: string, pointCount: number): string {
  return `${jobId}:${format}:${pointCount}`;
}

/** Достать артефакт; просроченная/отсутствующая запись → null (пересборка). */
export function getExportArtifact(key: string): ExportArtifact | null {
  const s = store();
  const e = s.get(key);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) {
    s.delete(key);
    return null;
  }
  // LRU-жест: свежедоступная запись уходит в конец порядка вытеснения
  s.delete(key);
  s.set(key, e);
  return e.artifact;
}

/** Записать артефакт с учётом бюджета байтов (вытеснение самых давних). */
export function setExportArtifact(key: string, artifact: ExportArtifact): void {
  const s = store();
  s.delete(key);
  s.set(key, { artifact, expiresAt: Date.now() + TTL_MS });
  // бюджет: сначала отбрасываем просроченные, затем вытесняем давние по доступу
  const now = Date.now();
  let total = 0;
  for (const [k, v] of s) {
    if (v.expiresAt <= now) {
      s.delete(k);
      continue;
    }
    total += v.artifact.bytes;
  }
  let evicted = 0;
  while (total > MAX_TOTAL_BYTES) {
    const oldest = s.keys().next().value;
    if (oldest === undefined) break;
    const v = s.get(oldest);
    s.delete(oldest);
    total -= v?.artifact.bytes ?? 0;
    evicted++;
  }
  if (evicted > 0) {
    logger.info("export artifact cache evicted (byte budget)", { evicted, totalBytes: total });
  }
}
