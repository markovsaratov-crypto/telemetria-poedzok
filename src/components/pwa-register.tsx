"use client";

// src/components/pwa-register.tsx — v2.9.8: регистрация service worker (только production)
// + перехват beforeinstallprompt для кнопки «Установить приложение».
// v2.9.9: детект обновления — новый SW уходит в waiting (sw.js больше не делает
// skipWaiting на install), страница показывает баннер «Доступна новая версия»;
// клик «Обновить» → SKIP_WAITING → controllerchange → reload.

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

// ===== v2.9.9: обновление SW с подтверждением =====

const swUpdateListeners = new Set<() => void>();
let waitingWorker: ServiceWorker | null = null;

function setWaitingWorker(w: ServiceWorker | null) {
  waitingWorker = w;
  swUpdateListeners.forEach((l) => l());
}

/**
 * v2.9.9: хук состояния обновления приложения.
 * updateReady=true — новый service worker установлен и ждёт (waiting);
 * applyUpdate() — применить: SKIP_WAITING → новый SW активируется → страница перезагрузится.
 */
export function useSwUpdate() {
  const [updateReady, setUpdateReady] = React.useState(!!waitingWorker);
  React.useEffect(() => {
    const update = () => setUpdateReady(!!waitingWorker);
    swUpdateListeners.add(update);
    return () => {
      swUpdateListeners.delete(update);
    };
  }, []);

  const applyUpdate = React.useCallback(() => {
    const w = waitingWorker;
    if (!w) return;
    // после активации нового контроллера — одна перезагрузка (флаг против цикла)
    let reloaded = false;
    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    // страховка: если controllerchange не случился за 5с — reload всё равно
    window.setTimeout(() => {
      if (!reloaded) {
        reloaded = true;
        window.location.reload();
      }
    }, 5000);
    w.postMessage({ type: "SKIP_WAITING" });
    setWaitingWorker(null);
  }, []);

  return { updateReady, applyUpdate };
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

    let registration: ServiceWorkerRegistration | null = null;
    // если после загрузки страницы новый SW уже waiting (обновился в фоне)
    const onRegistration = (reg: ServiceWorkerRegistration) => {
      registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) {
        setWaitingWorker(reg.waiting);
      }
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          // «installed» + есть активный контроллер → это обновление, а не первая установка
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            setWaitingWorker(newWorker);
          }
        });
      });
    };

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then(onRegistration)
        .catch(() => {
          /* регистрация SW не критична — приложение работает и без него */
        });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    // периодическая проверка обновлений: раз в час + при возврате на вкладку
    const updateTimer = window.setInterval(() => {
      registration?.update().catch(() => {});
    }, 60 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") registration?.update().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(updateTimer);
    };
  }, []);

  return null;
}
