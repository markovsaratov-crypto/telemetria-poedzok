"use client";
import * as React from "react";

export function MapScreenWrapper({ onSessionTap }: { onSessionTap: (id: string) => void }) {
  const [MapScreen, setMapScreen] = React.useState<React.ComponentType<any> | null>(null);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    import("./MapScreen")
      .then((m) => setMapScreen(() => m.MapScreen))
      .catch(() => setError(true));
  }, []);

  if (error) return <div className="p-8 text-center text-sm text-muted-foreground">Ошибка загрузки карты</div>;
  if (!MapScreen) return <div className="p-8 text-center text-sm text-muted-foreground">Загрузка карты…</div>;
  return <MapScreen onSessionTap={onSessionTap} />;
}
