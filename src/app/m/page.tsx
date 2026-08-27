"use client";

// src/app/m/page.tsx — Мобильный интерфейс (ТЗ §2)
import * as React from "react";
import dynamic from "next/dynamic";
import { LoginForm } from "@/components/login-form";
import { useAuth } from "@/lib/hooks";
import { BottomNav, type MobileTab } from "@/components/mobile/shared/BottomNav";
import { SessionListScreen } from "@/components/mobile/SessionList/SessionListScreen";
import { AnalyticsScreen } from "@/components/mobile/Analytics/AnalyticsScreen";
import { RoutesScreen } from "@/components/mobile/Routes/RoutesScreen";

// Dynamic import to avoid SSR issues with Leaflet
const SessionDetailScreen = dynamic(
  () => import("@/components/mobile/SessionDetail/SessionDetailScreen").then(m => m.SessionDetailScreen),
  { ssr: false, loading: () => <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">Загрузка...</div> }
);

export default function MobilePage() {
  const auth = useAuth();
  const [tab, setTab] = React.useState<MobileTab>("analytics");
  const [selectedSession, setSelectedSession] = React.useState<string | null>(null);

  const isAuthenticated = auth.data?.authenticated === true;

  if (!isAuthenticated) {
    return <LoginForm onSuccess={() => auth.refetch()} />;
  }

  if (selectedSession) {
    return (
      <div className="min-h-screen bg-background">
        <SessionDetailScreen
          sessionId={selectedSession}
          onBack={() => setSelectedSession(null)}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {tab === "trips" && (
        <SessionListScreen
          onSessionTap={(id) => setSelectedSession(id)}
          onSettingsTap={() => {}}
        />
      )}
      {tab === "map" && (
        <SessionListScreen
          onSessionTap={(id) => setSelectedSession(id)}
          onSettingsTap={() => {}}
        />
      )}
      {tab === "analytics" && <AnalyticsScreen />}
      {tab === "routes" && <RoutesScreen />}
      <BottomNav active={tab} onChange={setTab} />
    </div>
  );
}
