"use client";

// src/components/session-notes.tsx — заметки и теги для сессии.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { StickyNote, Tag, Save, X, Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { useUpdateSessionNotes } from "@/lib/hooks";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface SessionNotesProps {
  sessionId: string;
  initialNotes?: string | null;
  initialTags?: string | null;
}

export function SessionNotes({ sessionId, initialNotes, initialTags }: SessionNotesProps) {
  const [notes, setNotes] = React.useState(initialNotes || "");
  const [tags, setTags] = React.useState(initialTags || "");
  const [editing, setEditing] = React.useState(false);
  const updateMut = useUpdateSessionNotes();

  // Sync при смене сессии
  React.useEffect(() => {
    setNotes(initialNotes || "");
    setTags(initialTags || "");
    setEditing(false);
  }, [sessionId, initialNotes, initialTags]);

  const hasChanges =
    notes !== (initialNotes || "") || tags !== (initialTags || "");

  async function handleSave() {
    try {
      await updateMut.mutateAsync({ id: sessionId, notes, tags });
      toast.success("Заметки сохранены");
      setEditing(false);
    } catch (e) {
      toast.error("Ошибка сохранения", { description: (e as Error).message });
    }
  }

  function handleCancel() {
    setNotes(initialNotes || "");
    setTags(initialTags || "");
    setEditing(false);
  }

  const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <StickyNote className="h-4 w-4 text-amber-500" />
            Заметки и теги
          </CardTitle>
          {!editing && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
              className="h-7 text-xs"
            >
              Редактировать
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-3"
          >
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground flex items-center gap-1.5">
                <StickyNote className="h-3 w-3" /> Заметки
              </label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Добавьте заметки к этой сессии…"
                rows={4}
                className="text-xs resize-none"
                maxLength={2000}
              />
              <div className="text-[10px] text-muted-foreground text-right">
                {notes.length}/2000
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Tag className="h-3 w-3" /> Теги (через запятую)
              </label>
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="работа, дом, поездка…"
                className="h-8 text-xs"
                maxLength={500}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={updateMut.isPending || !hasChanges}
                className="gap-1.5"
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
                onClick={handleCancel}
                className="gap-1.5"
              >
                <X className="h-3.5 w-3.5" />
                Отмена
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-3"
          >
            <div>
              {notes ? (
                <p className="text-sm whitespace-pre-wrap leading-relaxed">
                  {notes}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  Нет заметок. Нажмите «Редактировать» чтобы добавить.
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {tagList.length > 0 ? (
                tagList.map((tag, i) => (
                  <Badge
                    key={i}
                    variant="outline"
                    className="text-[10px] gap-1 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                  >
                    <Tag className="h-2.5 w-2.5" />
                    {tag}
                  </Badge>
                ))
              ) : (
                !notes && (
                  <span className="text-[10px] text-muted-foreground">
                    Тегов нет
                  </span>
                )
              )}
            </div>
          </motion.div>
        )}
      </CardContent>
    </Card>
  );
}
