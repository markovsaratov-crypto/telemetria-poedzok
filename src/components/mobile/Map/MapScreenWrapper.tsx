"use client";
import * as React from "react";
import { MapPin, Loader2 } from "lucide-react";

export function MapScreenWrapper({ onSessionTap }: { onSessionTap: (id: string) => void }) {
  const [mounted, setMounted] = React.useState(false);
  const [MapComponent, setMapComponent] = React.useState<any>(null);

  React.useEffect(() => {
    setMounted(true);
    // Dynamic import — only runs in browser
    import("./MapScreen")
      .then((m) => {
        setMapComponent(() => m.MapScreen);
      })
      .catch((err) => {
        console.error("Map load error:", err);
      });
  }, []);

  if (!mounted) {
    return (
      <div className="flex flex-col h-full">
        <header className="bg-card border-b">
          <div className="flex items-center gap-2 h-14 px-4">
            <MapPin className="h-5 w-5 text-primary" />
            <h1 className="text-[22px] font-bold">Карта</h1>
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!MapComponent) {
    return (
      <div className="flex flex-col h-full">
        <header className="bg-card border-b">
          <div className="flex items-center gap-2 h-14 px-4">
            <MapPin className="h-5 w-5 text-primary" />
            <h1 className="text-[22px] font-bold">Карта</h1>
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Загрузка карты…</span>
        </div>
      </div>
    );
  }

  return <MapComponent onSessionTap={onSessionTap} />;
}
