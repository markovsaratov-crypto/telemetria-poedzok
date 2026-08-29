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
  Command,
  Zap,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/hooks";
import { api, setUnauthorizedHandler } from "@/lib/api-client";
import { LoginForm } from "@/components/login-form";
import { ThemeToggle } from "@/components/theme-toggle";
import { HealthIndicator } from "@/components/health-indicator";
import { DashboardOverview } from "@/components/dashboard-overview";
import { SessionsList } from "@/components/sessions-list";
import { SessionDetail } from "@/components/session-detail";
import { SessionCompare } from "@/components/session-compare";
import { RoutesManager } from "@/components/routes-manager";
import { RouteGroups } from "@/components/route-groups";
import { CsvImport } from "@/components/csv-import";
import { ZipImport } from "@/components/zip-import";
import { AdminPanel } from "@/components/admin-panel";
import { AuditLog } from "@/components/audit-log";
import { MetricsViewer } from "@/components/metrics-viewer";
import { TrafficJobsCard } from "@/components/traffic-jobs-card";
import { CommandPalette } from "@/components/command-palette";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { GlobalSearch } from "@/components/global-search";
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
  const queryClient = useQueryClient();
  const [tab, setTab] = React.useState("overview");
  const [selectedSession, setSelectedSession] = React.useState<string | null>(null);
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);

  // Принудительный сброс auth-кэша при 401 из любого запроса (кроме /api/auth/me).
  React.useEffect(() => {
    setUnauthorizedHandler(() => {
      if (typeof window !== "undefined") {
        // Don't reload — just invalidate auth query so LoginForm shows
        queryClient.invalidateQueries({ queryKey: ["auth"] });
      }
    });
  }, [queryClient]);

  // Cmd+K / Ctrl+K — открыть command palette
  // "?" — показать справку по shortcuts
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
      // Быстрые переходы по табам: Alt+1..5
      if (e.altKey && /^[1-5]$/.test(e.key)) {
        e.preventDefault();
        const tabs = ["overview", "sessions", "routes", "import", "admin"];
        setTab(tabs[Number(e.key) - 1]);
      }
      // "?" (Shift+/) — справка
      if (e.shiftKey && e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA" && !target.isContentEditable) {
          e.preventDefault();
          setHelpOpen((v) => !v);
        }
      }
      // Cmd+Shift+F — глобальный поиск
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "F") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isAuthenticated = auth.data?.authenticated === true;

  async function handleLogout() {
    try {
      await api.post("/api/auth/logout", undefined, { expect: "none" });
      toast.success("Вы вышли из системы");
      setTimeout(() => window.location.reload(), 300);
    } catch (e) {
      toast.error("Ошибка выхода", { description: (e as Error).message });
    }
  }

  function openSession(id: string) {
    setSelectedSession(id);
    setTab("sessions");
  }

  function handleRefresh() {
    queryClient.invalidateQueries();
    toast.success("Данные обновлены");
  }

  // ===== Login screen =====
  if (!isAuthenticated) {
    return (
      <LoginForm
        onSuccess={() => {
          auth.refetch();
        }}
      />
    );
  }

  // ===== Dashboard =====
  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-md sticky top-0 z-30">
        <div className="container mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shrink-0 shadow-sm shadow-primary/30"
            >
              <Activity className="h-4 w-4" />
            </motion.div>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold leading-tight truncate">
                Телеметрия поездок
              </h1>
              <p className="text-[10px] text-muted-foreground leading-tight flex items-center gap-1">
                <Zap className="h-2.5 w-2.5 text-primary" />
                v2.9 · single-user
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSearchOpen(true)}
              className="hidden md:flex gap-2 px-2.5 text-muted-foreground"
              title="Глобальный поиск (Cmd+Shift+F)"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="text-xs">Поиск</span>
              <kbd className="ml-1">⌘⇧F</kbd>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCmdOpen(true)}
              className="hidden md:flex gap-2 px-2.5 text-muted-foreground"
              title="Открыть команды (Cmd+K)"
            >
              <Command className="h-3.5 w-3.5" />
              <span className="text-xs">Команды</span>
              <kbd className="ml-1">⌘K</kbd>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHelpOpen(true)}
              className="h-8 w-8 p-0 text-muted-foreground"
              title="Горячие клавиши (?)"
            >
              <span className="text-xs font-semibold">?</span>
            </Button>
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
              <kbd className="hidden lg:inline ml-1 opacity-50">1</kbd>
            </TabsTrigger>
            <TabsTrigger value="sessions" className="gap-1.5">
              <Map className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Поездки</span>
              <kbd className="hidden lg:inline ml-1 opacity-50">2</kbd>
            </TabsTrigger>
            <TabsTrigger value="routes" className="gap-1.5">
              <RouteIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Маршруты</span>
              <kbd className="hidden lg:inline ml-1 opacity-50">3</kbd>
            </TabsTrigger>
            <TabsTrigger value="import" className="gap-1.5">
              <Upload className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Импорт</span>
              <kbd className="hidden lg:inline ml-1 opacity-50">4</kbd>
            </TabsTrigger>
            <TabsTrigger value="admin" className="gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Администрирование</span>
              <kbd className="hidden lg:inline ml-1 opacity-50">5</kbd>
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

              <TabsContent value="sessions" className="mt-0 space-y-4">
                <SessionCompare />
                <div className="h-[calc(100vh-340px)] min-h-[400px] rounded-xl border overflow-hidden bg-card">
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
                {/* v2.9 §10: группы маршрутов по routeHash (сравнительные метрики) */}
                <RouteGroups />
                <RoutesManager />
              </TabsContent>

              <TabsContent value="import" className="mt-0">
                <div className="max-w-3xl mx-auto">
                  <ZipImport />
                <CsvImport />
                </div>
              </TabsContent>

              <TabsContent value="admin" className="mt-0 space-y-4">
                <AdminPanel />
                <TrafficJobsCard />
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
      <footer className="mt-auto border-t bg-card/60 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-3 text-xs text-muted-foreground flex-wrap">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-primary" />
            <span>
              Телеметрия v2.9 · Next.js 16 · libsql · in-memory RL
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden md:inline">
              <kbd>⌘K</kbd> команды · <kbd>⌘⇧F</kbd> поиск · <kbd>?</kbd> справка · <kbd>Alt+1..5</kbd> табы
            </span>
            <span className="hidden sm:inline">
              Cookie: <code className="font-mono">telem_session</code> · HMAC-SHA256
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

      <CommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        onTabChange={setTab}
        onLogout={handleLogout}
        onRefresh={handleRefresh}
      />
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
      <GlobalSearch
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelect={(id) => {
          setSelectedSession(id);
          setTab("sessions");
        }}
      />
    </div>
  );
}
