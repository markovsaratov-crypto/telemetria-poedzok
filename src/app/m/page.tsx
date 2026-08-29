"use client";

import * as React from "react";
import { LoginForm } from "@/components/login-form";
import { useAuth } from "@/lib/hooks";
import { BottomNav, type MobileTab } from "@/components/mobile/shared/BottomNav";
import { SessionListScreen } from "@/components/mobile/SessionList/SessionListScreen";
import { AnalyticsScreen } from "@/components/mobile/Analytics/AnalyticsScreen";
import { AdminScreen } from "@/components/mobile/Admin/AdminScreen";
import { MapScreenWrapper } from "@/components/mobile/Map/MapScreenWrapper";
import dynamic from "next/dynamic";

const SessionDetailScreen = dynamic(() => import("@/components/mobile/SessionDetail/SessionDetailScreen").then(m => m.SessionDetailScreen), { ssr: false, loading: () => <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">Загрузка...</div> });
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
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <BottomNav active={tab} onChange={setTab} />
      <div className="flex-1 overflow-y-auto">
        {tab === "trips" && <SessionListScreen onSessionTap={(id) => setSelectedSession(id)} onSettingsTap={() => setTab("admin")} />}
        {tab === "map" && <MapScreenWrapper onSessionTap={(id) => setSelectedSession(id)} />}
        {tab === "analytics" && <AnalyticsScreen />}
        {tab === "routes" && <RoutesScreen />}
        {tab === "admin" && <AdminScreen onBack={() => setTab("trips")} onLogout={() => auth.refetch()} />}
      </div>
    </div>
  );
}
