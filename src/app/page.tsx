"use client";

// src/app/page.tsx — главная страница: login ИЛИ dashboard с табами.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  LogOut,
  LayoutDashboard,
  Map,
  Route as RouteIcon,
  Upload,
  ShieldCheck,
  Github,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/hooks";
import { api, setUnauthorizedHandler } from "@/lib/api-client";
import { LoginForm } from "@/components/login-form";
import { ThemeToggle } from "@/components/theme-toggle";
import { HealthIndicator } from "@/components/health-indicator";
import { DashboardOverview } from "@/components/dashboard-overview";
import { SessionsList } from "@/components/sessions-list";
import { SessionDetail } from "@/components/session-detail";
import { RoutePlanner } from "@/components/route-planner";
import { RoutesManager } from "@/components/routes-manager";
import { CsvImport } from "@/components/csv-import";
import { AdminPanel } from "@/components/admin-panel";
import { AuditLog } from "@/components/audit-log";
import { MetricsViewer } from "@/components/metrics-viewer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";

// Регистрируем обработчик 401 — сбрасываем auth-флаг.
export default function Home() {
  const auth = useAuth();
  const [tab, setTab] = React.useState("overview");
  const [selectedSession, setSelectedSession] = React.useState<string | null>(null);

  // Принудительный сброс auth-кэша при 401 из любого запроса.
  React.useEffect(() => {
    setUnauthorizedHandler(() => {
      // invalidate через queryClient не на прямую — используем window.dispatchEvent
      // auth-запрос сам перезапросится при refetch.
      // Простой подход: перезагружаем страницу для чистоты cookie.
      if (typeof window !== "undefined") {
        toast.error("Сессия истекла", { description: "Требуется повторный вход" });
        setTimeout(() => window.location.reload(), 800);
      }
    });
  }, []);

  const isAuthenticated = auth.data?.authenticated === true;

  async function handleLogout() {
    try {
      await api.post("/api/auth/logout", undefined, { expect: "none" });
      toast.success("Вы вышли из системы");
      // Очищаем кэш React Query и перезагружаем
      setTimeout(() => window.location.reload(), 300);
    } catch (e) {
      toast.error("Ошибка выхода", { description: (e as Error).message });
    }
  }

  function openSession(id: string) {
    setSelectedSession(id);
    setTab("sessions");
  }

  // ===== Login screen =====
  if (!isAuthenticated) {
    return (
      <LoginForm
        onSuccess={() => {
          // Триггерим refetch auth-запроса
          auth.refetch();
        }}
      />
    );
  }

  // ===== Dashboard =====
  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-30">
        <div className="container mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shrink-0">
              <Activity className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold leading-tight truncate">
                Телеметрия поездок
              </h1>
              <p className="text-[10px] text-muted-foreground leading-tight">
                v2.6 · single-user
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-3">
            <HealthIndicator />
            <ThemeToggle />
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="text-muted-foreground hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Выйти</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 container mx-auto px-4 py-4 w-full">
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="w-full justify-start overflow-x-auto scroll-telem h-auto flex-wrap sm:flex-nowrap">
            <TabsTrigger value="overview" className="gap-1.5">
              <LayoutDashboard className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Обзор</span>
            </TabsTrigger>
            <TabsTrigger value="sessions" className="gap-1.5">
              <Map className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Сессии</span>
            </TabsTrigger>
            <TabsTrigger value="routes" className="gap-1.5">
              <RouteIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Маршруты</span>
            </TabsTrigger>
            <TabsTrigger value="import" className="gap-1.5">
              <Upload className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Импорт</span>
            </TabsTrigger>
            <TabsTrigger value="admin" className="gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Администрирование</span>
            </TabsTrigger>
          </TabsList>

          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="mt-4"
            >
              <TabsContent value="overview" className="mt-0">
                <DashboardOverview
                  onOpenSession={openSession}
                  onGoToSessions={() => setTab("sessions")}
                />
              </TabsContent>

              <TabsContent value="sessions" className="mt-0">
                <div className="h-[calc(100vh-200px)] min-h-[480px] rounded-xl border overflow-hidden bg-card">
                  <ResizablePanelGroup direction="horizontal">
                    <ResizablePanel defaultSize={38} minSize={25} maxSize={55}>
                      <SessionsList
                        selectedId={selectedSession}
                        onSelect={setSelectedSession}
                      />
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                    <ResizablePanel defaultSize={62} minSize={40}>
                      <SessionDetail
                        sessionId={selectedSession}
                        onClose={() => setSelectedSession(null)}
                      />
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </div>
              </TabsContent>

              <TabsContent value="routes" className="mt-0 space-y-4">
                <RoutePlanner />
                <RoutesManager />
              </TabsContent>

              <TabsContent value="import" className="mt-0">
                <div className="max-w-3xl mx-auto">
                  <CsvImport />
                </div>
              </TabsContent>

              <TabsContent value="admin" className="mt-0 space-y-4">
                <AdminPanel />
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <AuditLog />
                  <MetricsViewer />
                </div>
              </TabsContent>
            </motion.div>
          </AnimatePresence>
        </Tabs>
      </main>

      {/* Footer (sticky bottom) */}
      <footer className="mt-auto border-t bg-card/60">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-3 text-xs text-muted-foreground flex-wrap">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-primary" />
            <span>
              Телеметрия v2.6 · Next.js 16 · Prisma · SQLite · in-memory RL
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline">
              Cookie: <code className="font-mono">__Host-telem_session</code> · HMAC-SHA256
            </span>
            <a
              href="https://prometheus.io/docs/instrumenting/exposition_formats/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
            >
              spec <ExternalLink className="h-3 w-3" />
            </a>
            <Github className="h-3.5 w-3.5" />
          </div>
        </div>
      </footer>
    </div>
  );
}
