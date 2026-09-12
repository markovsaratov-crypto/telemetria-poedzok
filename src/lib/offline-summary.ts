// src/lib/offline-summary.ts — v2.9.9: локальный снимок ключевой статистики для офлайн-заглушки PWA.
// Компоненты при успешных запросах сохраняют метрики в localStorage (ключ telem:offline-summary);
// public/offline.html читает их через SW-fallback, когда сети нет.

export interface OfflineSummary {
  savedAt: number; // ms epoch последнего обновления снимка
  version?: string;
  totalSessions?: number;
  totalPoints?: number;
  lastSessionAt?: string; // ISO startTime самой свежей поездки
  lastDevice?: string; // deviceName/parentId последней поездки
}

// v2.31.0 (NIT-2): поля avgSpeedKmh/maxSpeedKmh/totalDistanceKm/totalDurationMin
// удалены — их никто не писал (снимок обновляют только useStats/useSessions:
// счётчики и последняя запись), а /api/stats не отдаёт дистанционных агрегатов.
// offline.html показывал их никогда (null-guard) — мёртвый контракт.

const KEY = "telem:offline-summary";

export function saveOfflineSummary(patch: Omit<OfflineSummary, "savedAt">) {
  if (typeof window === "undefined") return;
  try {
    const current: OfflineSummary = (() => {
      try {
        return JSON.parse(window.localStorage.getItem(KEY) || "{}") as OfflineSummary;
      } catch {
        return { savedAt: 0 };
      }
    })();
    const next: OfflineSummary = { ...current, ...patch, savedAt: Date.now() };
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* localStorage недоступен (приватный режим/quota) — офлайн-заглушка покажет плейсхолдер */
  }
}
