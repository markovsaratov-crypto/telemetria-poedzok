"use client";

// src/components/mobile/SessionList/DestinationLabel.tsx
// Shows reverse-geocoded address for a session destination.

import * as React from "react";
import { MapPin, Loader2 } from "lucide-react";
import { useReverseGeocode } from "@/lib/hooks";
import { cn } from "@/lib/utils";

interface DestinationLabelProps {
  lat: number | null;
  lon: number | null;
  className?: string;
  maxLength?: number;
}

export function DestinationLabel({ lat, lon, className, maxLength = 60 }: DestinationLabelProps) {
  const { data, isLoading, error } = useReverseGeocode(lat, lon);

  if (lat == null || lon == null) {
    return (
      <span className={cn("text-xs text-muted-foreground inline-flex items-center gap-1", className)}>
        <MapPin className="h-3 w-3" /> —
      </span>
    );
  }

  if (isLoading) {
    return (
      <span className={cn("text-xs text-muted-foreground inline-flex items-center gap-1", className)}>
        <Loader2 className="h-3 w-3 animate-spin" /> Адрес…
      </span>
    );
  }

  if (error || !data) {
    return (
      <span className={cn("text-xs text-muted-foreground inline-flex items-center gap-1", className)}>
        <MapPin className="h-3 w-3" /> {lat.toFixed(4)}, {lon.toFixed(4)}
      </span>
    );
  }

  const addr = data.address.length > maxLength
    ? data.address.slice(0, maxLength - 1) + "…"
    : data.address;

  return (
    <span className={cn("text-xs text-muted-foreground inline-flex items-center gap-1", className)} title={data.address}>
      <MapPin className="h-3 w-3 shrink-0" />
      <span className="truncate">{addr}</span>
    </span>
  );
}
