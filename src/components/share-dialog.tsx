"use client";

// src/components/share-dialog.tsx — диалог создания shareable ссылки на сессию.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Share2, Copy, Check, ExternalLink, Loader2, Link2, Clock } from "lucide-react";
import { toast } from "sonner";
import { useCreateShareLink } from "@/lib/hooks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ShareDialogProps {
  sessionId: string;
  children?: React.ReactNode;
}

export function ShareDialog({ sessionId, children }: ShareDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [shareUrl, setShareUrl] = React.useState<string | null>(null);
  const [expiresAt, setExpiresAt] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const createMut = useCreateShareLink();

  React.useEffect(() => {
    if (!open) {
      setShareUrl(null);
      setExpiresAt(null);
      setCopied(false);
    }
  }, [open]);

  async function handleCreate() {
    try {
      const result = await createMut.mutateAsync(sessionId);
      const fullUrl = `${window.location.origin}${result.url}`;
      setShareUrl(fullUrl);
      setExpiresAt(result.expiresAt);
      toast.success("Ссылка создана", {
        description: "Действительна 7 дней",
      });
    } catch (e) {
      toast.error("Ошибка создания ссылки", { description: (e as Error).message });
    }
  }

  async function copyToClipboard() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success("Ссылка скопирована");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Не удалось скопировать");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children || (
          <Button size="sm" variant="outline" className="gap-1.5">
            <Share2 className="h-3.5 w-3.5" /> Поделиться
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4 text-primary" />
            Поделиться сессией
          </DialogTitle>
          <DialogDescription className="text-xs">
            Создайте публичную ссылку для просмотра сессии без авторизации.
            Ссылка действительна 7 дней.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!shareUrl ? (
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5 text-xs">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Link2 className="h-3 w-3" />
                  <span>Будет создана публичная ссылка</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  <span>Срок действия: 7 дней</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <ExternalLink className="h-3 w-3" />
                  <span>Доступ без авторизации</span>
                </div>
              </div>
              <Button
                onClick={handleCreate}
                disabled={createMut.isPending}
                className="w-full gap-2"
              >
                {createMut.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Share2 className="h-4 w-4" />
                )}
                Создать ссылку
              </Button>
            </div>
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-3"
            >
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Публичная ссылка:</label>
                <div className="flex gap-2">
                  <Input
                    value={shareUrl}
                    readOnly
                    className="text-xs font-mono"
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={copyToClipboard}
                    className="shrink-0"
                    title={copied ? "Скопировано" : "Копировать"}
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>

              {expiresAt && (
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  <span>
                    Действует до:{" "}
                    <span className="font-mono">
                      {new Date(expiresAt).toLocaleString("ru-RU")}
                    </span>
                  </span>
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 gap-1.5"
                  onClick={() => window.open(shareUrl, "_blank")}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Открыть
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 gap-1.5"
                  onClick={handleCreate}
                  disabled={createMut.isPending}
                >
                  <Loader2 className={cn("h-3.5 w-3.5", createMut.isPending ? "animate-spin" : "hidden")} />
                  Обновить
                </Button>
              </div>

              <Badge variant="outline" className="text-[9px] gap-1 bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30">
                <Clock className="h-2.5 w-2.5" />
                Публичный доступ — не требует входа
              </Badge>
            </motion.div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
