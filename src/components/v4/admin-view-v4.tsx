// src/components/v4/admin-view-v4.tsx — вкладка Админ v4.
// Комбинированная: A1-A4 v4 (Параметры/Сессии/Качество/Пайплайн)
// + legacy блоки из текущего AdminPanel (Состояние системы / Настройки
// маршрутизации / GitHub Backup / Резервные копии / Requeue).
// + A5 Импорт (CsvImport + ZipImport), как согласовано.

"use client";

import * as React from "react";
import {
  Activity,
  Cpu,
  Server,
  Database,
  HardDrive,
  Hash,
  GitBranch,
  Zap,
  ShieldCheck,
  RotateCcw,
  Github,
  Settings as SettingsIcon,
  Upload,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  useHealth,
  useStats,
  useBackups,
  useCreateBackup,
  useRequeueJob,
  useSettings,
  useUpdateSetting,
  useGitHubBackups,
  useCreateGitHubBackup,
} from "@/lib/hooks";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDate, fmtBytes, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { bindTips } from "./use-v4-tipbox";
import { CsvImport } from "@/components/csv-import";
import { ZipImport } from "@/components/zip-import";

export function AdminViewV4() {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (ref.current) bindTips(ref.current);
  });

  return (
    <div ref={ref}>
      <A1ParamsBlock />
      <A2SessionsBlock />
      <A3QualitySummaryBlock />
      <A4PipelineBlock />
      <A5ImportBlock />

      {/* === Разделитель legacy === */}
      <div className="legacy-grid">
        <div className="sec-head" style={{ marginTop: 0 }}>
          <span className="sec-num">L</span>
          <span className="sec-title">Служебные блоки (legacy)</span>
          <span className="sec-sub">live-данные + runtime-overridable</span>
        </div>

        <SystemInfoLegacyCard />
        <RoutingSettingsLegacyCard />
        <div className="legacy-grid-2col">
          <GitHubBackupLegacyCard />
          <BackupsLegacyCard />
        </div>
        <RequeueLegacyCard />
      </div>

      <div className="toast">
        <b>Служебная вкладка.</b> Параметры и диагностика соответствуют разделам методики (параметры расчёта, идемпотентность, кэширование, цепочка маршрутизации). Блоки A1–A4 — справочные параметры, блоки L — live-интеграция с существующими API.
      </div>
    </div>
  );
}

