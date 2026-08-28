"use client";

// src/components/github-backup-card.tsx — GitHub releases backup UI.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Github,
  Upload,
  RefreshCw,
  Loader2,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  HardDrive,
  Hash,
} from "lucide-react";
import { toast } from "sonner";
import { useGitHubBackups, useCreateGitHubBackup } from "@/lib/hooks";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtBytes, fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export function GitHubBackupCard() {
  const { data, isLoading, isFetching, refetch, error } = useGitHubBackups();
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
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Github className="h-4 w-4 text-primary" />
              GitHub Backup
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Резервные копии в GitHub Releases. Требуется GITHUB_TOKEN.
            </CardDescription>
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
      </CardHeader>
      <CardContent className="space-y-3">
        {!configured ? (
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">GITHUB_TOKEN не настроен</div>
              <p className="mt-0.5 opacity-80">
                Установите переменную окружения <code className="font-mono">GITHUB_TOKEN</code> и{" "}
                <code className="font-mono">GITHUB_REPO</code> для активации.
              </p>
            </div>
          </div>
        ) : (
          <Button
            onClick={handleCreate}
            disabled={createMut.isPending}
            className="w-full gap-1.5"
          >
            {createMut.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Загрузка на GitHub…
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" /> Создать backup на GitHub
              </>
            )}
          </Button>
        )}

        {error && (
          <div className="text-xs text-destructive flex items-center gap-1.5">
            <AlertCircle className="h-3 w-3" /> {(error as Error).message}
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : backups.length === 0 ? (
          configured && (
            <div className="text-center py-6 text-xs text-muted-foreground">
              <Github className="h-7 w-7 mx-auto mb-2 opacity-30" />
              Пока нет backup'ов на GitHub
            </div>
          )
        ) : (
          <div className="max-h-72 overflow-y-auto scroll-telem -mx-2">
            <ul className="space-y-1.5 px-2">
              <AnimatePresence>
                {backups.map((b) => (
                  <motion.li
                    key={b.backupId}
                    layout
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    className="rounded-lg border p-2.5 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] text-muted-foreground truncate">
                        {b.tagName}
                      </span>
                      <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
                        release
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                      <span className="inline-flex items-center gap-1">
                        <HardDrive className="h-3 w-3" />
                        {b.assetSize ? fmtBytes(b.assetSize) : "—"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Hash className="h-3 w-3" />
                        {b.checksum ? b.checksum.slice(0, 12) : "—"}
                      </span>
                      <span>{fmtDate(b.createdAt)}</span>
                    </div>
                    {b.assetUrl && (
                      <a
                        href={b.assetUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline text-[10px]"
                      >
                        <ExternalLink className="h-3 w-3" /> download
                      </a>
                    )}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
