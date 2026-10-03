#!/usr/bin/env node
// scripts/deploy-telemat-web.mjs — v1 (CR-K «деплой сейчас», 2026-10-03).
// Оркестратор деплоя приложения telemat-web (Next.js 16 + OpenNext Cloudflare)
// с ОБХОДОМ «мины v24» (docs/OPERATIONS.md §12/§15: последняя версия скрипта —
// пустой черновик, wrangler deploy / PUT с keep_secrets может унаследовать
// пустоту и стереть 10 секретов воркера).
//
// Стратегия (рунбук §18):
//   1. preflight — токен CF жив, снапшот деплоя (точка отката), ПАРИТЕТ
//      секретов репо ↔ прод (логин/ингест/кроны/админ отвечают «не-401» на
//      значения из секретов репо) — при провале паритета деплой НЕ стартует;
//   2. build — bunx opennextjs-cloudflare build (cf-proxy-swap внутри);
//   3. deploy — bunx wrangler deploy (код + vars + ассеты + GATEWAY_SVC);
//   4. repair-secrets — GET settings: стёртые секреты восстанавливаются
//      через PUT /workers/scripts/{name}/secrets значениями из секретов репо;
//      D1_GATEWAY_SECRET при стирании НЕ восстановим (значение только на CF) —
//      генерируется НОВОЕ + синхронная ротация GATEWAY_SECRET на d1-gateway
//      (multipart PUT, keep_secrets=true — цепочка версий шлюза чистая);
//   5. verify — функциональная матрица против сайта (истина — не settings):
//      логин 200, шлюз /health, биндинги, активный деплой.
//
// Подкоманды:
//   node scripts/deploy-telemat-web.mjs parity     — только проверки сайта (CF-токен не нужен)
//   node scripts/deploy-telemat-web.mjs preflight  — parity + CF-снапшоты (нужен токен)
//   node scripts/deploy-telemat-web.mjs deploy     — полный прогон
//   node scripts/deploy-telemat-web.mjs verify     — функциональная матрица
//   node scripts/deploy-telemat-web.mjs rollback <version_id> — вернуть деплой версии
//
// Env-контракт (значения НИКОГДА не логируются — только имена/коды ответов):
//   CLOUDFLARE_API_TOKEN  — токен шаблона «Edit Cloudflare Workers»
//   CLOUDFLARE_ACCOUNT_ID — default b8e4eee2f19ba22f8d9ccce80691e719
//   SITE                  — default https://poedzok.fun
//   GATEWAY               — default https://d1-gateway.markov-saratov.workers.dev
//   WORKER                — default telemat-web
//   Значения для parity/repair: LOGIN_PASSWORD, SESSION_SECRET, API_KEY,
//   INGEST_TOKEN, CRON_SECRET, ADMIN_TOKEN, BACKUP_ENCRYPTION_KEY
//   (репо-секрет BACKUP_ENCRYPTION_KEY == воркер-секрет GITHUB_BACKUP_ENCRYPTION_KEY).
//
// Выход: 0 = успех; 1 = блокер; 2 = завершено с WARN.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "b8e4eee2f19ba22f8d9ccce80691e719";
const SITE = (process.env.SITE || "https://poedzok.fun").replace(/\/$/, "");
const GATEWAY = (process.env.GATEWAY || "https://d1-gateway.markov-saratov.workers.dev").replace(/\/$/, "");
const WORKER = process.env.WORKER || "telemat-web";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";

// Секреты воркера: имя_воркера → env-переменная оркестратора
const SECRET_SOURCES = {
  LOGIN_PASSWORD: "LOGIN_PASSWORD",
  SESSION_SECRET: "SESSION_SECRET",
  API_KEY: "API_KEY",
  INGEST_TOKEN: "INGEST_TOKEN",
  CRON_SECRET: "CRON_SECRET",
  ADMIN_TOKEN: "ADMIN_TOKEN",
  GITHUB_BACKUP_ENCRYPTION_KEY: "BACKUP_ENCRYPTION_KEY",
  GITHUB_TOKEN: "GITHUB_TOKEN",        // опционален: бэкапы живут в GHA (§12)
  TURSO_AUTH_TOKEN: "TURSO_AUTH_TOKEN" // опционален: Turso-легаси мёртв (§12)
};