// === A1: Параметры системы ===
function A1ParamsBlock() {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">A1</span>
        <span className="sec-title">Параметры системы</span>
        <span className="sec-sub">константы расчёта · параметры методики</span>
      </div>
      <div className="card">
        <div className="param-grid">
          <div>
            <div className="param">
              <span>Порог разрыва записи</span>
              <b>30 сек</b>
            </div>
            <div className="param">
              <span>
                Гистерезис движения
                <small>вход в движение / выход</small>
              </span>
              <b>5 / 2 км/ч</b>
            </div>
            <div className="param">
              <span>Резкое торможение / разгон</span>
              <b>±10 км/ч/сек</b>
            </div>
            <div className="param">
              <span>
                Манёвр на высокой скорости
                <small>Δ курса · окно · скорость</small>
              </span>
              <b>45° · 5 сек · 60 км/ч</b>
            </div>
            <div className="param">
              <span>Порог пробки (сегмент)</span>
              <b>severity &lt; 0,5</b>
            </div>
            <div className="param">
              <span>Крейсерская скорость</span>
              <b>&gt; 60 км/ч</b>
            </div>
          </div>
          <div>
            <div className="param">
              <span>Пробка по скорости (точки)</span>
              <b>&lt; 10 км/ч</b>
            </div>
            <div className="param">
              <span>
                EcoScore · базлайны CAP
                <small>торможение / разгон / рывок</small>
              </span>
              <b>0,5 / 0,4 / 0,3</b>
            </div>
            <div className="param">
              <span>EcoScore · веса компонентов</span>
              <b>0,45 / 0,30 / 0,25</b>
            </div>
            <div className="param">
              <span>baselineVersion</span>
              <b>2026-08-01 · n42</b>
            </div>
            <div className="param">
              <span>Viterbi · σ / β</span>
              <b>5 м / 5 м</b>
            </div>
            <div className="param">
              <span>Мин. корпус калибровки</span>
              <b>30 сессий</b>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// === A2: Сессии · качество и привязка ===
function A2SessionsBlock() {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">A2</span>
        <span className="sec-title">Сессии · качество и привязка</span>
        <span className="sec-sub">последние 6 из 92 · SensorLogger</span>
      </div>
      <div className="card adm-tbl-wrap">
        <table className="adm-tbl">
          <thead>
            <tr>
              <th>Сессия</th>
              <th>routeId</th>
              <th>Точки</th>
              <th>Полн.</th>
              <th>Надёжн.</th>
              <th>Гео-охват (BBox)</th>
              <th>План</th>
              <th>Дубль</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>28 авг · 14:23</td>
              <td className="mono">a3b8c1f2e9d04b77</td>
              <td className="mono">18 740</td>
              <td className="mono">92%</td>
              <td className="mono c-plum">0,91</td>
              <td className="mono">55.72–78 / 37.51–61</td>
              <td className="mono">2ГИС</td>
              <td className="mono">—</td>
            </tr>
            <tr>
              <td>28 авг · 08:12</td>
              <td className="mono">a3b8c1f2e9d04b77</td>
              <td className="mono">18 312</td>
              <td className="mono">94%</td>
              <td className="mono c-plum">0,93</td>
              <td className="mono">55.72–78 / 37.51–61</td>
              <td className="mono">2ГИС</td>
              <td className="mono">—</td>
            </tr>
            <tr>
              <td>27 авг · 19:40</td>
              <td className="mono">7d2e4a91c6f13e08</td>
              <td className="mono">3 981</td>
              <td className="mono">89%</td>
              <td className="mono c-plum">0,88</td>
              <td className="mono">55.75–80 / 37.58–68</td>
              <td className="mono">2ГИС</td>
              <td className="mono">—</td>
            </tr>
            <tr>
              <td>27 авг · 07:55</td>
              <td className="mono">a3b8c1f2e9d04b77</td>
              <td className="mono">19 205</td>
              <td className="mono">91%</td>
              <td className="mono c-amber">0,79</td>
              <td className="mono">55.72–78 / 37.51–61</td>
              <td className="mono">OSRM</td>
              <td className="mono">—</td>
            </tr>
            <tr>
              <td>26 авг · 18:20</td>
              <td className="mono">b1c9e8d45a27f6c3</td>
              <td className="mono">9 148</td>
              <td className="mono">96%</td>
              <td className="mono c-plum">0,95</td>
              <td className="mono">55.73–85 / 37.40–52</td>
              <td className="mono">2ГИС</td>
              <td className="mono">—</td>
            </tr>
            <tr>
              <td>25 авг · 09:05</td>
              <td className="mono">b1c9e8d45a27f6c3</td>
              <td className="mono">8 970</td>
              <td className="mono">93%</td>
              <td className="mono c-plum">0,90</td>
              <td className="mono">55.73–85 / 37.40–52</td>
              <td className="mono">гаверсинус</td>
              <td className="mono">1 откл.</td>
            </tr>
          </tbody>
        </table>
        <p className="pf-note" style={{ marginTop: 11 }}>
          routeId = sha256(snap-to-grid старта : snap-to-grid финиша : топология маршрута), первые 16 символов — группирует концептуально одинаковые маршруты (10.0). Дубликаты отклоняются по clientId до расчёта метрик (3.4). Гео-охват — BoundingBox (8.1) по крайним точкам записи.
        </p>
      </div>
    </section>
  );
}

// === A3: Сводка качества данных ===
function A3QualitySummaryBlock() {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">A3</span>
        <span className="sec-title">Сводка качества данных</span>
        <span className="sec-sub">92 сессии · июнь–август</span>
      </div>
      <div className="card">
        <div className="stats-grid" style={{ marginTop: 0 }}>
          <div className="stat">
            <div className="v c-plum">87%</div>
            <div className="l">сессий с высокой надёжностью (&gt;0,85)</div>
          </div>
          <div className="stat">
            <div className="v">
              7,8 <span className="u">м</span>
            </div>
            <div className="l">средняя точность P90 по парку сессий</div>
          </div>
          <div className="stat">
            <div className="v">1,7/с</div>
            <div className="l">средняя плотность точек</div>
          </div>
          <div className="stat">
            <div className="v c-amber">9</div>
            <div className="l">сессий требуют внимания (&lt;0,6)</div>
          </div>
        </div>
        <p className="pf-note" style={{ marginTop: 12 }}>
          Худшая запись: 14 авг · 21:07 — полнота 64%, два разрыва по 40+ сек, дрейф на стоянке. Метрики этой сессии помечены низким индексом доверия и исключены из сравнительных агрегатов маршрута.
        </p>
      </div>
    </section>
  );
}

