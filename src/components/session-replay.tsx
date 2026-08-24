"use client";

// src/components/session-replay.tsx — анимация прохождения трека с play/pause и slider.

import * as React from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Gauge,
  Clock,
  RotateCcw,
  MapPin,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const MapTrack = dynamic(() => import("@/components/map-track"), {
  ssr: false,
  loading: () => <div className="h-[320px] w-full rounded-lg shimmer" />,
});

interface ReplayPoint {
  lat: number;
  lon: number;
  speed?: number | null;
  timestamp: number;
  altitude?: number | null;
}

interface SessionReplayProps {
  points: ReplayPoint[];
}

export function SessionReplay({ points }: SessionReplayProps) {
  const [playing, setPlaying] = React.useState(false);
  const [progress, setProgress] = React.useState(0); // 0..points.length-1
  const [speed, setSpeed] = React.useState(1); // 1x, 2x, 4x, 8x

  const total = points.length;
  const currentIdx = Math.round(progress);
  const currentPoint = points[currentIdx];

  // Auto-advance when playing
  React.useEffect(() => {
    if (!playing || total < 2) return;
    const interval = setInterval(() => {
      setProgress((p) => {
        const next = p + 0.5 * speed;
        if (next >= total - 1) {
          setPlaying(false);
          return total - 1;
        }
        return next;
      });
    }, 100); // update every 100ms
    return () => clearInterval(interval);
  }, [playing, total, speed]);

  // Reset when points change
  React.useEffect(() => {
    setPlaying(false);
    setProgress(0);
  }, [points]);

  if (total < 2) {
    return null;
  }

  // Visible points up to current
  const visiblePoints = points.slice(0, currentIdx + 1);
  const markers = currentPoint
    ? [
        {
          lat: currentPoint.lat,
          lon: currentPoint.lon,
          label: `Точка ${currentIdx + 1}/${total}`,
          variant: "pin" as const,
        },
      ]
    : [];

  // Calculate elapsed time
  const startTime = points[0].timestamp;
  const currentTime = currentPoint?.timestamp || startTime;
  const elapsedSec = (currentTime - startTime) / 1000;

  // Current speed in km/h
  const currentSpeedKmh = currentPoint?.speed != null ? currentPoint.speed * 3.6 : null;

  function togglePlay() {
    if (currentIdx >= total - 1) {
      setProgress(0);
    }
    setPlaying((v) => !v);
  }

  function reset() {
    setPlaying(false);
    setProgress(0);
  }

  function skipToEnd() {
    setPlaying(false);
    setProgress(total - 1);
  }

  const speedOptions = [1, 2, 4, 8];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Play className="h-4 w-4 text-primary" />
          Воспроизведение трека
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <MapTrack
          points={visiblePoints}
          markers={markers}
          height="320px"
          fitToPoints
          interactive={false}
        />

        {/* Progress slider */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8 shrink-0"
              onClick={reset}
              title="В начало"
            >
              <SkipBack className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant={playing ? "secondary" : "default"}
              className="h-9 w-9 shrink-0"
              onClick={togglePlay}
              title={playing ? "Пауза" : "Воспроизвести"}
            >
              {playing ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8 shrink-0"
              onClick={skipToEnd}
              title="В конец"
            >
              <SkipForward className="h-3.5 w-3.5" />
            </Button>
            <div className="flex-1">
              <Slider
                value={[currentIdx]}
                min={0}
                max={total - 1}
                step={1}
                onValueChange={(v) => {
                  setPlaying(false);
                  setProgress(v[0]);
                }}
                className="w-full"
              />
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              {speedOptions.map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={cn(
                    "px-1.5 py-0.5 text-[10px] rounded transition-colors",
                    speed === s
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent"
                  )}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Current point info */}
        <AnimatePresence mode="wait">
          {currentPoint && (
            <motion.div
              key={currentIdx}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              className="grid grid-cols-2 sm:grid-cols-4 gap-2"
            >
              <InfoChip
                icon={<MapPin className="h-3 w-3" />}
                label="Точка"
                value={`${currentIdx + 1} / ${total}`}
              />
              <InfoChip
                icon={<Gauge className="h-3 w-3" />}
                label="Скорость"
                value={currentSpeedKmh != null ? `${fmtNumber(currentSpeedKmh, 1)} км/ч` : "—"}
              />
              <InfoChip
                icon={<Clock className="h-3 w-3" />}
                label="Прошло"
                value={formatElapsed(elapsedSec)}
              />
              <InfoChip
                icon={<MapPin className="h-3 w-3" />}
                label="Координаты"
                value={`${currentPoint.lat.toFixed(4)}, ${currentPoint.lon.toFixed(4)}`}
                mono
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Progress bar */}
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>Прогресс:</span>
          <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-emerald-500 to-teal-500"
              animate={{ width: `${(currentIdx / (total - 1)) * 100}%` }}
              transition={{ duration: 0.1 }}
            />
          </div>
          <span className="font-mono">
            {Math.round((currentIdx / (total - 1)) * 100)}%
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function InfoChip({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-card/50 p-2 space-y-0.5">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className={cn("text-xs font-semibold tabular-nums truncate", mono && "font-mono")}>
        {value}
      </div>
    </div>
  );
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}с`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}м ${s}с`;
  const h = Math.floor(m / 60);
  return `${h}ч ${m % 60}м`;
}