function log(msg) { console.log(msg); }
function warn(msg) { console.warn("⚠ " + msg); }
function fail(msg) { console.error("✗ " + msg); process.exit(1); }

function have(name) { const v = process.env[name]; return typeof v === "string" && v.length > 0; }

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 300) }; }
  return { status: res.status, ok: res.ok, json };
}

async function site(path, init = {}) {
  const res = await fetch(`${SITE}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text().catch(() => "");
  return { status: res.status, ok: res.ok, text: text.slice(0, 400) };
}

// ---------- 1. PARITY: секреты репо ↔ живой прод ----------
// Метод: авторизация во всех роутах ПЕРВАЯ (auth-first); валидный секрет →
// код семантики запроса (400/200/503…), невалидный → строго 401.

async function parity() {
  log("── PARITY: секреты репо ↔ прод " + SITE);
  let blockers = 0;

  if (have("LOGIN_PASSWORD")) {
    const r = await site("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: process.env.LOGIN_PASSWORD })
    });
    if (r.status === 200) log("  LOGIN_PASSWORD: 200 ✓ (паритет подтверждён)");
    else { warn(`  LOGIN_PASSWORD: HTTP ${r.status} — ПАРИТЕТ НАРУШЕН (${r.text.slice(0, 120)})`); blockers++; }
  } else { warn("  LOGIN_PASSWORD: значение не передано — проверка пропущена"); }

  if (have("INGEST_TOKEN")) {
    const r = await site("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.INGEST_TOKEN}` },
      body: "{}"
    });
    if (r.status !== 401) log(`  INGEST_TOKEN: HTTP ${r.status} ✓ (токен признан; 400 = валиден, пустое тело)`);
    else { warn("  INGEST_TOKEN: 401 — ПАРИТЕТ НАРУШЕН (SensorLogger сломается!)"); blockers++; }
  } else { warn("  INGEST_TOKEN: значение не передано — проверка пропущена"); }

  if (have("CRON_SECRET")) {
    const r = await site("/api/worker/tick", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }
    });
    if (r.status !== 401) log(`  CRON_SECRET: HTTP ${r.status} ✓ (200/503 = признан)`);
    else { warn("  CRON_SECRET: 401 — ПАРИТЕТ НАРУШЕН (крон-канал шлюза сломается!)"); blockers++; }
  } else { warn("  CRON_SECRET: значение не передано — проверка пропущена"); }

  if (have("ADMIN_TOKEN")) {
    const r = await site("/api/admin/settings", { headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` } });
    if (r.status !== 401) log(`  ADMIN_TOKEN: HTTP ${r.status} ✓`);
    else { warn("  ADMIN_TOKEN: 401 — паритет нарушен (ops-канал сломается)"); blockers++; }
  } else { warn("  ADMIN_TOKEN: значение не передано — проверка пропущено"); }

  log(`  Итог parity: ${blockers === 0 ? "все доступные проверки пройдены" : blockers + " БЛОКЕР(ОВ)"}`);
  return blockers === 0;
}

// ---------- 2. CF-снапшоты ----------

async function cfSnapshot() {
  log("── CF: снапшоты (точка отката)");
  if (!TOKEN) fail("CLOUDFLARE_API_TOKEN не задан (репо-секрет CLOUDFLARE_API_TOKEN)");

  const v = await cf("/user/tokens/verify");
  if (!v.json?.success) fail(`CF-токен не прошёл verify: HTTP ${v.status}`);
  log(`  Токен: active ✓ (id ${v.json.result.id})`);

  const d = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/deployments`);
  if (!d.json?.success) fail(`deployments недоступны: HTTP ${d.status} ${JSON.stringify(d.json.errors || [])}`);
  const deps = d.json.result?.deployments || [];
  const active = deps.find(x => (x.versions || []).some(vr => vr.percentage === 100));
  log(`  Деплоев: ${deps.length}; активный: ${active ? active.id : "НЕ НАЙДЕН"}`);
  let rollbackId = null;
  if (active) {
    const ver = (active.versions || []).find(vr => vr.percentage === 100);
    rollbackId = ver?.version_id || null;
    log(`  ТОЧКА ОТКАТА: version_id=${rollbackId} (создан ${active.created_on})`);
  }

  const vs = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/versions`);
  if (vs.json?.success) {
    const list = vs.json.result || [];
    log(`  Версий всего: ${list.length}; последняя (источник наследования keep_secrets): ${list[list.length - 1]?.id ?? "?"}`);
  }

  const s = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/settings`);
  if (s.json?.success) {
    const bs = s.json.result?.bindings || [];
    log(`  Биндинги ЧЕРНОВИКА (последняя версия): ${bs.length} шт — ${bs.map(b => b.name).join(", ") || "ПУСТО"}`);
  }
  return rollbackId;
}

