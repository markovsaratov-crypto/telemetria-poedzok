"use client";

// src/components/settings-card.tsx — runtime-overridable settings (2ГИС ключ, OSRM URL).
// Позволяет менять ключ 2ГИС прямо из UI без redeploy.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Key,
  Globe,
  Save,
  Loader2,
  Eye,
  EyeOff,
  CheckCircle2,
  Database,
  Settings as SettingsIcon,
  ExternalLink,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { useSettings, useUpdateSetting, type SettingItem } from "@/lib/hooks";
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
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const KEY_LABELS: Record<string, { label: string; description: string; placeholder: string; link?: string }> = {
  TWO_GIS_API_KEY: {
    label: "2ГИС API ключ",
    description: "Ключ для routing API 2ГИС (traffic-aware). Получить на developer.2gis.ru",
    placeholder: "RUME… (32+ символов)",
    link: "https://developer.2gis.ru/order-key/",
  },
  OSRM_BASE_URL: {
    label: "OSRM базовый URL",
    description: "Сервер OSRM для fallback-маршрутизации (без пробок)",
    placeholder: "https://router.project-osrm.org",
  },
};

export function SettingsCard() {
  const { data, isLoading, isFetching, refetch } = useSettings();
  const updateMut = useUpdateSetting();
  const [editingKey, setEditingKey] = React.useState<string | null>(null);
  const [draftValue, setDraftValue] = React.useState("");
  const [showValue, setShowValue] = React.useState(false);

  const settings = data?.settings || [];

  function startEdit(s: SettingItem) {
    setEditingKey(s.key);
    // Для sensitive ключей НЕ подставляем текущее значение — пользователь вводит заново.
    setDraftValue(s.isSensitive ? "" : s.value);
    setShowValue(false);
  }

  function cancelEdit() {
    setEditingKey(null);
    setDraftValue("");
    setShowValue(false);
  }

  async function saveEdit(key: string) {
    if (!draftValue.trim()) {
      toast.error("Введите значение");
      return;
    }
    try {
      const res = await updateMut.mutateAsync({ key, value: draftValue.trim() });
      toast.success(`${KEY_LABELS[key]?.label || key} обновлён`, {
        description: `Source: ${res.source} · ${fmtDate(res.updatedAt)}`,
      });
      cancelEdit();
    } catch (e) {
      toast.error("Ошибка сохранения", { description: (e as Error).message });
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <SettingsIcon className="h-4 w-4 text-primary" />
              Настройки
            </CardTitle>
            <CardDescription className="text-xs">
              Runtime-настройки. Меняются без redeploy. Хранятся в БД, кэшируются в памяти 60с.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => refetch()}
            disabled={isFetching}
            title="Обновить"
          >
            <RotateCcw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : settings.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground">
            <SettingsIcon className="h-8 w-8 mx-auto mb-2 opacity-30" />
            Настроек не найдено
          </div>
        ) : (
          <div className="space-y-2.5">
            {settings.map((s) => {
              const meta = KEY_LABELS[s.key] || {
                label: s.key,
                description: "",
                placeholder: "",
              };
              const isEditing = editingKey === s.key;
              return (
                <motion.div
                  key={s.key}
                  layout
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "rounded-lg border p-3 space-y-2 transition-colors",
                    isEditing ? "border-primary bg-primary/5" : "bg-card/50"
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {s.key === "TWO_GIS_API_KEY" ? (
                        <Key className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                      ) : (
                        <Globe className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium truncate">{meta.label}</span>
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[9px] h-4 px-1 gap-0.5",
                              s.source === "db"
                                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                                : "bg-muted text-muted-foreground"
                            )}
                          >
                            {s.source === "db" ? (
                              <>
                                <Database className="h-2.5 w-2.5" /> DB
                              </>
                            ) : (
                              "env"
                            )}
                          </Badge>
                        </div>
                        <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                          {meta.description}
                        </p>
                        {meta.link && (
                          <a
                            href={meta.link}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-0.5 text-[10px] text-primary hover:underline mt-0.5"
                          >
                            получить ключ <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                        )}
                      </div>
                    </div>
                    {!isEditing && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs shrink-0"
                        onClick={() => startEdit(s)}
                      >
                        Изменить
                      </Button>
                    )}
                  </div>

                  <AnimatePresence mode="wait">
                    {isEditing ? (
                      <motion.div
                        key="edit"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="space-y-2 overflow-hidden"
                      >
                        <Label className="text-[10px] text-muted-foreground">
                          {s.isSensitive
                            ? "Новое значение (текущее не показывается для безопасности)"
                            : "Значение"}
                        </Label>
                        <div className="flex gap-2">
                          <div className="relative flex-1">
                            <Input
                              type={s.isSensitive && !showValue ? "password" : "text"}
                              value={draftValue}
                              onChange={(e) => setDraftValue(e.target.value)}
                              placeholder={meta.placeholder}
                              className="font-mono text-xs pr-8"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveEdit(s.key);
                                if (e.key === "Escape") cancelEdit();
                              }}
                            />
                            {s.isSensitive && (
                              <button
                                type="button"
                                onClick={() => setShowValue((v) => !v)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                title={showValue ? "Скрыть" : "Показать"}
                              >
                                {showValue ? (
                                  <EyeOff className="h-3.5 w-3.5" />
                                ) : (
                                  <Eye className="h-3.5 w-3.5" />
                                )}
                              </button>
                            )}
                          </div>
                          <Button
                            size="sm"
                            onClick={() => saveEdit(s.key)}
                            disabled={updateMut.isPending || !draftValue.trim()}
                          >
                            {updateMut.isPending ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Save className="h-3.5 w-3.5" />
                            )}
                            Сохранить
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={cancelEdit}
                            disabled={updateMut.isPending}
                          >
                            Отмена
                          </Button>
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="view"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="space-y-1"
                      >
                        <div className="flex items-center gap-2">
                          <code className="text-xs font-mono px-2 py-1 rounded bg-muted/60 break-all">
                            {s.value || <span className="text-muted-foreground italic">не задано</span>}
                          </code>
                          {s.source === "db" && s.updatedAt && (
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              {fmtDate(s.updatedAt)}
                            </span>
                          )}
                        </div>
                        {s.source === "env" && (
                          <p className="text-[10px] text-muted-foreground">
                            Значение из переменной окружения. После изменения — сохранится в БД и будет приоритетнее env.
                          </p>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        )}

        <div className="rounded-lg bg-muted/40 p-3 text-xs space-y-1">
          <div className="flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            Как это работает
          </div>
          <p className="text-muted-foreground leading-relaxed">
            Настройки хранятся в таблице <code>Setting</code> (БД) и кэшируются в памяти сервера 60 секунд.
            После изменения ключ 2ГИС подхватится in-process worker'ом на следующем poll-цикле (5 сек).
            Audit log фиксирует каждое изменение (без записи самого значения для sensitive ключей).
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
