"use client";

// src/components/pwa-register.tsx — v2.9.8: регистрация service worker (только production)
// + перехват beforeinstallprompt для кнопки «Установить приложение».

import * as React from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

export function useInstallPrompt() {
  const [canInstall, setCanInstall] = React.useState(!!deferredPrompt);
  React.useEffect(() => {
    const update = () => setCanInstall(!!deferredPrompt);
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);

  const install = React.useCallback(async () => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    listeners.forEach((l) => l());
    return choice.outcome === "accepted";
  }, []);

  return { canInstall, install };
}

export function PwaRegister() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      deferredPrompt = e as BeforeInstallPromptEvent;
      listeners.forEach((l) => l());
    };
    const onInstalled = () => {
      deferredPrompt = null;
      listeners.forEach((l) => l());
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch(() => {
          /* регистрация SW не критична — приложение работает и без него */
        });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  return null;
}