// ---------- 3. BUILD ----------

function build() {
  log("── BUILD: opennextjs-cloudflare");
  const r = spawnSync("bunx", ["opennextjs-cloudflare", "build"], {
    env: { ...process.env, DATABASE_URL: "file:./db/local.db", NODE_ENV: "production" },
    stdio: "inherit", timeout: 15 * 60_000
  });
  if (r.status !== 0) fail("opennextjs-cloudflare build провалился");
  if (!existsSync(".open-next/worker.js")) fail(".open-next/worker.js не создан");
  log("  Сборка ✓ (.open-next/worker.js + assets)");
}

// ---------- 4. WRANGLER DEPLOY ----------

function wranglerDeploy() {
  log("── DEPLOY: bunx wrangler deploy");
  const r = spawnSync("bunx", ["wrangler", "deploy"], {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, WRANGLER_SEND_METRICS: "false" },
    stdio: "inherit", timeout: 10 * 60_000
  });
  if (r.status !== 0) fail("wrangler deploy провалился (старый деплой жив — откат не нужен)");
  log("  wrangler deploy ✓ (код + vars + ассеты + GATEWAY_SVC)");
}

// ---------- 5. REPAIR SECRETS ----------

async function repairSecrets() {
  log("── REPAIR: сверка секретов после deploy");
  const s = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/settings`);
  if (!s.json?.success) fail(`settings недоступны: HTTP ${s.status}`);
  const bindings = s.json.result?.bindings || [];
  const present = new Set(bindings.map(b => b.name));
  log(`  Биндинги после deploy: ${bindings.length} шт`);

  const missing = Object.keys(SECRET_SOURCES).filter(n => !present.has(n));
  if (missing.length === 0) {
    log("  Все секреты пережили deploy ✓ (мина v24 не сработала — наследование от активного деплоя)");
    return { repaired: [], gatewayRotation: false, newGatewaySecret: null };
  }
  warn(`  СТЁРТЫ при deploy: ${missing.join(", ")} — восстановление через PUT /secrets`);

  let gatewayRotation = false;
  let newGatewaySecret = null;
  const repaired = [];
  for (const name of missing) {
    let value = null;
    if (name === "D1_GATEWAY_SECRET") {
      newGatewaySecret = randomBytes(24).toString("hex");
      value = newGatewaySecret;
      gatewayRotation = true;
      log("  D1_GATEWAY_SECRET: старое значение невосстановимо (живёт только на CF) → НОВОЕ + ротация шлюза");
    } else if (name === "GITHUB_TOKEN" || name === "TURSO_AUTH_TOKEN") {
      value = have(SECRET_SOURCES[name]) ? process.env[SECRET_SOURCES[name]] : `disabled-${name.toLowerCase()}-gha-era`;
      log(`  ${name}: ${have(SECRET_SOURCES[name]) ? "значение из env" : "заглушка (канал мёртв по дизайну §12)"}`);
    } else {
      value = have(SECRET_SOURCES[name]) ? process.env[SECRET_SOURCES[name]] : null;
      if (!value) { warn(`  ${name}: значение НЕ ПЕРЕДАНО — секрет не восстановлен (передайте ${SECRET_SOURCES[name]})`); continue; }
    }
    const r = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/secrets`, {
      method: "PUT",
      body: JSON.stringify({ name, text: value, type: "secret_text" })
    });
    if (r.json?.success) { repaired.push(name); log(`  PUT /secrets ${name} ✓`); }
    else warn(`  PUT /secrets ${name} FAILED: HTTP ${r.status} ${JSON.stringify((r.json.errors || []).map(e => e.message))}`);
  }
  return { repaired, gatewayRotation, newGatewaySecret };
}

