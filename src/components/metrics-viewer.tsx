"use client";

// src/components/metrics-viewer.tsx — парсинг Prometheus text exposition и таблица метрик.

import * as React from "react";
import { motion } from "framer-motion";
import { Activity, RefreshCw, Search, TrendingUp, Gauge } from "lucide-react";
import { useMetrics } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

interface MetricFamily {
  name: string;
  help: string;
  type: string; // counter | gauge | histogram | summary | untyped
  samples: MetricSample[];
}

function parsePrometheus(text: string): MetricFamily[] {
  const families: MetricFamily[] = [];
  const familyMap = new Map<string, MetricFamily>();

  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("# HELP ")) {
      const rest = line.slice(7);
      const sp = rest.indexOf(" ");
      const name = rest.slice(0, sp);
      const help = rest.slice(sp + 1);
      let f = familyMap.get(name);
      if (!f) {
        f = { name, help: "", type: "untyped", samples: [] };
        familyMap.set(name, f);
        families.push(f);
      }
      f.help = help;
      continue;
    }
    if (line.startsWith("# TYPE ")) {
      const rest = line.slice(7);
      const sp = rest.indexOf(" ");
      const name = rest.slice(0, sp);
      const type = rest.slice(sp + 1);
      let f = familyMap.get(name);
      if (!f) {
        f = { name, help: "", type: "untyped", samples: [] };
        familyMap.set(name, f);
        families.push(f);
      }
      f.type = type;
      continue;
    }
    if (line.startsWith("#")) continue;
    // metric line: name{labels} value [timestamp]
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/);
    if (!m) continue;
    const [, name, labelStr, valStr] = m;
    const labels: Record<string, string> = {};
    if (labelStr) {
      const inner = labelStr.slice(1, -1);
      // split on commas not inside quotes
      const re = /(\w+)="([^"]*)"/g;
      let lm: RegExpExecArray | null;
      while ((lm = re.exec(inner)) !== null) {
        labels[lm[1]] = lm[2];
      }
    }
    const value = Number(valStr);
    if (isNaN(value)) continue;
    let f = familyMap.get(name);
    if (!f) {
      f = { name, help: "", type: "untyped", samples: [] };
      familyMap.set(name, f);
      families.push(f);
    }
    f.samples.push({ name, labels, value });
  }
  return families;
}

function formatValue(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  if (Number.isInteger(v)) return v.toLocaleString("ru-RU");
  return v.toFixed(3);
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  counter: <TrendingUp className="h-3.5 w-3.5" />,
  gauge: <Gauge className="h-3.5 w-3.5" />,
  histogram: <Activity className="h-3.5 w-3.5" />,
  summary: <Activity className="h-3.5 w-3.5" />,
  untyped: <Activity className="h-3.5 w-3.5" />,
};

const TYPE_COLOR: Record<string, string> = {
  counter: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  gauge: "bg-teal-500/10 text-teal-700 dark:text-teal-400",
  histogram: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  summary: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  untyped: "bg-muted text-muted-foreground",
};

export function MetricsViewer() {
  const { data, isLoading, isFetching, refetch } = useMetrics();
  const [filter, setFilter] = React.useState("");

  const families = React.useMemo(() => (data ? parsePrometheus(data) : []), [data]);
  const filtered = React.useMemo(() => {
    if (!filter.trim()) return families;
    const q = filter.toLowerCase();
    return families.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.help.toLowerCase().includes(q) ||
        f.samples.some((s) =>
          Object.values(s.labels).some((v) => v.toLowerCase().includes(q))
        )
    );
  }, [families, filter]);

  const totalSamples = families.reduce((a, f) => a + f.samples.length, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Prometheus метрики</h3>
          <Badge variant="outline" className="text-[10px]">
            {families.length} метрик · {totalSamples} сэмплов
          </Badge>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="Фильтр по имени/лейблам…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pl-7 h-8 text-xs"
        />
      </div>

      <div className="rounded-lg border max-h-[520px] overflow-y-auto scroll-telem">
        {isLoading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <Activity className="h-8 w-8 mx-auto mb-2 opacity-30" />
            {filter ? "Ничего не найдено" : "Метрик нет"}
          </div>
        ) : (
          <ul className="divide-y">
            {filtered.map((f, idx) => (
              <motion.li
                key={f.name}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: Math.min(idx * 0.01, 0.2) }}
                className="p-3 hover:bg-muted/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-xs font-mono font-medium text-primary">
                        {f.name}
                      </code>
                      <Badge
                        variant="outline"
                        className={cn("text-[10px] gap-1", TYPE_COLOR[f.type] || "")}
                      >
                        {TYPE_ICON[f.type]}
                        {f.type}
                      </Badge>
                    </div>
                    {f.help && (
                      <p className="text-[11px] text-muted-foreground">{f.help}</p>
                    )}
                  </div>
                </div>
                {/* Сэмплы */}
                <div className="mt-2 space-y-1">
                  {f.samples.slice(0, 8).map((s, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-2 text-xs font-mono"
                    >
                      <div className="min-w-0 flex-1 flex items-center gap-1.5 flex-wrap">
                        {Object.entries(s.labels).map(([k, v]) => (
                          <span
                            key={k}
                            className="text-[10px] text-muted-foreground"
                          >
                            <span className="text-foreground/70">{k}</span>=
                            <span className="text-emerald-700 dark:text-emerald-400">
                              "{v}"
                            </span>
                          </span>
                        ))}
                      </div>
                      <span className="font-semibold text-foreground shrink-0">
                        {formatValue(s.value)}
                      </span>
                    </div>
                  ))}
                  {f.samples.length > 8 && (
                    <div className="text-[10px] text-muted-foreground">
                      … ещё {f.samples.length - 8} сэмплов
                    </div>
                  )}
                </div>
              </motion.li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
