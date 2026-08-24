"use client";

// src/components/routes-manager.tsx — CRUD избранных маршрутов.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus,
  Pencil,
  Trash2,
  Route as RouteIcon,
  MapPin,
  Save,
  X,
  Loader2,
  Calendar,
} from "lucide-react";
import { toast } from "sonner";
import {
  useRoutes,
  useCreateRoute,
  useUpdateRoute,
  useDeleteRoute,
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
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { fmtDate } from "@/lib/format";
import type { RouteItem } from "@/lib/api-client";

interface RouteFormState {
  name: string;
  description: string;
  startLat: string;
  startLon: string;
  endLat: string;
  endLon: string;
}

const EMPTY: RouteFormState = {
  name: "",
  description: "",
  startLat: "",
  startLon: "",
  endLat: "",
  endLon: "",
};

export function RoutesManager() {
  const { data, isLoading } = useRoutes();
  const createMut = useCreateRoute();
  const updateMut = useUpdateRoute();
  const deleteMut = useDeleteRoute();

  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<RouteItem | null>(null);
  const [form, setForm] = React.useState<RouteFormState>(EMPTY);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  }

  function openEdit(r: RouteItem) {
    setEditing(r);
    setForm({
      name: r.name,
      description: r.description || "",
      startLat: String(r.startLat),
      startLon: String(r.startLon),
      endLat: String(r.endLat),
      endLon: String(r.endLon),
    });
    setOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      startLat: Number(form.startLat),
      startLon: Number(form.startLon),
      endLat: Number(form.endLat),
      endLon: Number(form.endLon),
    };
    if (
      !payload.name ||
      isNaN(payload.startLat) ||
      isNaN(payload.startLon) ||
      isNaN(payload.endLat) ||
      isNaN(payload.endLon)
    ) {
      toast.error("Заполните все поля корректно");
      return;
    }
    try {
      if (editing) {
        await updateMut.mutateAsync({ id: editing.id, patch: payload });
        toast.success("Маршрут обновлён");
      } else {
        await createMut.mutateAsync(payload);
        toast.success("Маршрут создан");
      }
      setOpen(false);
    } catch (err) {
      toast.error("Ошибка сохранения", { description: (err as Error).message });
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMut.mutateAsync(id);
      toast.success("Маршрут удалён");
    } catch (e) {
      toast.error("Ошибка удаления", { description: (e as Error).message });
    }
  }

  const routes = data?.routes || [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <RouteIcon className="h-4 w-4 text-primary" />
              Избранные маршруты
            </CardTitle>
            <CardDescription className="text-xs">
              {routes.length} сохранено · для быстрого планирования повторных поездок
            </CardDescription>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" /> Новый
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : routes.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground">
            <RouteIcon className="h-10 w-10 mx-auto mb-2 opacity-30" />
            Пока нет сохранённых маршрутов
            <div className="mt-3">
              <Button size="sm" onClick={openCreate}>
                <Plus className="h-4 w-4" /> Создать первый
              </Button>
            </div>
          </div>
        ) : (
          <div className="max-h-[480px] overflow-y-auto scroll-telem -mx-2">
            <ul className="space-y-2 px-2">
              <AnimatePresence>
                {routes.map((r) => (
                  <motion.li
                    key={r.id}
                    layout
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    className="rounded-lg border p-3 hover:border-primary/40 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm truncate">{r.name}</span>
                          {r._count && r._count.sessions > 0 && (
                            <Badge variant="outline" className="text-[10px]">
                              {r._count.sessions} сессий
                            </Badge>
                          )}
                        </div>
                        {r.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2">
                            {r.description}
                          </p>
                        )}
                        <div className="text-[11px] text-muted-foreground font-mono flex items-center gap-2 flex-wrap">
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3 text-emerald-500" />
                            {r.startLat.toFixed(4)}, {r.startLon.toFixed(4)}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3 text-amber-500" />
                            {r.endLat.toFixed(4)}, {r.endLon.toFixed(4)}
                          </span>
                        </div>
                        <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Calendar className="h-2.5 w-2.5" /> {fmtDate(r.createdAt)}
                        </div>
                      </div>
                      <div className="flex flex-col gap-1 shrink-0">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => openEdit(r)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-destructive hover:bg-destructive/10"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Удалить маршрут?</AlertDialogTitle>
                              <AlertDialogDescription>
                                «{r.name}» будет удалён без возможности восстановления.
                                Сессии, привязанные к маршруту, останутся (routeId будет очищен).
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Отмена</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-white hover:bg-destructive/90"
                                onClick={() => handleDelete(r.id)}
                              >
                                Удалить
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </div>
        )}
      </CardContent>

      {/* Модалка создания/редактирования */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Редактировать маршрут" : "Новый маршрут"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="r-name">Название *</Label>
              <Input
                id="r-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Например: Дом → Офис"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="r-desc">Описание</Label>
              <Textarea
                id="r-desc"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Заметки о маршруте…"
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-emerald-600">Старт: широта</Label>
                <Input
                  type="number"
                  step="any"
                  value={form.startLat}
                  onChange={(e) => setForm((f) => ({ ...f, startLat: e.target.value }))}
                  placeholder="55.7512"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-emerald-600">Старт: долгота</Label>
                <Input
                  type="number"
                  step="any"
                  value={form.startLon}
                  onChange={(e) => setForm((f) => ({ ...f, startLon: e.target.value }))}
                  placeholder="37.6184"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-amber-600">Финиш: широта</Label>
                <Input
                  type="number"
                  step="any"
                  value={form.endLat}
                  onChange={(e) => setForm((f) => ({ ...f, endLat: e.target.value }))}
                  placeholder="55.8300"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-amber-600">Финиш: долгота</Label>
                <Input
                  type="number"
                  step="any"
                  value={form.endLon}
                  onChange={(e) => setForm((f) => ({ ...f, endLon: e.target.value }))}
                  placeholder="37.6200"
                  required
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={createMut.isPending || updateMut.isPending}
              >
                <X className="h-4 w-4" /> Отмена
              </Button>
              <Button
                type="submit"
                disabled={createMut.isPending || updateMut.isPending}
              >
                {createMut.isPending || updateMut.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {editing ? "Сохранить" : "Создать"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
