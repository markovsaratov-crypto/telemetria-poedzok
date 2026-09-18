#!/usr/bin/env node
// scripts/cf-proxy-swap.mjs — §B6 v2.40.0: подмена src/proxy.ts →
// src/middleware.ts (Edge-двойник из src/proxy.workers.ts) на время ОДНОЙ
// команды (next build в составе opennextjs-cloudflare build), с гарантированным
// восстановлением дерева (finally) — успех или провал.
//
// ЗАЧЕМ: Next.js 16 компилирует proxy.ts ТОЛЬКО в Node-runtime (неконфигури-
// руемо), а OpenNext Cloudflare не поддерживает Node-Middleware — каждый
// запрос к воркеру 500-ит «Promise.prototype.then called on incompatible
// receiver». Edge-runtime достижим только до-Next16 конвенцией middleware.ts
// (именованный экспорт middleware). Поэтому: прячем proxy.ts → копируем
// proxy.workers.ts в src/middleware.ts → строим → восстанавливаем.
// Сборка Render/CI использует proxy.ts как раньше (дерево после скрипта
// идентично исходному).
//
// Использование: node scripts/cf-proxy-swap.mjs -- <command> [args...]
import { existsSync, renameSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const proxyPath = join(rootDir, "src/proxy.ts");
const proxyStashPath = join(rootDir, "src/proxy.ts.cf-stash");
const workersSourcePath = join(rootDir, "src/proxy.workers.ts");
const middlewarePath = join(rootDir, "src/middleware.ts");

const sepIndex = process.argv.indexOf("--");
const command = sepIndex === -1 ? process.argv.slice(2) : process.argv.slice(sepIndex + 1);
if (command.length === 0) {
  console.error("Usage: node scripts/cf-proxy-swap.mjs -- <command> [args...]");
  process.exit(1);
}

if (!existsSync(proxyPath)) {
  console.error(`cf-proxy-swap: expected ${proxyPath} to exist before swapping`);
  process.exit(1);
}
if (!existsSync(workersSourcePath)) {
  console.error(`cf-proxy-swap: expected ${workersSourcePath} (edge-двойник) to exist`);
  process.exit(1);
}
if (existsSync(proxyStashPath) || existsSync(middlewarePath)) {
  console.error(
    "cf-proxy-swap: предыдущий прогон оставил дерево в свапнутом состоянии " +
      "(src/proxy.ts.cf-stash или src/middleware.ts уже существует) — разобрать вручную."
  );
  process.exit(1);
}

function swapIn() {
  renameSync(proxyPath, proxyStashPath);
  copyFileSync(workersSourcePath, middlewarePath);
  console.log("cf-proxy-swap: proxy.ts спрятан, middleware.ts (edge) подставлен");
}

function swapOut() {
  if (existsSync(middlewarePath)) rmSync(middlewarePath);
  if (existsSync(proxyStashPath) && !existsSync(proxyPath)) {
    renameSync(proxyStashPath, proxyPath);
  }
  console.log("cf-proxy-swap: дерево восстановлено (proxy.ts на месте, middleware.ts удалён)");
}

swapIn();
let result;
try {
  result = spawnSync(command[0], command.slice(1), { stdio: "inherit", cwd: rootDir });
} finally {
  swapOut();
}

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
