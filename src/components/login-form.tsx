"use client";

// src/components/login-form.tsx — форма входа + переключатель регистрации (multi-user).
// Вход: email опционален (без email — legacy single-user LOGIN_PASSWORD).
// Регистрация: POST /api/auth/register; работает только когда на сервере задан
// REGISTRATION_ENABLED=true (иначе 403 — тост подскажет). Новые аккаунты — строго
// role="user" (AUDIT B-1: авто-эскалации до admin нет).

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Lock,
  LogIn,
  Eye,
  EyeOff,
  ShieldCheck,
  AlertCircle,
  Keyboard,
  KeyRound,
  Mail,
  UserPlus,
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
  const [mode, setMode] = React.useState<"login" | "register">("login");
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
    if (mode === "register" && !email) {
      toast.error("Введите email");
      triggerShake();
      return;
    }
    setLoading(true);
    try {
      if (mode === "register") {
        const res = await api.post<{
          sessionId: string;
          expiresAt: string;
          user: AuthUser;
        }>("/api/auth/register", { email, password });
        toast.success("Регистрация успешна", {
          description: "Аккаунт создан",
        });
        onSuccess(res.expiresAt);
      } else {
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
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          toast.error(mode === "register" ? "Email уже занят" : "Неверный пароль", {
            description: "Проверьте данные и попробуйте снова",
          });
        } else if (err.status === 403) {
          // гейт регистрации на сервере (REGISTRATION_ENABLED≠true) либо запрет первого аккаунта
          toast.error("Регистрация недоступна", {
            description: err.message || "Сервер не принимает новые аккаунты",
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

  // Сила пароля (только режим регистрации)
  const strength = React.useMemo(() => {
    if (!password) return 0;
    let s = 0;
    if (password.length >= 8) s++;
    if (password.length >= 16) s++;
    if (password.length >= 32) s++;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) s++;
    if (/\d/.test(password)) s++;
    if (/[^A-Za-z0-9]/.test(password)) s++;
    return Math.min(s, 4);
  }, [password]);

  const strengthLabel = ["", "Слабый", "Средний", "Хороший", "Сильный"][strength];
  const strengthColor = [
    "",
    "bg-red-500",
    "bg-amber-500",
    "bg-teal-500",
    "bg-emerald-500",
  ][strength];

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
            {/* v2.28.0: логотип владельца вместо иконки-заглушки — прозрачная
                подложка сохранена в обеих темах (без подкрашенного бокса) */}
            <motion.div
              initial={{ scale: 0, rotate: -45 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ delay: 0.1, type: "spring", stiffness: 200, damping: 15 }}
              className="mx-auto"
            >
              <img
                src="/logo.png"
                alt="Логотип Телемат"
                width={56}
                height={56}
                className="v4-login-logo"
                draggable={false}
              />
            </motion.div>
            <CardTitle className="text-2xl tracking-tight v4-login-title">
              Телемат
            </CardTitle>
            <CardDescription className="flex items-center justify-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 v4-login-accent" />
              {mode === "login" ? "Войдите для доступа к телеметрии" : "Создайте аккаунт для доступа"}
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-3">
              {/* Email: в регистрации обязателен; во входе опционален (без email — legacy single-user) */}
              <div className="space-y-1.5">
                <Label htmlFor="email-login" className="flex items-center gap-1.5 text-xs">
                  <Mail className="h-3 w-3" /> {mode === "register" ? "Email" : "Email (опционально)"}
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    id="email-login"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={mode === "register" ? "you@example.com" : "оставьте пустым для single-user"}
                    autoComplete="email"
                    disabled={loading}
                    className="pl-9 h-10"
                    required={mode === "register"}
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
                    placeholder={mode === "register" ? "Минимум 8 символов" : "Введите пароль"}
                    autoComplete={mode === "register" ? "new-password" : "current-password"}
                    disabled={loading}
                    className="pl-9 pr-16 h-10"
                    autoFocus={mode === "login"}
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

              {/* Индикатор силы пароля (только регистрация) */}
              <AnimatePresence>
                {mode === "register" && password && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="space-y-1"
                  >
                    <div className="grid grid-cols-4 gap-1">
                      {[0, 1, 2, 3].map((i) => (
                        <div
                          key={i}
                          className={`h-1 rounded-full transition-all ${
                            i < strength ? strengthColor : "bg-muted"
                          }`}
                        />
                      ))}
                    </div>
                    {strength > 0 && (
                      <p className="text-[10px] text-muted-foreground">
                        Сила пароля: <span className="font-medium">{strengthLabel}</span>
                      </p>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

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
                disabled={loading || !password || (mode === "register" && !email)}
              >
                {loading ? (
                  <>
                    <motion.span
                      animate={{ rotate: 360 }}
                      transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
                      className="inline-block h-4 w-4 border-2 border-current border-t-transparent rounded-full"
                    />
                    {mode === "register" ? "Регистрация…" : "Вход…"}
                  </>
                ) : mode === "register" ? (
                  <>
                    <UserPlus className="h-4 w-4" /> Зарегистрироваться
                  </>
                ) : (
                  <>
                    <LogIn className="h-4 w-4" /> Войти
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full text-xs"
                onClick={() => {
                  setMode(mode === "login" ? "register" : "login");
                  setPassword("");
                }}
                disabled={loading}
              >
                {mode === "login" ? "Нет аккаунта? Регистрация" : "Уже есть аккаунт? Войти"}
              </Button>
              <div className="text-[10px] text-muted-foreground text-center space-y-0.5">
                <p className="flex items-center justify-center gap-1">
                  <ShieldCheck className="h-3 w-3 v4-login-accent" />
                  {mode === "register"
                    ? "Multi-user · bcrypt hash · новые аккаунты — только роль user"
                    : "Multi-user + legacy LOGIN_PASSWORD · HMAC cookie · 24ч"}
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