// === A4: Пайплайн маршрутизации ===
function A4PipelineBlock() {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">A4</span>
        <span className="sec-title">Пайплайн маршрутизации</span>
        <span className="sec-sub">источники плана · цепочка 13</span>
      </div>
      <div className="card">
        <div className="pipe-bar">
          <i style={{ width: "76%", background: "#8E2D4E" }} title="2ГИС carrouting 6.0.0" />
          <i style={{ width: "17%", background: "#A85D8A" }} title="OSRM Demo Server" />
          <i style={{ width: "7%", background: "#D9C6D2" }} title="Гаверсинус 40 км/ч" />
        </div>
        <div className="pipe-leg">
          <span>
            <em style={{ background: "#8E2D4E" }} />
            2ГИС · 70 сессий
          </span>
          <span>
            <em style={{ background: "#A85D8A" }} />
            OSRM · 16 сессий
          </span>
          <span>
            <em style={{ background: "#D9C6D2" }} />
            гаверсинус · 6 сессий
          </span>
        </div>
        <div className="stats-grid" style={{ marginTop: 0 }}>
          <div className="stat">
            <div className="v c-plum">71%</div>
            <div className="l">попаданий в кэш маршрутов (14)</div>
          </div>
          <div className="stat">
            <div className="v">412 мс</div>
            <div className="l">медиана ответа 2ГИС</div>
          </div>
          <div className="stat">
            <div className="v">3</div>
            <div className="l">ретрая на отказ провайдера</div>
          </div>
          <div className="stat">
            <div className="v c-amber">2,1%</div>
            <div className="l">запросов упало до гаверсинуса</div>
          </div>
        </div>
      </div>
    </section>
  );
}

// === A5: Импорт ===
function A5ImportBlock() {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">A5</span>
        <span className="sec-title">Импорт данных</span>
        <span className="sec-sub">CSV / ZIP-архивы SensorLogger</span>
      </div>
      <div className="card">
        <div className="legacy-grid-2col">
          <div>
            <h4 style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 8, color: "var(--ink)" }}>
              <Upload className="h-3.5 w-3.5" style={{ display: "inline", marginRight: 6, verticalAlign: -2 }} />
              CSV-импорт
            </h4>
            <CsvImport />
          </div>
          <div>
            <h4 style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 8, color: "var(--ink)" }}>
              <Upload className="h-3.5 w-3.5" style={{ display: "inline", marginRight: 6, verticalAlign: -2 }} />
              ZIP-импорт
            </h4>
            <ZipImport />
          </div>
        </div>
      </div>
    </section>
  );
}

