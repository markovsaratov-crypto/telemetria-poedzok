"use client";

// src/components/v4/share-button.tsx — v2.38.1 (ревью F22): точка входа share-фичи.
// Серверный POST /api/sessions/[id]/share и публичная страница /shared/[token]
// существовали с P1-9, но useCreateShareLink не вызывался ни одним компонентом
// (rg по src — только определение): создать ссылку из UI было невозможно.
// Кнопка «Поделиться» в раскрытой карточке поездки: выбор срока (7/30 дней,
// дефолт 7) → POST → готовый URL с копированием в буфер (clipboard + fallback)
// и тостом. ru-локаль, shadcn Dialog + sonner — существующие паттерны проекта.

import * as React from "react";
import { Share2, Copy, Check, Loader2, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useCreateShareLink, type ShareResult } from "@/lib/hooks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ShareButtonProps {
  /** id сессии (записи), для которой создаётся ссылка */
  sessionId: string;
  /** сколько записей в поездке — для честной подписи при мультифрагментных поездках */
  fragmentCount?: number;
  /** подпись кнопки (по умолчанию «Поделиться») */
  label?: string;
}

// TTL-варианты диалога: 7 дней (серверный дефолт) и 30 дней.
const TTL_CHOICES = [
  { hours: 7 * 24, label: "7 дней" },
  { hours: 30 * 24, label: "30 дней" },
] as const;

// navigator.clipboard требует secure-context; в остальных случаях —
// скрытая textarea + execCommand (старые Safari, http-окружения без TLS)
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function ShareButton({ sessionId, fragmentCount, label = "Поделиться" }: ShareButtonProps) {
  const [open, setOpen] = React.useState(false);
  // дефолт 7 дней — SHARE_DEFAULT_TTL_HOURS сервера
  const [ttlHours, setTtlHours] = React.useState<number>(TTL_CHOICES[0].hours);
  const [link, setLink] = React.useState<ShareResult | null>(null);
  const [copied, setCopied] = React.useState(false);
  const create = useCreateShareLink();

  const multiFragment = (fragmentCount ?? 1) > 1;

  // Открытие диалога — чистый лист (старая ссылка не вводит в заблуждение
  // после смены срока/поездки); смена TTL аннулирует созданную ссылку —
  // она подписана конкретным сроком
  React.useEffect(() => {
    if (!open) {
      setLink(null);
      setCopied(false);
    }
  }, [open]);

  function chooseTtl(hours: number) {
    setTtlHours(hours);
    setLink(null);
    setCopied(false);
  }

  function createLink() {
    create.mutate(
      { sessionId, expiresInHours: ttlHours },
      {
        onSuccess: (res) => {
          setLink(res);
          toast.success("Ссылка создана", {
            description: `Действует до ${new Date(res.expiresAt).toLocaleString("ru-RU")}`,
          });
        },
        onError: (e) => {
          toast.error("Не удалось создать ссылку", {
            description: e instanceof Error ? e.message : "Попробуйте ещё раз",
          });
        },
      }
    );
  }

  async function copy() {
    if (!link) return;
    const url = `${typeof window !== "undefined" ? window.location.origin : ""}${link.url}`;
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopied(true);
      toast.success("Ссылка скопирована", { description: url });
      window.setTimeout(() => setCopied(false), 2500);
    } else {
      // буфер недоступен — URL выделен целиком в поле ниже (userSelect: all)
      toast.warning("Буфер обмена недоступен", {
        description: "Скопируйте ссылку вручную из поля",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Share2 className="h-3.5 w-3.5" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Поделиться поездкой</DialogTitle>
          <DialogDescription>
            По ссылке откроется публичная страница с треком и показателями
            поездки — без входа на сайт.
            {multiFragment
              ? ` В поездку входит ${fragmentCount} записей — ссылка открывает первую из них (её трек и показатели).`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {/* Срок действия ссылки */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground shrink-0">Срок действия:</span>
          <div className="flex gap-1.5" role="group" aria-label="Срок действия ссылки">
            {TTL_CHOICES.map((t) => (
              <button
                key={t.hours}
                type="button"
                aria-pressed={ttlHours === t.hours}
                onClick={() => chooseTtl(t.hours)}
                className={cn(
                  "h-8 rounded-md border px-3 text-xs font-medium transition-colors",
                  ttlHours === t.hours
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-transparent hover:bg-muted"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {link ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <code
                className="flex-1 min-w-0 rounded-md border bg-muted/50 px-2.5 py-2 text-[11px] leading-relaxed break-all select-all"
                aria-label="Ссылка на поездку"
              >
                {`${typeof window !== "undefined" ? window.location.origin : ""}${link.url}`}
              </code>
              <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={copy}>
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-600" /> Скопировано
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" /> Копировать
                  </>
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Ссылка перестанет работать {new Date(link.expiresAt).toLocaleString("ru-RU")}.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Кто получит ссылку — увидит трек и показатели этой поездки. Точную
            GPS-геометрию можно скрыть, только удалив запись.
          </p>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <a
            href={link ? link.url : undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!link}
            className={cn(
              "inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground",
              !link && "pointer-events-none opacity-50"
            )}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Открыть страницу
          </a>
          <Button onClick={createLink} disabled={create.isPending}>
            {create.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Создаём ссылку…
              </>
            ) : link ? (
              "Создать заново"
            ) : (
              "Создать ссылку"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
