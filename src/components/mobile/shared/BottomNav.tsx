"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { List, Map, BarChart3, Route, Shield } from "lucide-react";
import { cn } from "@/lib/utils";

export type MobileTab = "trips" | "map" | "analytics" | "routes" | "admin";

const TABS: { id: MobileTab; label: string; icon: React.ReactNode }[] = [
  { id: "analytics", label: "Аналитика", icon: <BarChart3 className="h-5 w-5" /> },
  { id: "trips", label: "Поездки", icon: <List className="h-5 w-5" /> },
  { id: "map", label: "Карта", icon: <Map className="h-5 w-5" /> },
  { id: "routes", label: "Маршруты", icon: <Route className="h-5 w-5" /> },
  { id: "admin", label: "Админ", icon: <Shield className="h-5 w-5" /> },
];

export function BottomNav({ active, onChange }: { active: MobileTab; onChange: (t: MobileTab) => void }) {
  return (
    <nav className="sticky top-0 z-50 bg-card/95 backdrop-blur-md border-b safe-top">
      <div className="flex items-center justify-around px-1 py-1">
        {TABS.map((tab) => {
          const isActive = active === tab.id;
          return (
            <button key={tab.id} onClick={() => onChange(tab.id)} className={cn("relative flex flex-col items-center justify-center gap-0.5 py-2 px-2 rounded-xl transition-colors min-w-[52px] min-h-[44px] flex-1", isActive ? "text-primary" : "text-muted-foreground")} aria-label={tab.label}>
              <motion.div animate={isActive ? { scale: 1.15 } : { scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 20 }}>{tab.icon}</motion.div>
              <span className={cn("text-[10px] font-medium", isActive && "text-primary")}>{tab.label}</span>
              {isActive && <motion.div layoutId="bottomNavIndicator" className="absolute -bottom-px h-0.5 w-8 rounded-full bg-primary" />}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
