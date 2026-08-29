"use client";

// src/components/settings-card.tsx — runtime-overridable settings (DB-backed).

import * as React from "react";
import { motion } from "framer-motion";
import { Settings as SettingsIcon, Eye, EyeOff, Loader2, Save, ShieldCheck, Database } from "lucide-react";
import { toast } from "sonner";
import { useSettings, useUpdateSetting } from "@/lib/hooks";
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
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/format";

export function SettingsCard() {
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
    <Card className="elev-1">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="icon-chip h-6 w-6"><SettingsIcon className="h-4 w-4" /></span>
              Настройки маршрутизации
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Переопределяемые параметры: 2ГИС, OSRM. Сохраняются в БД (Setting).
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-1.5"
          >
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Database className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full shimmer" />
            ))}
          </div>
        ) : settings.length === 0 ? (
          <div className="empty-state py-8 text-xs text-muted-foreground">
            <SettingsIcon className="h-8 w-8 mb-2 opacity-30" />
            Настроек не найдено
          </div>
        ) : (
          settings.map((s, i) => {
            const isRevealed = reveal[s.key] ?? !s.isSensitive;
            const value = drafts[s.key] ?? s.value;
            const dirty = value !== s.value;
            return (
              <motion.div
                key={s.key}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                className={cn(
                  "metric-tile relative overflow-hidden rounded-lg border p-3 space-y-2",
                  dirty ? "border-primary/40 bg-primary/5" : "bg-card/40 hover:bg-card"
                )}
              >
                {/* акцентная линия сверху (ярче при dirty) */}
                <div className={cn("absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r to-transparent", dirty ? "from-primary/60" : "from-primary/30 opacity-60")} />
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`set-${s.key}`} className="text-xs font-mono">
                    {s.key}
                  </Label>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[9px]">
                      {s.source === "db" ? "DB" : "env"}
                    </Badge>
                    {s.isSensitive && (
                      <Badge variant="outline" className="text-[9px] bg-amber-500/10 text-amber-700 dark:text-amber-400">
                        secret
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Input
                    id={`set-${s.key}`}
                    type={isRevealed ? "text" : "password"}
                    value={value}
                    onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
                    className="font-mono text-xs h-9"
                    placeholder="не задано"
                  />
                  {s.isSensitive && (
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      className="h-9 w-9 p-0"
                      onClick={() => setReveal({ ...reveal, [s.key]: !isRevealed })}
                    >
                      {isRevealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={dirty ? "default" : "outline"}
                    type="button"
                    disabled={!dirty || updateMut.isPending}
                    onClick={() => handleSave(s.key)}
                    className="h-9 gap-1"
                  >
                    {updateMut.isPending && updateMut.variables?.key === s.key ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
                {s.updatedAt && (
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <ShieldCheck className="h-2.5 w-2.5" />
                    Обновлено: {fmtDate(s.updatedAt)}
                  </div>
                )}
              </motion.div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
