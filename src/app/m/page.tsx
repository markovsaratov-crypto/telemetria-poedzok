"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { LoginForm } from "@/components/login-form";
import { useAuth } from "@/lib/hooks";
import { BottomNav, type MobileTab } from "@/components/mobile/shared/BottomNav";
import { SessionListScreen } from "@/components/mobile/SessionList/SessionListScreen";
import { AnalyticsScreen } from "@/components/mobile/Analytics/AnalyticsScreen";
import { AdminScreen } from "@/components/mobile/Admin/AdminScreen";

const SessionDetailScreen = dynamic(() => import("@/components/mobile/SessionDetail/SessionDetailScreen").then(m => m.SessionDetailScreen), { ssr: false, loading: () => <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">Загрузка...</div> });
const MapScreen = dynamic(() => import("@/components/mobile/Map/MapScreen").then(m => m.MapScreen), { ssr: false, loading: () => <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">Загрузка карты...</div> });
const RoutesScreen = dynamic(() => import("@/components/mobile/Routes/RoutesScreen").then(m => m.RoutesScreen), { ssr: false, loading: () => <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">Загрузка...</div> });

export default function MobilePage() {
  const auth = useAuth();
  const [tab, setTab] = React.useState<MobileTab>("analytics");
  const [selectedSession, setSelectedSession] = React.useState<string | null>(null);
  const isAuthenticated = auth.data?.authenticated === true;

  if (!isAuthenticated) return <LoginForm onSuccess={() => auth.refetch()} />;

  if (selectedSession) return <div className="min-h-screen bg-background"><SessionDetailScreen sessionId={selectedSession} onBack={() => setSelectedSession(null)} /></div>;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <BottomNav active={tab} onChange={setTab} />
      <div className="flex-1 overflow-y-auto">
        {tab === "trips" && <SessionListScreen onSessionTap={(id) => setSelectedSession(id)} onSettingsTap={() => setTab("admin")} />}
        {tab === "map" && <MapScreen onSessionTap={(id) => setSelectedSession(id)} />}
        {tab === "analytics" && <AnalyticsScreen />}
        {tab === "routes" && <RoutesScreen />}
        {tab === "admin" && <AdminScreen onLogout={() => auth.refetch()} />}
      </div>
    </div>
  );
}
