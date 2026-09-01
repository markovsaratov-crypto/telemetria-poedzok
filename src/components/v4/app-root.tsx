"use client";

// src/components/v4/app-root.tsx — AUDIT B-17: общий корень приложения.
// Раньше / и /m содержали две идентичные 125-строчные копии — любой фикс
// приходилось вносить дважды. Теперь page.tsx и m/page.tsx реэкспортируют AppRoot.
// v2.10.0 R1: selectedSessionId (real UUID) state — auto-selects first session on first mount.
// LoginForm gate, command palette (⌘K), global search (⌘⇧F), shortcuts help (?),
// theme toggle (light/dark), logout button — сохранены из предыдущей версии.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, setUnauthorizedHandler } from "@/lib/api-client";
import { useAuth, useSessions } from "@/lib/hooks";
import { LoginForm } from "@/components/login-form";
import { CommandPalette } from "@/components/command-palette";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { GlobalSearch } from "@/components/global-search";
import { TelematikaLayout, type V4Tab, type Period } from "@/components/v4/telematika-layout";
import { AnalyticsView } from "@/components/v4/analytics-view";
import { TripsView } from "@/components/v4/trips-view";
import { AdminViewV4 } from "@/components/v4/admin-view-v4";

export function AppRoot() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = React.useState<V4Tab>("analytics");
  const [period, setPeriod] = React.useState<Period>("today");
  // v2.10.0 R1: real session UUID (was: mock "t1".."t8").
  const [selectedSessionId, setSelectedSessionId] = React.useState<string | null>(null);
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);

  // Fetch sessions list (used for auto-select on first mount).
  const sessions = useSessions({ limit: 50 });

  // v2.10.0 R1: Auto-select first session on first mount (when sessions loaded and nothing selected).
  const autoSelectedRef = React.useRef(false);
  React.useEffect(() => {
    if (autoSelectedRef.current) return;
    if (selectedSessionId) {
      autoSelectedRef.current = true;
      return;
    }
    const first = sessions.data?.sessions?.[0];
    if (first && first.status === "completed") {
      autoSelectedRef.current = true;
      setSelectedSessionId(first.id);
    }
  }, [sessions.data, selectedSessionId]);

  React.useEffect(() => {
    setUnauthorizedHandler(() => {
      if (typeof window !== "undefined") {
        queryClient.invalidateQueries({ queryKey: ["auth"] });
      }
    });
  }, [queryClient]);

  async function handleLogout() {
    // NB (U-30): не дубликат layout-версии — эта привязана к CommandPalette (⌘K).
    try {
      await api.post("/api/auth/logout", undefined, { expect: "none" });
      toast.success("Вы вышли из системы");
      setTimeout(() => window.location.reload(), 300);
    } catch (e) {
      toast.error("Ошибка выхода", { description: (e as Error).message });
    }
  }

  // NB (U-30): эта версия — для CommandPalette (⌘K); layout-версия привязана к
  // кнопке «Обновить» в шапке. Тост успеха — после завершения refetch (U-14).
  async function handleRefresh() {
    try {
      await queryClient.invalidateQueries();
      toast.success("Данные обновлены");
    } catch {
      /* ошибки отдельных запросов уже показаны тостами из api-client */
    }
  }

  // Маппинг legacy tab names (от CommandPalette) → v4 tabs
  function mapLegacyTab(name: string): V4Tab {
    if (name === "analytics" || name === "overview") return "analytics";
    if (name === "trips" || name === "sessions") return "trips";
    return "admin";
  }

  // v2.11.0 (U-11): пока /api/auth/me в полёте — минимальный сплэш вместо
  // мгновенного LoginForm: у залогиненного пользователя не должен мигать
  // экран входа при каждой перезагрузке страницы.
  if (auth.isLoading) {
    return <AuthSplash />;
  }

  const isAuthenticated = auth.data?.authenticated === true;
  if (!isAuthenticated) {
    return <LoginForm onSuccess={() => auth.refetch()} />;
  }

  return (
    <>
      <TelematikaLayout
        tab={tab}
        onTabChange={setTab}
        period={period}
        onPeriodChange={setPeriod}
        selectedSessionId={selectedSessionId}
        onSelectedSessionChange={setSelectedSessionId}
        onCmdOpen={() => setCmdOpen(true)}
        onSearchOpen={() => setSearchOpen(true)}
        onHelpOpen={() => setHelpOpen(true)}
      >
        {tab === "analytics" && (
          <AnalyticsView period={period} sessionId={selectedSessionId} />
        )}
        {tab === "trips" && <TripsView onGoAdmin={() => setTab("admin")} />}
        {tab === "admin" && <AdminViewV4 />}
      </TelematikaLayout>

      <CommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        onTabChange={(name) => setTab(mapLegacyTab(name))}
        onLogout={handleLogout}
        onRefresh={handleRefresh}
      />
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
      <GlobalSearch
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelect={(id) => {
          // v2.10.0 R1: GlobalSearch возвращает sessionId напрямую (UUID).
          setSelectedSessionId(id);
          setTab("analytics");
        }}
      />
    </>
  );
}

// v2.11.0 (U-11): сплэш на время проверки auth-куки — айдентика v4
// (айвори + слива + Arial Narrow), без «мигания» логин-экрана.
function AuthSplash() {
  return (
    <div className="auth-splash" role="status" aria-live="polite">
      <div className="auth-splash-title">Телематика Маркова</div>
      <div className="auth-splash-bar" aria-hidden="true" />
      <div className="auth-splash-note">проверяем сессию…</div>
    </div>
  );
}
