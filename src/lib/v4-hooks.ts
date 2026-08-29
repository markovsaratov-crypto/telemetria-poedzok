// src/lib/v4-hooks.ts — v2.10.0 React Query хуки для v4 analytics (R1 Live API).
// Используют api-client (credentials:"include"). queryKey: ["v4", "...", sessionId]
// для инвалидации по сессии при переключении поездки.

"use client";

import { useQuery } from "@tanstack/react-query";
import {
  api,
  type TrackResponse,
  type EventsResponse,
} from "./api-client";

// /api/sessions/[id]/track — Leaflet polyline + segments + harsh points.
export function useV4Track(sessionId: string | null) {
  return useQuery<TrackResponse | null>({
    queryKey: ["v4", "track", sessionId],
    queryFn: () => {
      if (!sessionId) return null;
      return api.get<TrackResponse>(`/api/sessions/${sessionId}/track`);
    },
    enabled: !!sessionId,
    staleTime: 60_000,
    retry: 1,
  });
}

// /api/sessions/[id]/events — G-G diagram + harsh events + summary.
export function useV4Events(sessionId: string | null) {
  return useQuery<EventsResponse | null>({
    queryKey: ["v4", "events", sessionId],
    queryFn: () => {
      if (!sessionId) return null;
      return api.get<EventsResponse>(`/api/sessions/${sessionId}/events`);
    },
    enabled: !!sessionId,
    staleTime: 60_000,
    retry: 1,
  });
}