// ---------- 6. GATEWAY ROTATION (main-канал GATEWAY_SECRET) ----------

async function rotateGatewaySecret(newValue) {
  log("── GATEWAY: ротация GATEWAY_SECRET (main-канал) на d1-gateway");
  if (!newValue) fail("rotateGatewaySecret: пустое значение");

  const r = spawnSync("bunx", ["esbuild", "cloudflare-worker/d1-gateway.js", "--bundle", "--format=esm", "--outfile=/tmp/gw-deploy-bundle.js"], { stdio: "pipe", timeout: 120_000 });
  if (r.status !== 0) fail("esbuild бандл d1-gateway провалился: " + (r.stderr || "").toString().slice(0, 300));
  const chk = spawnSync("node", ["--check", "/tmp/gw-deploy-bundle.js"], { stdio: "pipe" });
  if (chk.status !== 0) fail("node --check бандла d1-gateway провалился");
  const code = readFileSync("/tmp/gw-deploy-bundle.js", "utf8");
  log(`  Бандл шлюза: ${(code.length / 1024).toFixed(0)} КБ, node --check ✓`);

  const base = JSON.parse(readFileSync("ops/deploy/gateway-put-metadata.json", "utf8"));
  const bindings = [
    ...(base.bindings || []).filter(b => b.name !== "GATEWAY_SECRET"),
    { type: "secret_text", name: "GATEWAY_SECRET", text: newValue }
  ];
  const metadata = {
    main_module: "d1-gateway.js",
    compatibility_date: base.compatibility_date,
    keep_secrets: true,
    bindings
  };
  const fd = new FormData();
  fd.append("metadata", JSON.stringify(metadata));
  fd.append("d1-gateway.js", new Blob([code], { type: "application/javascript+module" }), "d1-gateway.js");

  const put = await cf(`/accounts/${ACCOUNT}/workers/scripts/d1-gateway`, { method: "PUT", body: fd });
  if (!put.json?.success) fail(`PUT d1-gateway провалился: HTTP ${put.status} ${JSON.stringify(put.json.errors || [])}`);
  log("  PUT d1-gateway ✓ (keep_secrets=true — остальные секреты шлюза не тронуты)");

  const h = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(20_000) }).then(r => r.json()).catch(() => null);
  log(`  Шлюз /health: ${JSON.stringify(h)}`);
  if (!h?.ok) warn("Шлюз не ответил ok после ротации — проверьте /health вручную");
}

// ---------- 7. VERIFY ----------

