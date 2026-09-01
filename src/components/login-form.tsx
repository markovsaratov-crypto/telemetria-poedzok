"use client";

// src/components/login-form.tsx — форма входа (email опционален; без email — legacy single-user LOGIN_PASSWORD).
// AUDIT B-1: режим регистрации удалён из UI — регистрация на сервере выключена (REGISTRATION_ENABLED=false).

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Lock,
  LogIn,
  Eye,
  EyeOff,
  Activity,
  ShieldCheck,
  AlertCircle,
  Keyboard,
  KeyRound,
  Mail,
} from "lucide-react";
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

interface AuthUser {
  id?: string;
  email?: string;
  role?: string;
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [capsLockOn, setCapsLockOn] = React.useState(false);
  const [shake, setShake] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) {
      toast.error("Введите пароль");
      triggerShake();
      return;
    }
    setLoading(true);
    try {
      // Login: if email provided → multi-user; else legacy single-user
      const payload = email ? { email, password } : { password };
      const res = await api.post<{
        sessionId: string;
        expiresAt: string;
        user?: AuthUser;
      }>("/api/auth/login", payload);
      toast.success("Вход выполнен", {
        description: "Сессия активна 24 часа",
      });
      onSuccess(res.expiresAt);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          toast.error("Неверный пароль", {
            description: "Проверьте данные и попробуйте снова",
          });
        } else if (err.status === 409) {
          toast.error("Email уже зарегистрирован", {
            description: "Войдите с существующим аккаунтом",
          });
        } else if (err.status === 429) {
          // toast уже показан в apiFetch
        } else {
          toast.error("Ошибка", { description: err.message });
        }
      } else {
        toast.error("Неизвестная ошибка");
      }
      triggerShake();
    } finally {
      setLoading(false);
    }
  }

  function triggerShake() {
    setShake(true);
    setTimeout(() => setShake(false), 500);
  }

  function handleKeyUp(e: React.KeyboardEvent) {
    const caps = e.getModifierState && e.getModifierState("CapsLock");
    setCapsLockOn(caps);
  }

  return (
    // v2.11.0 (U-27): айдентика v4 — айвори-фон + слива (emerald/teal-градиент убран).
    // Логика (состояния/обработчики) не тронута — только визуал.
    <div className="min-h-screen flex items-center justify-center p-4 v4-login-bg">
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{
          opacity: 1,
          y: shake ? [0, -8, 8, -4, 4, 0] : 0,
          scale: 1,
        }}
        transition={{
          opacity: { duration: 0.4, ease: "easeOut" },
          scale: { duration: 0.4, ease: "easeOut" },
          y: shake ? { duration: 0.5 } : { duration: 0.4, ease: "easeOut" },
        }}
        className="w-full max-w-md"
      >
        <Card className="shadow-xl">
          <CardHeader className="text-center gap-3 pb-2">
            <motion.div
              initial={{ scale: 0, rotate: -45 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ delay: 0.1, type: "spring", stiffness: 200, damping: 15 }}
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl v4-login-icon"
            >
              <Activity className="h-7 w-7" />
            </motion.div>
            <CardTitle className="text-2xl tracking-tight v4-login-title">
              Телематика Маркова
            </CardTitle>
            <CardDescription className="flex items-center justify-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 v4-login-accent" />
              Войдите для доступа к телеметрии
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-3">
              {/* Email (optional) — без email вход по legacy LOGIN_PASSWORD (single-user) */}
              <div className="space-y-1.5">
                <Label htmlFor="email-login" className="flex items-center gap-1.5 text-xs">
                  <Mail className="h-3 w-3" /> Email (опционально)
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    id="email-login"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="оставьте пустым для single-user"
                    autoComplete="email"
                    disabled={loading}
                    className="pl-9 h-10"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password" className="flex items-center gap-1.5 text-xs">
                  <Lock className="h-3 w-3" /> Пароль
                </Label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    id="password"
                    type={show ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyUp={handleKeyUp}
                    onKeyDown={handleKeyUp}
                    placeholder="Введите пароль"
                    autoComplete="current-password"
                    disabled={loading}
                    className="pl-9 pr-16 h-10"
                    autoFocus
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    <AnimatePresence>
                      {capsLockOn && (
                        <motion.span
                          initial={{ opacity: 0, scale: 0.5 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.5 }}
                          className="text-amber-500"
                          title="Caps Lock включён"
                        >
                          <Keyboard className="h-3.5 w-3.5" />
                        </motion.span>
                      )}
                    </AnimatePresence>
                    <button
                      type="button"
                      onClick={() => setShow((v) => !v)}
                      className="text-muted-foreground hover:text-foreground transition-colors p-1"
                      aria-label={show ? "Скрыть пароль" : "Показать пароль"}
                      tabIndex={-1}
                    >
                      {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
              </div>

              {capsLockOn && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400"
                >
                  <AlertCircle className="h-3 w-3" />
                  Caps Lock включён — проверьте раскладку
                </motion.div>
              )}
            </CardContent>
            <CardFooter className="flex-col gap-3 pt-2">
              <Button
                type="submit"
                className="w-full transition-all"
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
              <div className="text-[10px] text-muted-foreground text-center space-y-0.5">
                <p className="flex items-center justify-center gap-1">
                  <ShieldCheck className="h-3 w-3 v4-login-accent" />
                  Multi-user + legacy LOGIN_PASSWORD · HMAC cookie · 24ч
                </p>
                <p className="opacity-70">
                  Cookie: <code className="font-mono">telem_session</code> · sliding renewal
                </p>
              </div>
            </CardFooter>
          </form>
        </Card>
      </motion.div>
    </div>
  );
}