// === Legacy: Состояние системы ===
function SystemInfoLegacyCard() {
  const { data: health } = useHealth();
  const { data: stats } = useStats();

  const items = [
    {
      icon: <Activity className="h-3.5 w-3.5" />,
      label: "Статус системы",
      value: health?.status === "ok" ? "OK" : health?.status || "—",
      color: health?.status === "ok" ? "var(--plum)" : "var(--amber)",
    },
    {
      icon: <Cpu className="h-3.5 w-3.5" />,
      label: "БД",
      value: health?.db === "ok" ? "OK" : health?.db || "—",
      color: health?.db === "ok" ? "var(--plum)" : "var(--amber)",
    },
    {
      icon: <Server className="h-3.5 w-3.5" />,
      label: "Worker",
      value: health?.worker === "ok" ? "OK" : health?.worker || "—",
      color: health?.worker === "ok" ? "var(--plum)" : "var(--amber)",
    },
    {
      icon: <Activity className="h-3.5 w-3.5" />,
      label: "Uptime",
      value: health ? `${Math.round(health.uptime / 60)} мин` : "—",
    },
    {
      icon: <GitBranch className="h-3.5 w-3.5" />,
      label: "Версия",
      value: health?.version || "—",
    },
    {
      icon: <Database className="h-3.5 w-3.5" />,
      label: "Сессий (всего)",
      value: stats ? fmtNumber(stats.totalSessions) : "—",
    },
    {
      icon: <HardDrive className="h-3.5 w-3.5" />,
      label: "GPS-точек (всего)",
      value: stats ? fmtNumber(stats.totalPoints) : "—",
    },
    {
      icon: <Hash className="h-3.5 w-3.5" />,
      label: "TrafficJob dead",
      value: stats ? String(stats.deadJobs) : "—",
      color: (stats?.deadJobs ?? 0) > 0 ? "var(--red)" : undefined,
    },
    {
      icon: <Zap className="h-3.5 w-3.5" />,
      label: "Rate limit (ingest)",
      value: stats ? `${stats.capacity.rateLimitMaxIngest}/мин` : "—",
    },
    {
      icon: <Zap className="h-3.5 w-3.5" />,
      label: "Target load",
      value: stats ? `${stats.capacity.targetLoadRpm} сесс/мин` : "—",
    },
  ];

  return (
    <div className="legacy-card">
      <h3>
        <span className="num">L1</span>
        <Server className="h-4 w-4" style={{ color: "var(--plum)" }} />
        Состояние системы
      </h3>
      <div className="desc">Live-данные с /api/health и /api/stats. Обновляется автоматически.</div>
      <div className="stats-grid" style={{ marginTop: 0 }}>
        {items.map((it, i) => (
          <div className="stat" key={i}>
            <div className="v" style={{ color: it.color }}>
              {it.value}
            </div>
            <div className="l">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                {it.icon}
                {it.label}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// === Legacy: Настройки маршрутизации ===
function RoutingSettingsLegacyCard() {
  const { data, isLoading, isFetching, refetch } = useSettings();
  const updateMut = useUpdateSetting();
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [reveal, setReveal] = React.useState<Record<string, boolean>>({});

  const settings = data?.settings || [];

  React.useEffect(() => {
    if (settings.length > 0 && Object.keys(drafts).length === 0) {
      const init: Record<string, string> = {};
      for (const s of settings) init[s.key] = s.value;
      setDrafts(init);
    }
  }, [settings, drafts]);

  async function handleSave(key: string) {
    const value = drafts[key];
    if (value === undefined) return;
    try {
      await updateMut.mutateAsync({ key, value });
      toast.success(`Настройка обновлена: ${key}`);
    } catch (e) {
      toast.error("Ошибка сохранения", { description: (e as Error).message });
    }
  }

  return (
    <div className="legacy-card">
      <h3>
        <span className="num">L2</span>
        <SettingsIcon className="h-4 w-4" style={{ color: "var(--plum)" }} />
        Настройки маршрутизации
      </h3>
      <div className="desc">
        Переопределяемые параметры 2ГИС/OSRM. Сохраняются в БД (Setting). Изменения применяются без перезапуска.
      </div>
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full shimmer" />
          ))}
        </div>
      ) : settings.length === 0 ? (
        <div className="text-center py-6 text-sm" style={{ color: "var(--muted)" }}>
          <SettingsIcon className="h-8 w-8 mx-auto mb-2 opacity-30" />
          Нет переопределяемых настроек
        </div>
      ) : (
        <div className="space-y-2">
          {settings.map((s) => (
            <div key={s.key} className="space-y-1">
              <Label htmlFor={s.key} className="text-xs flex items-center gap-2" style={{ color: "var(--muted)" }}>
                <code style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--plum)" }}>{s.key}</code>
                <span className="text-[10px]" style={{ color: "var(--faint)" }}>
                  — источник: {s.source}{s.isSensitive ? " · секрет" : ""}
                </span>
              </Label>
              <div className="flex gap-2">
                <Input
                  id={s.key}
                  type={s.isSensitive && !reveal[s.key] ? "password" : "text"}
                  value={drafts[s.key] ?? ""}
                  onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
                  className="font-mono text-xs h-8"
                  style={{ background: "var(--wash)", borderColor: "var(--line)", color: "var(--text)" }}
                />
                {s.isSensitive && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setReveal({ ...reveal, [s.key]: !reveal[s.key] })}
                    className="h-8 w-8 p-0"
                    title={reveal[s.key] ? "Скрыть" : "Показать"}
                  >
                    {reveal[s.key] ? "−" : "+"}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleSave(s.key)}
                  disabled={updateMut.isPending}
                  className="h-8"
                  title="Сохранить"
                >
                  <ShieldCheck className="h-3.5 w-3.5" style={{ color: "var(--plum)" }} />
                </Button>
              </div>
              {s.updatedAt && (
                <p className="text-[10px]" style={{ color: "var(--faint)" }}>
                  Обновлено: {fmtDate(s.updatedAt)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => refetch()}
          disabled={isFetching}
          className="gap-1.5"
        >
          {isFetching ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Обновить
        </Button>
      </div>
    </div>
  );
}

// === Legacy: Резервные копии ===
function BackupsLegacyCard() {
  const { data, isLoading, isFetching, refetch } = useBackups();
  const createMut = useCreateBackup();

  async function handleCreate() {
    try {
      const res = await createMut.mutateAsync();
      toast.success("Backup создан", {
        description: `${res.backupId.slice(0, 12)}… · ${res.fileSize ? fmtBytes(res.fileSize) : "—"}`,
      });
    } catch (e) {
      toast.error("Ошибка backup", { description: (e as Error).message });
    }
  }

  const backups = data?.backups || [];

  return (
    <div className="legacy-card">
      <h3>
        <span className="num">L3</span>
        <Database className="h-4 w-4" style={{ color: "var(--plum)" }} />
        Резервные копии
      </h3>
      <div className="desc">Логический дамп БД. Лимит 1/час (rate-limit на ADMIN_TOKEN).</div>
      <div className="space-y-3">
        <Button
          onClick={handleCreate}
          disabled={createMut.isPending}
          className="w-full"
          style={{ background: "var(--plum)", color: "var(--fg-on-dark)" }}
          variant="default"
        >
          {createMut.isPending ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin" /> Создание дампа…
            </>
          ) : (
            <>
              <Database className="h-4 w-4" /> Создать backup
            </>
          )}
        </Button>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : backups.length === 0 ? (
          <div className="text-center py-6 text-sm" style={{ color: "var(--muted)" }}>
            <Database className="h-8 w-8 mx-auto mb-2 opacity-30" />
            Пока нет backup'ов
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto scroll-telem -mx-2">
            <ul className="space-y-1.5 px-2">
              <AnimatePresence>
                {backups.map((b) => (
                  <motion.li
                    key={b.id}
                    layout
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    className="rounded-lg border p-2.5 text-xs space-y-1"
                    style={{ borderColor: "var(--line)", background: "var(--wash)" }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] truncate" style={{ color: "var(--muted)" }}>
                        {b.id}
                      </span>
                      <span
                        className={cn("text-[10px] px-2 py-0.5 rounded", b.status === "completed" ? "c-plum" : b.status === "failed" ? "c-red" : "c-amber")}
                        style={{
                          background: b.status === "completed" ? "var(--plum-dim)" : b.status === "failed" ? "var(--red-dim)" : "var(--amber-dim)",
                        }}
                      >
                        {b.status === "completed" ? <CheckCircle2 className="h-2.5 w-2.5 inline mr-1" /> : b.status === "failed" ? <AlertCircle className="h-2.5 w-2.5 inline mr-1" /> : null}
                        {b.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] flex-wrap" style={{ color: "var(--muted)" }}>
                      <span className="inline-flex items-center gap-1">
                        <HardDrive className="h-3 w-3" />
                        {b.fileSize ? fmtBytes(b.fileSize) : "—"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Hash className="h-3 w-3" />
                        {b.checksum ? b.checksum.slice(0, 12) : "—"}
                      </span>
                      <span>{fmtDate(b.createdAt)}</span>
                    </div>
                    {b.error && (
                      <div className="text-[10px] font-mono c-red">{b.error}</div>
                    )}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </div>
        )}
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching} className="gap-1.5">
          {isFetching ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Обновить
        </Button>
      </div>
    </div>
  );
}

// === Legacy: GitHub Backup ===
function GitHubBackupLegacyCard() {
  const { data, isLoading, isFetching, refetch } = useGitHubBackups();
  const createMut = useCreateGitHubBackup();

  async function handleCreate() {
    try {
      const res = await createMut.mutateAsync();
      toast.success("Backup загружен на GitHub", {
        description: `${res.backupId.slice(0, 12)}… · ${fmtBytes(res.assetSize)}`,
      });
    } catch (e) {
      toast.error("Ошибка GitHub backup", { description: (e as Error).message });
    }
  }

  const configured = data?.configured !== false;
  const backups = data?.backups || [];

  return (
    <div className="legacy-card">
      <h3>
        <span className="num">L4</span>
        <Github className="h-4 w-4" style={{ color: "var(--plum)" }} />
        GitHub Backup
      </h3>
      <div className="desc">Резервные копии в GitHub Releases. Требуется GITHUB_TOKEN.</div>
      {!configured ? (
        <div
          className="rounded-lg p-3 text-xs flex items-start gap-2"
          style={{ background: "var(--amber-dim)", border: "1px solid var(--amber)", color: "var(--amber)" }}
        >
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">GITHUB_TOKEN не настроен</div>
            <p className="mt-0.5 opacity-80">
              Установите <code style={{ fontFamily: "var(--mono)" }}>GITHUB_TOKEN</code> и{" "}
              <code style={{ fontFamily: "var(--mono)" }}>GITHUB_REPO</code>.
            </p>
          </div>
        </div>
      ) : (
        <>
          <Button
            onClick={handleCreate}
            disabled={createMut.isPending}
            className="w-full gap-1.5"
            style={{ background: "var(--plum)", color: "var(--fg-on-dark)" }}
            variant="default"
          >
            {createMut.isPending ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" /> Загрузка на GitHub…
              </>
            ) : (
              <>
                <Github className="h-4 w-4" /> Создать backup на GitHub
              </>
            )}
          </Button>
          {isLoading ? (
            <div className="space-y-2 mt-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : backups.length === 0 ? (
            <div className="text-center py-6 text-sm mt-3" style={{ color: "var(--muted)" }}>
              <Github className="h-8 w-8 mx-auto mb-2 opacity-30" />
              Пока нет GitHub backup'ов
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto scroll-telem mt-3 -mx-2">
              <ul className="space-y-1.5 px-2">
                {backups.map((b) => (
                  <li
                    key={b.backupId}
                    className="rounded-lg border p-2.5 text-xs space-y-1"
                    style={{ borderColor: "var(--line)", background: "var(--wash)" }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] truncate" style={{ color: "var(--muted)" }}>
                        {b.tagName || b.backupId.slice(0, 12)}
                      </span>
                      <span
                        className="text-[10px] px-2 py-0.5 rounded c-plum"
                        style={{ background: "var(--plum-dim)" }}
                      >
                        <CheckCircle2 className="h-2.5 w-2.5 inline mr-1" />
                        release
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] flex-wrap" style={{ color: "var(--muted)" }}>
                      <span className="inline-flex items-center gap-1">
                        <HardDrive className="h-3 w-3" />
                        {fmtBytes(b.assetSize)}
                      </span>
                      {b.checksum && (
                        <span className="inline-flex items-center gap-1">
                          <Hash className="h-3 w-3" />
                          {b.checksum.slice(0, 12)}
                        </span>
                      )}
                      <span>{fmtDate(b.createdAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching} className="gap-1.5">
          {isFetching ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Обновить
        </Button>
      </div>
    </div>
  );
}

// === Legacy: Requeue TrafficJob ===
function RequeueLegacyCard() {
  const [jobId, setJobId] = React.useState("");
  const requeueMut = useRequeueJob();

  async function handleRequeue() {
    if (!jobId.trim()) {
      toast.error("Введите Job ID");
      return;
    }
    try {
      const res = await requeueMut.mutateAsync(jobId.trim());
      toast.success("Задача перезапущена", {
        description: `${res.jobId.slice(0, 12)}… → ${res.status}`,
      });
      setJobId("");
    } catch (e) {
      toast.error("Ошибка requeue", { description: (e as Error).message });
    }
  }

  return (
    <div className="legacy-card">
      <h3>
        <span className="num">L5</span>
        <RotateCcw className="h-4 w-4" style={{ color: "var(--plum)" }} />
        Requeue TrafficJob
      </h3>
      <div className="desc">Перезапуск «мёртвых» (dead/failed) задач получения пробок.</div>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="job-id" className="text-xs" style={{ color: "var(--muted)" }}>
            Job ID
          </Label>
          <Input
            id="job-id"
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            placeholder="cmt73676l0000rhh6nqzgjpab"
            className="font-mono text-xs"
            style={{ background: "var(--wash)", borderColor: "var(--line)", color: "var(--text)" }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRequeue();
            }}
          />
        </div>
        <Button
          onClick={handleRequeue}
          disabled={requeueMut.isPending || !jobId.trim()}
          className="w-full"
          variant="default"
          style={{ background: "var(--plum)", color: "var(--fg-on-dark)" }}
        >
          {requeueMut.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
          Перезапустить
        </Button>
        <div
          className="rounded-lg p-3 text-xs space-y-1"
          style={{ background: "var(--wash)", border: "1px solid var(--line)" }}
        >
          <div className="flex items-center gap-1.5 font-medium" style={{ color: "var(--plum)" }}>
            <ShieldCheck className="h-3.5 w-3.5" />
            Защита
          </div>
          <p style={{ color: "var(--muted)" }}>
            Requeue доступен только для задач в статусе <code style={{ fontFamily: "var(--mono)" }}>dead</code> или{" "}
            <code style={{ fontFamily: "var(--mono)" }}>failed</code>. Атомарное обнуление attempts и lockedBy. Лимит 10/мин.
          </p>
        </div>
      </div>
    </div>
  );
}
