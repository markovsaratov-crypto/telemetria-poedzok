"use client";

// src/components/error-boundary.tsx — v2.38.1 (ревью F21): React error boundary.
// Публичная страница /shared/[token] рендерит данные недоверенного размера
// (трек произвольной длины по share-токену): любой исключение в рендере
// (RangeError на спредах, битые числа из legacy-payload) раньше означало
// белый экран без диагностики. Boundary ловит ошибку и показывает дружелюбный
// fallback с перезагрузкой вместо пустой страницы.

import * as React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Заголовок fallback-карточки (по умолчанию — общий) */
  fallbackTitle?: string;
  /** Текст под заголовком */
  fallbackText?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Страница публичная — телеметрии нет; минимальный лог в консоль
    // (componentStack помогает понять, какой именно виджет упал).
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.error != null) {
      return (
        <main className="min-h-screen flex items-center justify-center p-4 bg-background">
          <div className="w-full max-w-md rounded-lg border bg-card/50 p-6 text-center space-y-3">
            <h1 className="text-lg font-semibold">
              {this.props.fallbackTitle ?? "Не удалось отобразить поездку"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {this.props.fallbackText ??
                "Что-то пошло не так при отрисовке страницы. Попробуйте перезагрузить её — ссылка останется действующей."}
            </p>
            <button
              type="button"
              className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              onClick={() => window.location.reload()}
            >
              Перезагрузить страницу
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
