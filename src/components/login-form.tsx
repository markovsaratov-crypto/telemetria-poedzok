"use client";

// src/components/login-form.tsx — форма входа (single-user, password).

import * as React from "react";
import { motion } from "framer-motion";
import { Lock, LogIn, Eye, EyeOff, Activity } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api, ApiError } from "@/lib/api-client";

interface LoginFormProps {
  onSuccess: (expiresAt: string) => void;
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const [password, setPassword] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) {
      toast.error("Введите пароль");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post<{ sessionId: string; expiresAt: string }>(
        "/api/auth/login",
        { password }
      );
      toast.success("Вход выполнен", {
        description: "Сессия активна 24 часа",
      });
      onSuccess(res.expiresAt);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          toast.error("Неверный пароль", {
            description: "Проверьте пароль и попробуйте снова",
          });
        } else if (err.status === 429) {
          // toast уже показан в apiFetch
        } else {
          toast.error("Ошибка входа", { description: err.message });
        }
      } else {
        toast.error("Неизвестная ошибка");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-emerald-50 via-background to-teal-50 dark:from-emerald-950/30 dark:via-background dark:to-teal-950/20">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="w-full max-w-md"
      >
        <Card className="shadow-lg">
          <CardHeader className="text-center gap-3">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Activity className="h-7 w-7" />
            </div>
            <CardTitle className="text-2xl">Телеметрия поездок</CardTitle>
            <CardDescription>
              Войдите для доступа к панели управления. v2.6
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password" className="flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5" /> Пароль
                </Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={show ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Введите пароль"
                    autoComplete="current-password"
                    disabled={loading}
                    className="pr-10"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShow((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={show ? "Скрыть пароль" : "Показать пароль"}
                    tabIndex={-1}
                  >
                    {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </CardContent>
            <CardFooter className="flex-col gap-3">
              <Button
                type="submit"
                className="w-full"
                disabled={loading || !password}
              >
                {loading ? (
                  <>
                    <motion.span
                      animate={{ rotate: 360 }}
                      transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
                      className="inline-block h-4 w-4 border-2 border-current border-t-transparent rounded-full"
                    />
                    Вход…
                  </>
                ) : (
                  <>
                    <LogIn className="h-4 w-4" /> Войти
                  </>
                )}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Single-user модель · защищено timing-safe сравнением · HMAC cookie
              </p>
            </CardFooter>
          </form>
        </Card>
      </motion.div>
    </div>
  );
}
