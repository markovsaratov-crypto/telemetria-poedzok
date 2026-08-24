// src/lib/routing/circuit-breaker.ts — circuit breaker для 2ГИС/OSRM (§3.2, opossum-like)
import { env } from "../env";

interface CircuitState {
  failures: number;
  openUntil: number; // ms timestamp
}

const circuits = new Map<string, CircuitState>();

export function checkCircuit(provider: string): boolean {
  const s = circuits.get(provider);
  if (!s) return true;
  if (Date.now() < s.openUntil) return false;
  // half-open: разрешаем один запрос
  return true;
}

export function recordFailure(provider: string) {
  const threshold = env().CIRCUIT_BREAKER_THRESHOLD;
  const timeoutSec = env().CIRCUIT_BREAKER_TIMEOUT_SEC;
  const s = circuits.get(provider) || { failures: 0, openUntil: 0 };
  s.failures += 1;
  if (s.failures >= threshold) {
    s.openUntil = Date.now() + timeoutSec * 1000;
  }
  circuits.set(provider, s);
}

export function recordSuccess(provider: string) {
  circuits.set(provider, { failures: 0, openUntil: 0 });
}

export function circuitStatus() {
  const out: Record<string, { state: "closed" | "open" | "half-open"; failures: number; openUntil?: number }> = {};
  for (const [k, v] of circuits.entries()) {
    out[k] = {
      state: Date.now() < v.openUntil ? "open" : v.failures > 0 ? "half-open" : "closed",
      failures: v.failures,
      openUntil: v.openUntil > Date.now() ? v.openUntil : undefined,
    };
  }
  return out;
}