async function verify() {
  log("── VERIFY: функциональная матрица против " + SITE);
  let warns = 0;

  const home = await site("/");
  log(`  GET / : ${home.status} ${home.status === 200 ? "✓" : "✗"}`);
  if (home.status !== 200) warns++;

  if (have("LOGIN_PASSWORD")) {
    const login = await site("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: process.env.LOGIN_PASSWORD })
    });
    log(`  POST /api/auth/login: ${login.status} ${login.status === 200 ? "✓" : "✗"}`);
    if (login.status !== 200) warns++;
  } else warn("  LOGIN_PASSWORD не передан — логин-проверка пропущена");

  const gh = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(20_000) }).then(r => r.json()).catch(() => null);
  log(`  Шлюз /health: ${JSON.stringify(gh)}`);
  if (!gh?.ok) warns++;

  if (TOKEN) {
    const s = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/settings`);
    if (s.json?.success) {
      const bs = s.json.result?.bindings || [];
      const secretCount = bs.filter(b => b.type === "secret_text").length;
      log(`  Биндинги (последняя версия): всего ${bs.length}, секретов ${secretCount}`);
      if (secretCount < 8) { warn(`Секретов ${secretCount} < 8 — мина v24, см. repair-шаг`); warns++; }
    }
    const d = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/deployments`);
    if (d.json?.success) {
      const deps = d.json.result?.deployments || [];
      const active = deps.find(x => (x.versions || []).some(vr => vr.percentage === 100));
      log(`  Активный деплой: ${active ? active.id + " (" + active.created_on + ")" : "НЕ НАЙДЕН"}`);
    }
  } else warn("  CF-токен не передан — CF-проверки пропущены");

  log(`  Итог verify: ${warns === 0 ? "ЧИСТО" : warns + " WARN — см. выше"}`);
  return warns;
}

// ---------- MAIN ----------

const cmd = process.argv[2];
switch (cmd) {
  case "parity": {
    if (!(await parity())) fail("ПАРИТЕТ НАРУШЕН: значения секретов репо ≠ прод. Деплой НЕБЕЗОПАСЕН — нужны значения от владельца.");
    log("PARITY OK");
    break;
  }
  case "preflight": {
    if (!(await parity())) fail("ПАРИТЕТ НАРУШЕН — деплой заблокирован (см. выше)");
    await cfSnapshot();
    log("PREFLIGHT OK");
    break;
  }
  case "deploy": {
    if (!TOKEN) fail("CLOUDFLARE_API_TOKEN не задан — задайте репо-секрет CLOUDFLARE_API_TOKEN (шаблон «Edit Cloudflare Workers») и перезапустите");
    if (!(await parity())) fail("ПАРИТЕТ НАРУШЕН — деплой заблокирован");
    await cfSnapshot();
    build();
    wranglerDeploy();
    const { repaired, gatewayRotation, newGatewaySecret } = await repairSecrets();
    if (gatewayRotation) await rotateGatewaySecret(newGatewaySecret);
    const warns = await verify();
    log("");
    log("══ ИТОГ ДЕПЛОЯ ══");
    if (repaired.length) log(`Восстановлено секретов: ${repaired.join(", ")}`);
    if (gatewayRotation) log("Ротация main-канала GATEWAY_SECRET: выполнена (шлюз + приложение синхронны)");
    log("Откат: node scripts/deploy-telemat-web.mjs rollback <version_id из снапшота выше>");
    process.exit(warns > 0 ? 2 : 0);
    break;
  }
  case "verify": {
    const warns = await verify();
    process.exit(warns > 0 ? 2 : 0);
    break;
  }
  case "rollback": {
    const vid = process.argv[3];
    if (!vid) fail("usage: rollback <version_id>");
    const r = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/deployments`, {
      method: "POST",
      body: JSON.stringify({ versions: [{ version_id: vid, percentage: 100 }] })
    });
    if (!r.json?.success) fail(`rollback провалился: HTTP ${r.status} ${JSON.stringify(r.json.errors || [])}`);
    log(`ROLLBACK ✓ — версия ${vid} на 100% (её собственные биндинги/секреты активны)`);
    break;
  }
  default:
    fail("usage: deploy-telemat-web.mjs <parity|preflight|deploy|verify|rollback> [version_id]");
}
