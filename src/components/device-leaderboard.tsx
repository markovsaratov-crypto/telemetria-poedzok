"use client";

// src/components/device-leaderboard.tsx — топ устройств по активности.

import * as React from "react";
import { motion } from "framer-motion";
import { Trophy, Smartphone, Activity, HardDrive, Clock } from "lucide-react";
import { useDeviceStats } from "@/lib/hooks";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { fmtDate, fmtBytes, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const RANK_STYLES = [
  { bg: "bg-amber-500/15", text: "text-amber-600 dark:text-amber-400", icon: "🥇" },
  { bg: "bg-zinc-400/15", text: "text-zinc-600 dark:text-zinc-300", icon: "🥈" },
  { bg: "bg-orange-700/15", text: "text-orange-700 dark:text-orange-400", icon: "🥉" },
];

export function DeviceLeaderboard() {
  const { data, isLoading } = useDeviceStats();
  const devices = data?.devices || [];

  const maxSessions = Math.max(...devices.map((d) => d.sessionCount), 1);

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Trophy className="h-4 w-4 text-amber-500" />
            Лидеры устройств
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full shimmer" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (devices.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Trophy className="h-4 w-4 text-amber-500" />
          Лидеры устройств
        </CardTitle>
        <CardDescription className="text-xs">
          Топ-{devices.length} по количеству сессий
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {devices.map((d, idx) => {
            const rank = RANK_STYLES[idx] || null;
            const pct = (d.sessionCount / maxSessions) * 100;
            return (
              <motion.li
                key={d.deviceId}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.04 }}
                className="p-3 hover:bg-accent/30 transition-colors"
              >
                <div className="flex items-center gap-3">
                  {/* Rank badge */}
                  <div
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold shrink-0",
                      rank ? rank.bg : "bg-muted",
                      rank ? rank.text : "text-muted-foreground"
                    )}
                  >
                    {rank ? rank.icon : idx + 1}
                  </div>

                  {/* Device info */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium truncate flex items-center gap-1.5">
                        <Smartphone className="h-3 w-3 text-muted-foreground" />
                        {d.deviceName || d.deviceId}
                      </span>
                      <Badge variant="outline" className="text-[9px] shrink-0">
                        {fmtNumber(d.sessionCount)} сессий
                      </Badge>
                    </div>

                    {/* Progress bar */}
                    <div className="h-1 rounded-full bg-muted overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ delay: idx * 0.04 + 0.1, duration: 0.4, ease: "easeOut" }}
                        className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full"
                      />
                    </div>

                    {/* Stats row */}
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Activity className="h-2.5 w-2.5" />
                        {fmtNumber(d.totalPoints)} тчк
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <HardDrive className="h-2.5 w-2.5" />
                        {fmtBytes(d.totalBytes)}
                      </span>
                      {d.lastActivity && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-2.5 w-2.5" />
                          {fmtDate(d.lastActivity)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </motion.li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
