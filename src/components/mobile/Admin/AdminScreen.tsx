"use client";

// src/components/mobile/Admin/AdminScreen.tsx
// Mobile admin screen: system health + settings + GitHub backup + logout.

import * as React from "react";
import { motion } from "framer-motion";
import {
  ChevronLeft,
  LogOut,
  Server,
  Activity,
  Cpu,
  GitBranch,
  Database,
  HardDrive,
  Hash,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useHealth, useStats, useSettings, useUpdateSetting, useGitHubBackups, useCreateGitHubBackup } from "@/lib/hooks";
import { api } from "@/lib/api-client";
import { SettingsCard } from "@/components/settings-card";
import { GitHubBackupCard } from "@/components/github-backup-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fmtNumber, fmtBytes } from "@/lib/format";

interface AdminScreenProps {
  onBack: () => void;
  onLogout: () => void;
}

export function AdminScreen({ onBack, onLogout }: AdminScreenProps) {
  const { data: health } = useHealth();
  const { data: stats } = useStats();

  const items = [
    {
      icon: <Activity className="h-3.5 w-3.5" />,
      label: "Статус",
      value: health?.status === "ok" ? "OK" : health?.status || "—",
      color: health?.status === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
    },
    {
      icon: <Cpu className="h-3.5 w-3.5" />,
      label: "БД",
      value: health?.db === "ok" ? "OK" : health?.db || "—",
      color: health?.db === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
    },
    {
      icon: <Server className="h-3.5 w-3.5" />,
      label: "Worker",
      value: health?.worker === "ok" ? "OK" : health?.worker || "—",
      color: health?.worker === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
    },
    {
      icon: <GitBranch className="h-3.5 w-3.5" />,
      label: "Версия",
      value: health?.version || "—",
    },
    {
      icon: <Database className="h-3.5 w-3.5" />,
      label: "Поездок",
      value: stats ? fmtNumber(stats.totalSessions) : "—",
    },
    {
      icon: <HardDrive className="h-3.5 w-3.5" />,
      label: "Точек",
      value: stats ? fmtNumber(stats.totalPoints) : "—",
    },
    {
      icon: <Hash className="h-3.5 w-3.5" />,
      label: "Dead jobs",
      value: stats ? String(stats.deadJobs) : "—",
      color: (stats?.deadJobs ?? 0) > 0 ? "text-red-600 dark:text-red-400" : "",
    },
    {
      icon: <Zap className="h-3.5 w-3.5" />,
      label: "Ingest rate",
      value: stats ? `${stats.capacity.rateLimitMaxIngest}/мин` : "—",
    },
  ];

  async function handleLogout() {
    try {
      await api.post("/api/auth/logout", undefined, { expect: "none" });
      toast.success("Вы вышли из системы");
      onLogout();
    } catch (e) {
      toast.error("Ошибка выхода", { description: (e as Error).message });
    }
  }

  return (
    <div className="flex flex-col h-full pb-16">
      <header className="sticky top-0 z-20 bg-card/95 backdrop-blur-md border-b safe-top">
        <div className="flex items-center justify-between h-14 px-2">
          <button
            onClick={onBack}
            className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center"
            aria-label="Назад"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <h1 className="text-[22px] font-bold">Администрирование</h1>
          <div className="w-11" />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto scroll-telem p-4 space-y-4">
        {/* System health */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <h2 className="text-sm font-semibold mb-3 text-muted-foreground">Состояние системы</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {items.map((it, i) => (
              <div
                key={i}
                className="rounded-lg border bg-card p-2.5 space-y-1"
              >
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  {it.icon}
                  <span className="truncate">{it.label}</span>
                </div>
                <div className={cn("text-sm font-semibold tabular-nums truncate", it.color || "")}>
                  {it.value}
                </div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Settings */}
        <SettingsCard />

        {/* GitHub backup */}
        <GitHubBackupCard />

        {/* Logout */}
        <Button
          variant="outline"
          className="w-full gap-2 text-destructive hover:bg-destructive/10"
          onClick={handleLogout}
        >
          <LogOut className="h-4 w-4" /> Выйти из системы
        </Button>
      </div>
    </div>
  );
}
