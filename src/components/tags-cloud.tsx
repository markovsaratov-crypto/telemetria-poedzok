"use client";

// src/components/tags-cloud.tsx — облако тегов сессий с размером по частоте.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Tag, Hash } from "lucide-react";
import { useTagsStats } from "@/lib/hooks";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface TagsCloudProps {
  onSelect?: (tag: string) => void;
  selectedTag?: string | null;
}

export function TagsCloud({ onSelect, selectedTag }: TagsCloudProps) {
  const { data, isLoading } = useTagsStats();
  const tags = data?.tags || [];

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Hash className="h-4 w-4 text-primary" />
            Облако тегов
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-16 shimmer" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (tags.length === 0) {
    return null;
  }

  // Размер шрифта зависит от count (logarithmic scale)
  const maxCount = Math.max(...tags.map((t) => t.count), 1);
  const minCount = Math.min(...tags.map((t) => t.count), 1);

  function fontSize(count: number): string {
    if (maxCount === minCount) return "text-sm";
    const ratio = (count - minCount) / (maxCount - minCount);
    if (ratio >= 0.75) return "text-lg font-bold";
    if (ratio >= 0.5) return "text-base font-semibold";
    if (ratio >= 0.25) return "text-sm font-medium";
    return "text-xs font-normal";
  }

  function opacity(count: number): number {
    if (maxCount === minCount) return 1;
    const ratio = (count - minCount) / (maxCount - minCount);
    return 0.6 + ratio * 0.4;
  }

  // Цвет: emerald → teal → amber для топ-3, muted для остальных
  function colorClass(idx: number): string {
    if (idx === 0) return "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20";
    if (idx === 1) return "text-teal-600 dark:text-teal-400 bg-teal-500/10 hover:bg-teal-500/20";
    if (idx === 2) return "text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20";
    return "text-muted-foreground bg-muted/40 hover:bg-muted/60";
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Hash className="h-4 w-4 text-primary" />
              Облако тегов
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              {data?.total} тегов · {data?.totalSessions} сессий с тегами
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-1.5 items-center">
          <AnimatePresence>
            {tags.map((tag, idx) => {
              const isSelected = selectedTag === tag.name;
              return (
                <motion.button
                  key={tag.name}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: opacity(tag.count), scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ delay: idx * 0.02, duration: 0.2 }}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => onSelect?.(isSelected ? "" : tag.name)}
                  className={cn(
                    "inline-flex items-center gap-1 px-2 py-0.5 rounded-md transition-colors",
                    fontSize(tag.count),
                    isSelected
                      ? "bg-primary text-primary-foreground ring-2 ring-primary"
                      : colorClass(idx)
                  )}
                  title={`${tag.name}: ${tag.count} сессий`}
                >
                  <Tag className="h-3 w-3" />
                  {tag.name}
                  <span className="text-[9px] opacity-70 font-mono">({tag.count})</span>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </div>

        {selectedTag && (
          <div className="mt-3 pt-3 border-t flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              Фильтр по тегу:{" "}
              <span className="font-medium text-foreground">#{selectedTag}</span>
            </span>
            <button
              onClick={() => onSelect?.("")}
              className="text-muted-foreground hover:text-foreground underline"
            >
              сбросить
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
