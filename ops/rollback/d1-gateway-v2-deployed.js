var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ingest-port.js
var INGEST_MAX_POINTS = 1e3;
var TS_PLAUSIBILITY_MS = 24 * 60 * 60 * 1e3;
var MAX_TRUSTED_ACCURACY_M = 100;
var GAP_MARKER_MS = 3e4;
var EDGE_PARAM_BUDGET = 90;
var EDGE_BATCH_STMT_CHUNK = 400;
var EDGE_INGEST_MAX_BYTES = 1048576;
var CLIENT_ID_RE = /^[a-zA-Z0-9_-]+$/;
function parseTimestamp(raw) {
  const num = Number(raw);
  if (!isNaN(num) && String(raw).trim() !== "") {
    if (num >= 1e16) return Math.floor(num / 1e6);
    if (num >= 1e13) return Math.floor(num / 1e3);
    if (num >= 1e10) return num;
    if (num >= 1e9) return num * 1e3;
    return null;
  }
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? null : d.getTime();
}
__name(parseTimestamp, "parseTimestamp");
function validateIngestBody(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const b = (
    /** @type {Record<string, unknown>} */
    body
  );
  if (typeof b.deviceId !== "string" || b.deviceId.length < 1 || b.deviceId.length > 64) {
    return { ok: false, error: "deviceId: required string 1..64" };
  }
  if (typeof b.clientId !== "string" || b.clientId.length < 1 || b.clientId.length > 64 || !CLIENT_ID_RE.test(b.clientId)) {
    return { ok: false, error: "clientId: required string 1..64, [A-Za-z0-9_-]" };
  }
  if (b.deviceName != null && (typeof b.deviceName !== "string" || b.deviceName.length > 128)) {
    return { ok: false, error: "deviceName: optional string \u2264128" };
  }
  if (!Array.isArray(b.points) || b.points.length < 1 || b.points.length > INGEST_MAX_POINTS) {
    return { ok: false, error: `points: required array 1..${INGEST_MAX_POINTS}` };
  }
  for (let i = 0; i < b.points.length; i++) {
    const p = b.points[i];
    if (p == null || typeof p !== "object" || Array.isArray(p)) {
      return { ok: false, error: `points[${i}]: object required` };
    }
    const pt = (
      /** @type {Record<string, unknown>} */
      p
    );
    const lat = pt.lat;
    if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      return { ok: false, error: `points[${i}].lat: number [-90..90]` };
    }
    const lon = pt.lon;
    if (typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      return { ok: false, error: `points[${i}].lon: number [-180..180]` };
    }
    if (pt.speed != null && (typeof pt.speed !== "number" || !Number.isFinite(pt.speed) || pt.speed < 0 || pt.speed > 83.33)) {
      return { ok: false, error: `points[${i}].speed: number [0..83.33]` };
    }
    if (pt.altitude != null && (typeof pt.altitude !== "number" || !Number.isFinite(pt.altitude))) {
      return { ok: false, error: `points[${i}].altitude: number` };
    }
    if (pt.accuracy != null && (typeof pt.accuracy !== "number" || !Number.isFinite(pt.accuracy) || pt.accuracy < 0)) {
      return { ok: false, error: `points[${i}].accuracy: number \u22650` };
    }
    if (typeof pt.timestamp !== "number" || !Number.isFinite(pt.timestamp)) {
      return { ok: false, error: `points[${i}].timestamp: finite number required` };
    }
    if (pt.bearing != null && (typeof pt.bearing !== "number" || !Number.isFinite(pt.bearing) || pt.bearing < 0 || pt.bearing > 360)) {
      return { ok: false, error: `points[${i}].bearing: number [0..360]` };
    }
  }
  return {
    ok: true,
    value: {
      deviceId: b.deviceId,
      clientId: b.clientId,
      deviceName: typeof b.deviceName === "string" ? b.deviceName : null,
      points: b.points
    }
  };
}
__name(validateIngestBody, "validateIngestBody");
function normalizeIngestPoints(points, nowMs) {
  let droppedTimestamp = 0;
  let droppedInaccurate = 0;
  const normalized = [];
  for (const p of points) {
    const ts = parseTimestamp(String(p.timestamp));
    if (ts == null || Math.abs(nowMs - ts) > TS_PLAUSIBILITY_MS) {
      droppedTimestamp++;
      continue;
    }
    const acc = p.accuracy == null ? null : Number(p.accuracy);
    if (acc != null && acc > MAX_TRUSTED_ACCURACY_M) {
      droppedInaccurate++;
      continue;
    }
    normalized.push({
      lat: Number(p.lat),
      lon: Number(p.lon),
      speed: p.speed == null ? null : Number(p.speed),
      altitude: p.altitude == null ? null : Number(p.altitude),
      accuracy: acc,
      bearing: p.bearing == null ? null : Number(p.bearing),
      timestampMs: ts
    });
  }
  normalized.sort((a, b) => a.timestampMs - b.timestampMs);
  return { normalized, droppedTimestamp, droppedInaccurate };
}
__name(normalizeIngestPoints, "normalizeIngestPoints");
function countGapMarkers(normalized) {
  let gaps = 0;
  let lastTs = null;
  for (const p of normalized) {
    if (lastTs !== null && p.timestampMs - lastTs > GAP_MARKER_MS) gaps++;
    lastTs = p.timestampMs;
  }
  return gaps;
}
__name(countGapMarkers, "countGapMarkers");
var DAY_FMT_CACHE = /* @__PURE__ */ new Map();
function dayFormatter(zone) {
  let f = DAY_FMT_CACHE.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      f = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
    }
    DAY_FMT_CACHE.set(zone, f);
  }
  return f;
}
__name(dayFormatter, "dayFormatter");
function rollupDayKey(tsMs, zone) {
  const z = zone || "UTC";
  return dayFormatter(z).format(new Date(tsMs));
}
__name(rollupDayKey, "rollupDayKey");
function findExistingSessionStatement(q) {
  if (q.userId != null) {
    return {
      sql: "SELECT id, status, deletedAt FROM Session WHERE deviceId = ? AND clientId = ? AND userId = ? LIMIT 1",
      args: [q.deviceId, q.clientId, q.userId]
    };
  }
  return {
    sql: "SELECT id, status, deletedAt FROM Session WHERE deviceId = ? AND clientId = ? AND userId IS NULL LIMIT 1",
    args: [q.deviceId, q.clientId]
  };
}
__name(findExistingSessionStatement, "findExistingSessionStatement");
function tombstoneSessionStatement(sessionId, clientId) {
  return {
    sql: "UPDATE Session SET clientId = ? WHERE id = ?",
    args: [`${clientId}#deleted#${String(sessionId).slice(0, 8)}`, sessionId]
  };
}
__name(tombstoneSessionStatement, "tombstoneSessionStatement");
function buildIngestStatements(opts) {
  const now = opts.now ?? Date.now();
  const newId = opts.newId ?? (typeof crypto !== "undefined" && crypto.randomUUID ? () => crypto.randomUUID() : () => String(Math.random()));
  const sessionId = newId();
  const jobId = newId();
  const nowIso = new Date(now).toISOString();
  const pts = opts.normalized;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const stmts = [
    {
      sql: `INSERT INTO Session (id, deviceId, clientId, deviceName, startTime, endTime, pointCount, payloadBytes, status, userId, trafficJobId, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      args: [
        sessionId,
        opts.deviceId,
        opts.clientId,
        opts.deviceName ?? null,
        new Date(first.timestampMs).toISOString(),
        new Date(last.timestampMs).toISOString(),
        pts.length,
        opts.payloadBytes,
        opts.userId ?? null,
        jobId,
        nowIso,
        nowIso
      ]
    }
  ];
  const POINT_COLS = ["id", "sessionId", "lat", "lon", "speed", "altitude", "accuracy", "timestamp", "bearing"];
  const ph = `(${POINT_COLS.map(() => "?").join(", ")})`;
  const CH = Math.max(1, Math.floor(EDGE_PARAM_BUDGET / POINT_COLS.length));
  const pointIds = [];
  const rows = pts.map((p) => {
    const id = newId();
    pointIds.push(id);
    return [id, sessionId, p.lat, p.lon, p.speed, p.altitude, p.accuracy, p.timestampMs, p.bearing];
  });
  for (let i = 0; i < rows.length; i += CH) {
    const chunk = rows.slice(i, i + CH);
    stmts.push({
      sql: `INSERT INTO GpsPoint (${POINT_COLS.join(", ")}) VALUES ${chunk.map(() => ph).join(", ")}`,
      args: chunk.flat()
    });
  }
  stmts.push({
    sql: `INSERT INTO TrafficJob (id, sessionId, status, attempts, priority, scheduledFor, createdAt, updatedAt)
          VALUES (?, ?, 'pending', 0, 0, ?, ?, ?)`,
    args: [jobId, sessionId, nowIso, nowIso, nowIso]
  });
  if (opts.includeRollup !== false) {
    const day = opts.rollupDay ?? rollupDayKey(first.timestampMs, opts.rollupZone);
    const uid = opts.userId == null ? "" : String(opts.userId);
    stmts.push({
      sql: `INSERT INTO StatsRollup (day, userId, sessions, points, distanceM, durationSec, ecoSum, ecoCount, updatedAt)
            VALUES (?, ?, 1, ?, 0, 0, 0, 0, ?)
            ON CONFLICT(day, userId) DO UPDATE SET
              sessions = sessions + excluded.sessions,
              points = points + excluded.points,
              updatedAt = excluded.updatedAt`,
      args: [day, uid, pts.length, nowIso]
    });
  }
  return { statements: stmts, sessionId, jobId, pointIds };
}
__name(buildIngestStatements, "buildIngestStatements");
function chunkStatements(stmts, size = EDGE_BATCH_STMT_CHUNK) {
  const out = [];
  for (let i = 0; i < stmts.length; i += size) out.push(stmts.slice(i, i + size));
  return out;
}
__name(chunkStatements, "chunkStatements");
async function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const enc = new TextEncoder();
  const [got, want] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected))
  ]);
  const a = new Uint8Array(got);
  const b = new Uint8Array(want);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
__name(tokenMatches, "tokenMatches");
function jsonResponse(body, status, requestId) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...requestId ? { "x-request-id": requestId } : {}
    }
  });
}
__name(jsonResponse, "jsonResponse");
async function readBodyCapped(request, maxBytes) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) {
    const t = await request.text().catch(() => "");
    return t.length > maxBytes ? null : t;
  }
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {
      });
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    joined.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}
__name(readBodyCapped, "readBodyCapped");
async function handleEdgeIngest(request, env) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, requestId);
    }
    const url = new URL(request.url);
    const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || null;
    const queryToken = url.searchParams.get("token");
    const gwSecret = env.GATEWAY_SECRET || null;
    const ingestToken = env.INGEST_TOKEN || null;
    const viaSecret = gwSecret ? await tokenMatches(request.headers.get("x-gateway-secret"), gwSecret) : false;
    const viaIngest = bearer && ingestToken && await tokenMatches(bearer, ingestToken) || queryToken && ingestToken && await tokenMatches(queryToken, ingestToken);
    if (!viaSecret && !viaIngest) {
      return jsonResponse(
        {
          error: "Unauthorized",
          reason: ingestToken ? "Bearer INGEST_TOKEN / ?token= (SensorLogger) or X-Gateway-Secret required; per-user it_/apiKey \u2014 use Render /api/ingest" : "X-Gateway-Secret required (INGEST_TOKEN not configured on worker)"
        },
        401,
        requestId
      );
    }
    const maxBytes = env.EDGE_INGEST_MAX_BYTES || EDGE_INGEST_MAX_BYTES;
    const raw = await readBodyCapped(request, maxBytes);
    if (raw == null) {
      return jsonResponse({ error: "Payload too large", limit: maxBytes }, 413, requestId);
    }
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    const parsed = validateIngestBody(body);
    if (!parsed.ok) {
      return jsonResponse({ error: "Validation failed", details: parsed.error }, 400, requestId);
    }
    const { deviceId, clientId, deviceName, points } = parsed.value;
    const lookup = findExistingSessionStatement({ deviceId, clientId, userId: null });
    const existing = await env.DB.prepare(lookup.sql).bind(...lookup.args).first();
    if (existing && !existing.deletedAt) {
      return jsonResponse({ sessionId: String(existing.id), duplicate: true }, 200, requestId);
    }
    if (existing && existing.deletedAt) {
      const tomb = tombstoneSessionStatement(String(existing.id), clientId);
      await env.DB.prepare(tomb.sql).bind(...tomb.args).run();
    }
    const nowMs = Date.now();
    const { normalized, droppedTimestamp, droppedInaccurate } = normalizeIngestPoints(points, nowMs);
    if (normalized.length === 0) {
      return jsonResponse(
        {
          error: "All points rejected by input filters",
          dropped: { timestamp: droppedTimestamp, accuracy: droppedInaccurate },
          plausibilityWindowHours: TS_PLAUSIBILITY_MS / (60 * 60 * 1e3),
          maxAccuracyM: MAX_TRUSTED_ACCURACY_M
        },
        400,
        requestId
      );
    }
    const gapMarkers = countGapMarkers(normalized);
    const includeRollup = (env.EDGE_INGEST_ROLLUP_ENABLED || "true") === "true";
    const built = buildIngestStatements({
      deviceId,
      clientId,
      deviceName,
      userId: null,
      normalized,
      payloadBytes: raw.length,
      now: nowMs,
      rollupDay: includeRollup ? rollupDayKey(normalized[0].timestampMs, env.TELEMAT_TIMEZONE || "UTC") : void 0,
      includeRollup
    });
    const groups = chunkStatements(built.statements);
    for (const group of groups) {
      await env.DB.batch(group.map((s) => env.DB.prepare(s.sql).bind(...s.args)));
    }
    return jsonResponse(
      {
        sessionId: built.sessionId,
        pointsAccepted: normalized.length,
        dropped: { timestamp: droppedTimestamp, accuracy: droppedInaccurate },
        gapMarkers,
        trafficJobId: built.jobId,
        duplicate: false
      },
      201,
      requestId
    );
  } catch (err) {
    try {
      const bodyRace = await request.clone().json().catch(() => null);
      if (bodyRace && typeof bodyRace.deviceId === "string" && typeof bodyRace.clientId === "string") {
        const lookup = findExistingSessionStatement({ deviceId: bodyRace.deviceId, clientId: bodyRace.clientId, userId: null });
        const raced = await env.DB.prepare(lookup.sql).bind(...lookup.args).first();
        if (raced && !raced.deletedAt) {
          return jsonResponse({ sessionId: String(raced.id), duplicate: true }, 200, requestId);
        }
      }
    } catch {
    }
    return jsonResponse({ error: "Internal Server Error" }, 500, requestId);
  }
}
__name(handleEdgeIngest, "handleEdgeIngest");
var IT_TOKEN_RE = /^it_[0-9a-f]{32}$/;
async function deriveItToken(sessionSecret, apiKey) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(sessionSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${apiKey}:ingest`));
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
  return `it_${hex.slice(0, 32)}`;
}
__name(deriveItToken, "deriveItToken");
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
var IT_CACHE_TTL_SEC = 600;
async function verifyEdgeItToken(env, token) {
  if (!IT_TOKEN_RE.test(String(token))) return null;
  if (!env.SESSION_SECRET) return null;
  const cacheKey = `edgeit:${(await sha256Hex(String(token))).slice(0, 24)}`;
  let cached = null;
  try {
    if (env.KV && typeof env.KV.get === "function") {
      cached = await env.KV.get(cacheKey, "text");
    }
  } catch {
  }
  if (cached && /^[A-Za-z0-9_-]{1,64}$/.test(cached)) return cached;
  const rows = await env.DB.prepare("SELECT id, apiKey FROM User").all();
  for (const u of rows.results ?? []) {
    const expected = await deriveItToken(env.SESSION_SECRET, String(u.apiKey));
    if (await tokenMatches(String(token), expected)) {
      try {
        if (env.KV && typeof env.KV.put === "function") {
          await env.KV.put(cacheKey, String(u.id), { expirationTtl: IT_CACHE_TTL_SEC });
        }
      } catch {
      }
      return String(u.id);
    }
  }
  return null;
}
__name(verifyEdgeItToken, "verifyEdgeItToken");
var DEVICE_ID_RE = /^[A-Za-z0-9_.:\- ]{1,64}$/;
var DEVICE_NAME_RE = /^[^\n\r]{1,128}$/;
var MAX_BATCH_ITEMS = 5e3;
var MAX_POINT_ACCURACY_M = 100;
var ARRAY_KEYS = [
  "payload",
  "points",
  "data",
  "records",
  "readings",
  "sensors",
  "measurements",
  "samples",
  "locations",
  "entries",
  "batches"
];
var LOCATION_NAMES = ["location", "gps", "position", "coords", "coordinates", "latitude"];
function normalizeItem(item) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const r = item;
    if (typeof r.name === "string" && r.values && typeof r.values === "object" && !Array.isArray(r.values)) {
      return { ...r, time: r.time ?? r.timestamp, location: r.values };
    }
  }
  return item;
}
__name(normalizeItem, "normalizeItem");
function extractItems(body) {
  if (Array.isArray(body)) return body.map(normalizeItem);
  if (body && typeof body === "object") {
    const obj = body;
    for (const key of ARRAY_KEYS) {
      const v = obj[key];
      if (Array.isArray(v)) {
        if (v.length === 0) return [];
        if (Array.isArray(v[0])) return v.flat().map(normalizeItem);
        return v.map(normalizeItem);
      }
    }
    const data = obj.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const nested = data;
      for (const key of [...ARRAY_KEYS, "location", "gps", "position", "coords"]) {
        const v = nested[key];
        if (Array.isArray(v) && v.length > 0) return v.map(normalizeItem);
      }
    }
    return [body];
  }
  return null;
}
__name(extractItems, "extractItems");
function extractPoint(raw, nowMs) {
  const loc = raw.location ?? raw.coords ?? raw.position ?? raw.gps ?? {};
  const lat = raw.latitude ?? raw.lat ?? loc.latitude ?? loc.lat;
  const lon = raw.longitude ?? raw.lon ?? raw.lng ?? loc.longitude ?? loc.lon ?? loc.lng;
  if (lat == null || lon == null || isNaN(Number(lat)) || isNaN(Number(lon))) return null;
  if (Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180) return null;
  if (Number(lat) === -1 && Number(lon) === -1) return null;
  const tsRaw = raw.time ?? raw.timestamp;
  if (tsRaw == null) return null;
  const timestampMs = parseTimestamp(String(tsRaw));
  if (timestampMs == null) return null;
  if (Math.abs(nowMs - timestampMs) > TS_PLAUSIBILITY_MS) return null;
  const speed = raw.speed ?? loc.speed ?? null;
  const altitude = raw.altitude ?? loc.altitude ?? null;
  const accuracy = raw.horizontalAccuracy ?? raw.accuracy ?? loc.horizontalAccuracy ?? loc.accuracy ?? null;
  const bearing = raw.course ?? raw.bearing ?? raw.heading ?? loc.course ?? loc.bearing ?? loc.heading ?? null;
  return {
    lat: Number(lat),
    lon: Number(lon),
    speed: speed != null && Number(speed) >= 0 ? Number(speed) : null,
    altitude: altitude != null && Number(altitude) >= -1e3 ? Number(altitude) : null,
    accuracy: accuracy != null && Number(accuracy) >= 0 ? Number(accuracy) : null,
    bearing: bearing != null && Number(bearing) >= 0 && Number(bearing) <= 360 ? Number(bearing) : null,
    timestampMs
  };
}
__name(extractPoint, "extractPoint");
function describeItems(items) {
  const hist = /* @__PURE__ */ new Map();
  let hasLocation = false;
  for (const it of items) {
    const name = it && typeof it === "object" && typeof it.name === "string" ? it.name : "(\u0431\u0435\u0437 name)";
    if (LOCATION_NAMES.some((ln) => name.toLowerCase().includes(ln))) hasLocation = true;
    hist.set(name, (hist.get(name) ?? 0) + 1);
  }
  const histStr = [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}\xD7${c}`).join(", ");
  return `items[${items.length}] sensors: ${histStr}${hasLocation ? " \xB7 location OK" : " \xB7 location-\u0437\u0430\u043F\u0438\u0441\u0435\u0439 \u041D\u0415\u0422"}`;
}
__name(describeItems, "describeItems");
function findActiveRecordingStatement(deviceId, userId) {
  if (userId != null) {
    return {
      sql: "SELECT id, startTime, endTime, updatedAt FROM Session WHERE deviceId = ? AND status = 'recording' AND deletedAt IS NULL AND userId = ? ORDER BY updatedAt DESC LIMIT 1",
      args: [deviceId, userId]
    };
  }
  return {
    sql: "SELECT id, startTime, endTime, updatedAt FROM Session WHERE deviceId = ? AND status = 'recording' AND deletedAt IS NULL AND userId IS NULL ORDER BY updatedAt DESC LIMIT 1",
    args: [deviceId]
  };
}
__name(findActiveRecordingStatement, "findActiveRecordingStatement");
function createRecordingStatement(opts) {
  const userIdSql = opts.userId != null ? "userId, " : "";
  const userIdPh = opts.userId != null ? "?, " : "";
  const guard = opts.userId != null ? "NOT EXISTS (SELECT 1 FROM Session WHERE deviceId = ? AND status = 'recording' AND deletedAt IS NULL AND userId = ?)" : "NOT EXISTS (SELECT 1 FROM Session WHERE deviceId = ? AND status = 'recording' AND deletedAt IS NULL AND userId IS NULL)";
  const args = [
    opts.sessionId,
    opts.deviceId,
    opts.clientId,
    opts.deviceName,
    opts.startTimeIso,
    opts.startTimeIso,
    opts.nowIso,
    opts.nowIso,
    ...opts.userId != null ? [opts.userId] : [],
    opts.deviceId,
    ...opts.userId != null ? [opts.userId] : []
  ];
  return {
    sql: `INSERT INTO Session (id, deviceId, clientId, deviceName, startTime, endTime, pointCount, payloadBytes, status, createdAt, updatedAt${opts.userId != null ? ", userId" : ""})
          SELECT ?, ?, ?, ?, ?, ?, 0, 0, 'recording', ?, ?${opts.userId != null ? ", ?" : ""}
          WHERE ${guard}`,
    args
  };
}
__name(createRecordingStatement, "createRecordingStatement");
function pointInsertStatements(sessionId, points, newId) {
  const POINT_COLS = ["id", "sessionId", "lat", "lon", "speed", "altitude", "accuracy", "timestamp", "bearing"];
  const ph = `(${POINT_COLS.map(() => "?").join(", ")})`;
  const CH = Math.max(1, Math.floor(EDGE_PARAM_BUDGET / POINT_COLS.length));
  const stmts = [];
  for (let i = 0; i < points.length; i += CH) {
    const chunk = points.slice(i, i + CH);
    const args = [];
    for (const p of chunk) {
      args.push(newId(), sessionId, p.lat, p.lon, p.speed, p.altitude, p.accuracy, p.timestampMs, p.bearing);
    }
    stmts.push({
      sql: `INSERT INTO GpsPoint (${POINT_COLS.join(", ")}) VALUES ${chunk.map(() => ph).join(", ")}`,
      args
    });
  }
  return stmts;
}
__name(pointInsertStatements, "pointInsertStatements");
async function handleEdgeSensorLogger(request, env) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const url = new URL(request.url);
    if (request.method === "GET") {
      const queryToken2 = url.searchParams.get("token");
      const bearer2 = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || null;
      const gwSecret2 = env.GATEWAY_SECRET || null;
      const ingestToken2 = env.INGEST_TOKEN || null;
      const viaSecret2 = gwSecret2 ? await tokenMatches(request.headers.get("x-gateway-secret"), gwSecret2) : false;
      const viaIngest2 = bearer2 && ingestToken2 && await tokenMatches(bearer2, ingestToken2) || queryToken2 && ingestToken2 && await tokenMatches(queryToken2, ingestToken2);
      let viaIt = false;
      if (!viaSecret2 && !viaIngest2) {
        const presented = bearer2 ?? queryToken2;
        if (presented && IT_TOKEN_RE.test(presented)) viaIt = await verifyEdgeItToken(env, presented) != null;
      }
      if (!viaSecret2 && !viaIngest2 && !viaIt) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401, requestId);
      }
      return jsonResponse({
        ok: true,
        endpoint: "/api/ingest/sensorlogger",
        method: "POST",
        edge: true,
        format: "JSON array of { time, location: { latitude, longitude, speed, altitude, horizontalAccuracy, course } }",
        auth: "Authorization: Bearer <INGEST_TOKEN or it_ ingest token> OR ?token=<same>",
        requiredParams: ["deviceId"],
        optionalParams: ["deviceName"]
      }, 200, requestId);
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, requestId);
    }
    const queryToken = url.searchParams.get("token");
    const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || null;
    const gwSecret = env.GATEWAY_SECRET || null;
    const ingestToken = env.INGEST_TOKEN || null;
    const viaSecret = gwSecret ? await tokenMatches(request.headers.get("x-gateway-secret"), gwSecret) : false;
    const viaIngest = bearer && ingestToken && await tokenMatches(bearer, ingestToken) || queryToken && ingestToken && await tokenMatches(queryToken, ingestToken);
    let ingestUserId = null;
    if (!viaSecret && !viaIngest) {
      const presented = bearer ?? queryToken;
      if (presented && IT_TOKEN_RE.test(presented)) {
        const userId = await verifyEdgeItToken(env, presented);
        if (userId == null) {
          return jsonResponse(
            { error: "Unauthorized: Invalid it_ ingest token (edge: SESSION_SECRET/User verification failed \u2014 Render channel remains available)" },
            401,
            requestId
          );
        }
        ingestUserId = userId;
      } else {
        return jsonResponse(
          {
            error: "Unauthorized",
            reason: ingestToken ? "Bearer INGEST_TOKEN / ?token= (SensorLogger) or X-Gateway-Secret required; per-user apiKey \u2014 only Bearer via Render /api/ingest" : "X-Gateway-Secret required (INGEST_TOKEN not configured on worker)"
          },
          401,
          requestId
        );
      }
    }
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) {
      return jsonResponse({ error: "deviceId query param required. Example: ?deviceId=iphone-15-pro" }, 400, requestId);
    }
    if (!DEVICE_ID_RE.test(deviceId)) {
      return jsonResponse({ error: "Invalid deviceId: 1-64 chars, letters/digits/dots/dashes/colons/spaces only" }, 400, requestId);
    }
    const deviceNameRaw = url.searchParams.get("deviceName") || "SensorLogger";
    const deviceName = DEVICE_NAME_RE.test(deviceNameRaw) ? deviceNameRaw.slice(0, 128) : "SensorLogger";
    const maxBytes = env.EDGE_INGEST_MAX_BYTES || EDGE_INGEST_MAX_BYTES;
    const raw = await readBodyCapped(request, maxBytes);
    if (raw == null) {
      return jsonResponse({ error: "Payload too large", limit: maxBytes }, 413, requestId);
    }
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (!body) {
      return jsonResponse({ error: "Invalid JSON body" }, 400, requestId);
    }
    const msgId = body && typeof body === "object" && !Array.isArray(body) ? body.messageId : void 0;
    const hasMsgId = msgId != null && (typeof msgId === "number" || typeof msgId === "string");
    if (hasMsgId) {
      try {
        const seen = await env.DB.prepare("SELECT 1 FROM IngestMessage WHERE deviceId = ? AND messageId = ? LIMIT 1").bind(deviceId, String(msgId)).first();
        if (seen) {
          return jsonResponse(
            { ok: true, duplicate: true, message: "Batch already processed (messageId seen)", deviceId, deviceName },
            200,
            requestId
          );
        }
      } catch {
      }
    }
    const items = extractItems(body);
    if (!items || items.length === 0) {
      console.log(JSON.stringify({ level: "info", msg: "edge sensorlogger: empty/test push", requestId, deviceId, shape: typeof body }));
      return jsonResponse(
        { ok: true, test: true, message: "SensorLogger push test passed. Ready to receive GPS data.", deviceId, deviceName },
        200,
        requestId
      );
    }
    if (items.length > MAX_BATCH_ITEMS) {
      return jsonResponse({ error: "Too many points in batch", limit: MAX_BATCH_ITEMS, received: items.length }, 413, requestId);
    }
    const nowMs = Date.now();
    let droppedInaccurate = 0;
    let droppedUnparsed = 0;
    const points = [];
    for (const item of items) {
      const p = extractPoint(item, nowMs);
      if (p == null) {
        droppedUnparsed++;
        continue;
      }
      if (p.accuracy != null && p.accuracy > MAX_POINT_ACCURACY_M) {
        droppedInaccurate++;
        continue;
      }
      points.push(p);
    }
    if (points.length === 0) {
      console.log(JSON.stringify({
        level: "info",
        msg: "edge sensorlogger: no GPS in batch",
        requestId,
        deviceId,
        droppedInaccurate,
        droppedUnparsed,
        sample: describeItems(items).slice(0, 300)
      }));
      return jsonResponse(
        {
          ok: true,
          test: true,
          message: "No GPS points extracted from batch (missing location data). Push test passed.",
          deviceId,
          deviceName,
          payloadShape: describeItems(items).slice(0, 300)
        },
        200,
        requestId
      );
    }
    points.sort((a, b) => a.timestampMs - b.timestampMs);
    const sessionGapMs = Number(env.SESSION_GAP_MS) > 0 ? Number(env.SESSION_GAP_MS) : 6e4;
    const lookup = findActiveRecordingStatement(deviceId, ingestUserId);
    const recent = await env.DB.prepare(lookup.sql).bind(...lookup.args).first();
    let sessionId = null;
    let sessionStartMs = NaN;
    let sessionEndMs = NaN;
    let isNewSession = false;
    if (recent) {
      const row = recent;
      sessionStartMs = new Date(String(row.startTime)).getTime();
      sessionEndMs = row.endTime != null ? new Date(String(row.endTime)).getTime() : NaN;
      const firstBatchTs = points[0].timestampMs;
      const gapMs = Number.isFinite(sessionEndMs) ? firstBatchTs - sessionEndMs : nowMs - new Date(String(row.updatedAt)).getTime();
      if (gapMs < sessionGapMs) {
        sessionId = String(row.id);
      } else {
        isNewSession = true;
      }
    } else {
      isNewSession = true;
    }
    if (isNewSession) {
      const newId = crypto.randomUUID();
      const create = createRecordingStatement({
        sessionId: newId,
        deviceId,
        clientId: crypto.randomUUID(),
        deviceName,
        startTimeIso: new Date(points[0].timestampMs).toISOString(),
        nowIso: new Date(nowMs).toISOString(),
        userId: ingestUserId
      });
      const res = await env.DB.prepare(create.sql).bind(...create.args).run();
      if ((res.meta?.changes ?? 0) > 0) {
        sessionId = newId;
      } else {
        const again = await env.DB.prepare(lookup.sql).bind(...lookup.args).first();
        if (again) {
          sessionId = String(again.id);
          isNewSession = false;
          sessionStartMs = new Date(String(again.startTime)).getTime();
          sessionEndMs = again.endTime != null ? new Date(String(again.endTime)).getTime() : NaN;
        } else {
          sessionId = newId;
        }
      }
    }
    const newIdFn = /* @__PURE__ */ __name(() => crypto.randomUUID(), "newIdFn");
    const pointStmts = pointInsertStatements(sessionId, points, newIdFn);
    for (const st of pointStmts) {
      await env.DB.prepare(st.sql).bind(...st.args).run();
    }
    const lastTs = points[points.length - 1].timestampMs;
    const firstTs = points[0].timestampMs;
    const currentStart = Number.isFinite(sessionStartMs) ? Math.min(sessionStartMs, firstTs) : firstTs;
    const currentEnd = Number.isFinite(sessionEndMs) ? Math.max(sessionEndMs, lastTs) : lastTs;
    await env.DB.prepare(
      "UPDATE Session SET startTime = ?, endTime = ?, pointCount = pointCount + ?, payloadBytes = payloadBytes + ?, updatedAt = ? WHERE id = ?"
    ).bind(
      new Date(currentStart).toISOString(),
      new Date(currentEnd).toISOString(),
      points.length,
      raw.length,
      new Date(nowMs).toISOString(),
      sessionId
    ).run();
    if ((env.EDGE_INGEST_ROLLUP_ENABLED || "true") === "true") {
      try {
        const day = rollupDayKey(lastTs, env.TELEMAT_TIMEZONE || "UTC");
        const uid = ingestUserId == null ? "" : String(ingestUserId);
        await env.DB.prepare(
          `INSERT INTO StatsRollup (day, userId, sessions, points, distanceM, durationSec, ecoSum, ecoCount, updatedAt)
           VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)
           ON CONFLICT(day, userId) DO UPDATE SET
             sessions = sessions + excluded.sessions,
             points = points + excluded.points,
             updatedAt = excluded.updatedAt`
        ).bind(day, uid, isNewSession ? 1 : 0, points.length, new Date(nowMs).toISOString()).run();
      } catch {
      }
    }
    if (hasMsgId) {
      try {
        await env.DB.prepare("INSERT OR IGNORE INTO IngestMessage (deviceId, messageId, firstSeenAt) VALUES (?, ?, ?)").bind(deviceId, String(msgId), new Date(nowMs).toISOString()).run();
      } catch {
      }
    }
    console.log(JSON.stringify({
      level: "info",
      msg: "edge sensorlogger ingest",
      requestId,
      sessionId,
      deviceId,
      deviceName,
      points: points.length,
      dropped: { inaccurate: droppedInaccurate, unparsed: droppedUnparsed },
      newSession: isNewSession,
      userId: ingestUserId,
      durationMs: Date.now() - startedAt
    }));
    return jsonResponse(
      {
        ok: true,
        sessionId,
        pointsAccepted: points.length,
        newSession: isNewSession,
        deviceId,
        deviceName,
        status: "recording",
        edge: true
      },
      isNewSession ? 201 : 200,
      requestId
    );
  } catch (err) {
    try {
      const raceBody = await request.clone().json().catch(() => null);
      const url = new URL(request.url);
      const deviceId = url.searchParams.get("deviceId");
      if (raceBody && typeof raceBody.messageId !== "undefined" && deviceId) {
        const seen = await env.DB.prepare("SELECT 1 FROM IngestMessage WHERE deviceId = ? AND messageId = ? LIMIT 1").bind(deviceId, String(raceBody.messageId)).first();
        if (seen) {
          return jsonResponse({ ok: true, duplicate: true, message: "Batch already processed (messageId seen)", deviceId }, 200, requestId);
        }
      }
    } catch {
    }
    console.log(JSON.stringify({ level: "error", msg: "edge sensorlogger error", requestId, error: String(err && err.message || err) }));
    return jsonResponse({ error: "Internal Server Error", requestId }, 500, requestId);
  }
}
__name(handleEdgeSensorLogger, "handleEdgeSensorLogger");

// d1-gateway.js
var JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
var ALLOWED_TABLES = new Set(
  [
    "User",
    "Session",
    "Trip",
    "GpsPoint",
    "Route",
    "RouteCache",
    "TrafficJob",
    "AuditLog",
    "ExportJob",
    "BackupJob",
    "Setting",
    "IngestMessage",
    "_AlertState",
    // v2.39.1 (§A1): дневные агрегаты — /query читает/пишет её ПОСЛЕ деплоя
    // v2.39.0-приложения; /ingest-порт пишет независимо от вайтлиста
    // (стейтменты фиксированы), строка нужна для /query и create-index.
    "StatsRollup",
    // v2.42.0 («Вариант 1»): расчётные снапшоты финальных записей (>24 ч) —
    // рендер-трек/события + метрики; читают/пишут батч-роуты рендера,
    // warm/бэкфилл и retention-purge (DELETE). До СВОЕГО деплоя все SQL к
    // ней = 403 — приложение консервативно живёт на пути v2.41.0.
    "TripCalc",
    // v2.42.1-fix (27.09.2026): служебная таблица блокировок экспорта —
    // worker-runtime.ts pollExportJobs()/reclaimStuckExportJobs() (F9, v2.38.1).
    // Была пропущена в вайтлисте с самого появления: каждый worker-tick ловил
    // 403 «forbidden table: _exportjoblock» («export poll failed» в логах),
    // ExportJob застревал в pending навсегда, экспорт больших сессий зависал.
    "_ExportJobLock"
  ].map((t) => t.toLowerCase())
);
var PRAGMA_RE = /^PRAGMA\s+(page_count|page_size)\s*$/i;
var CREATE_ALERTSTATE_RE = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?_AlertState"?\s*\(/i;
var CREATE_STATSROLLUP_RE = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?StatsRollup"?\s*\(/i;
var CREATE_TRIPCALC_RE = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?TripCalc"?\s*\(/i;
var CREATE_EXPORTLOCK_RE = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?_ExportJobLock"?\s*\(/i;
var CREATE_INDEX_RE = /^CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+"?([A-Za-z0-9_]+)"?\s+ON\s+"?([A-Za-z0-9_]+)"?\s*\(/i;
var MAX_BODY_BYTES_DEFAULT = 2 * 1024 * 1024;
var RATE_LIMIT_WINDOW_MS = 6e4;
var RATE_LIMIT_MAX_DEFAULT = 3e3;
var RATE_BUCKETS_MAX = 1e4;
var KVCACHE_MAX_BODY_BYTES = 64 * 1024;
var KVCACHE_KEY_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
var KVCACHE_VALUE_MAX_CHARS = 512 * 1024;
var KVCACHE_TTL_MIN_SEC = 1;
var KVCACHE_TTL_MAX_SEC = 3600;
var KV_PLATFORM_MIN_TTL_SEC = 60;
var KVCACHE_INVALIDATE_MAX_PAGES = 100;
var KVCACHE_PARAMS_MAX = 100;
async function secretEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
__name(secretEquals, "secretEquals");
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
__name(json, "json");
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}
__name(stripSqlComments, "stripSqlComments");
var TABLE_TOKEN_RE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/gi;
function extractTableNames(sql) {
  const clean = stripSqlComments(sql).replace(/\bDO\s+UPDATE\s+SET\b/gi, " ");
  const names = /* @__PURE__ */ new Set();
  let m;
  while ((m = TABLE_TOKEN_RE.exec(clean)) !== null) {
    names.add((m[1] ?? m[2] ?? m[3] ?? "").toLowerCase());
  }
  return names;
}
__name(extractTableNames, "extractTableNames");
function isReadOnly(env) {
  return env.GATEWAY_READ_ONLY === "true" || env.GATEWAY_READ_ONLY === "1";
}
__name(isReadOnly, "isReadOnly");
function validateStatement(sql, readOnly) {
  const noTrailing = sql.replace(/;\s*$/, "");
  if (noTrailing.includes(";")) return "multiple statements are not allowed";
  const clean = stripSqlComments(noTrailing).trim();
  if (clean.length === 0) return "empty statement";
  const verbMatch = clean.match(/^([A-Za-z]+)/);
  if (!verbMatch) return "unrecognized statement";
  const verb = verbMatch[1].toUpperCase();
  if (readOnly) {
    if (verb === "SELECT") {
      const tables = extractTableNames(clean);
      if (tables.size > 0) {
        for (const t of tables) {
          if (!ALLOWED_TABLES.has(t)) return `forbidden table: ${t}`;
        }
      }
      return null;
    }
    if (verb === "PRAGMA") {
      return PRAGMA_RE.test(clean) ? null : "read-only mode: forbidden operation: PRAGMA";
    }
    return `read-only mode: forbidden operation: ${verb}`;
  }
  if (verb === "SELECT" || verb === "INSERT" || verb === "UPDATE" || verb === "DELETE") {
    const tables = extractTableNames(clean);
    if (tables.size === 0) {
      return verb === "SELECT" ? null : "no table reference";
    }
    for (const t of tables) {
      if (!ALLOWED_TABLES.has(t)) return `forbidden table: ${t}`;
    }
    return null;
  }
  if (verb === "PRAGMA") {
    return PRAGMA_RE.test(clean) ? null : "forbidden operation: PRAGMA";
  }
  if (verb === "CREATE") {
    if (CREATE_ALERTSTATE_RE.test(clean)) return null;
    if (CREATE_STATSROLLUP_RE.test(clean)) return null;
    if (CREATE_TRIPCALC_RE.test(clean)) return null;
    if (CREATE_EXPORTLOCK_RE.test(clean)) return null;
    const idxMatch = clean.match(CREATE_INDEX_RE);
    if (idxMatch && ALLOWED_TABLES.has(idxMatch[3].toLowerCase())) return null;
    return "forbidden operation: CREATE";
  }
  return `forbidden operation: ${verb}`;
}
__name(validateStatement, "validateStatement");
var rateBuckets = /* @__PURE__ */ new Map();
function rateLimitExceeded(ip, limit, windowMs) {
  const now = Date.now();
  let ts = rateBuckets.get(ip);
  if (!ts) {
    if (rateBuckets.size > RATE_BUCKETS_MAX) {
      const oldest = rateBuckets.keys().next().value;
      if (oldest !== void 0) rateBuckets.delete(oldest);
    }
    ts = [];
    rateBuckets.set(ip, ts);
  }
  const fresh = [];
  for (const t of ts) {
    if (t > now - windowMs) fresh.push(t);
  }
  if (fresh.length >= limit) {
    rateBuckets.set(ip, fresh);
    return true;
  }
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  return false;
}
__name(rateLimitExceeded, "rateLimitExceeded");
async function readBodyLimited(request, maxBytes) {
  const reader = request.body && typeof request.body.getReader === "function" ? request.body.getReader() : null;
  if (!reader) return { ok: false, status: 400, error: "empty body" };
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
      }
      return { ok: false, status: 413, error: "payload too large", limitBytes: maxBytes };
    }
    chunks.push(value);
  }
  let byteLen = 0;
  for (const c of chunks) byteLen += c.byteLength;
  const merged = new Uint8Array(byteLen);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}
__name(readBodyLimited, "readBodyLimited");
function bigintSafe(value) {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(bigintSafe);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = bigintSafe(v);
    return out;
  }
  return value;
}
__name(bigintSafe, "bigintSafe");
function normParam(p) {
  if (typeof p === "boolean") return p ? 1 : 0;
  if (typeof p === "bigint") return Number(p);
  return p;
}
__name(normParam, "normParam");
async function handleKvCache(env, body) {
  const { key, sql, params, ttlSec } = body ?? {};
  if (typeof key !== "string" || !KVCACHE_KEY_RE.test(key)) {
    return json({ error: "invalid key (expected ^[A-Za-z0-9_:.-]{1,128}$)" }, 400);
  }
  if (typeof sql !== "string" || sql.length === 0) return json({ error: "sql required" }, 400);
  if (!Array.isArray(params)) return json({ error: "params must be an array" }, 400);
  if (params.length > KVCACHE_PARAMS_MAX) {
    return json({ error: `too many params (max ${KVCACHE_PARAMS_MAX})` }, 400);
  }
  const ttl = Math.floor(Number(ttlSec ?? 30));
  if (!Number.isFinite(ttl) || ttl < KVCACHE_TTL_MIN_SEC || ttl > KVCACHE_TTL_MAX_SEC) {
    return json({ error: `ttlSec out of range (${KVCACHE_TTL_MIN_SEC}..${KVCACHE_TTL_MAX_SEC})` }, 400);
  }
  const violation = validateStatement(sql, true);
  if (violation) return json({ error: "forbidden", reason: violation }, 403);
  if (env.KV && typeof env.KV.get === "function") {
    try {
      const cached = await env.KV.get(key, "text");
      if (cached != null) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed && Array.isArray(parsed.rows)) {
            return json({
              rows: parsed.rows,
              meta: { kv: "hit", rowsRead: 0, durationMs: 0 },
              kv: "hit"
            });
          }
        } catch {
          await env.KV.delete(key).catch(() => {
          });
        }
      }
    } catch {
    }
  }
  let stmt = env.DB.prepare(sql);
  if (params.length > 0) stmt = stmt.bind(...params.map(normParam));
  const res = await stmt.all();
  const rows = bigintSafe(res.results ?? []);
  if (env.KV && typeof env.KV.put === "function") {
    try {
      const text = JSON.stringify({ rows });
      if (text.length <= KVCACHE_VALUE_MAX_CHARS) {
        await env.KV.put(key, text, {
          expirationTtl: Math.max(ttl, KV_PLATFORM_MIN_TTL_SEC)
        });
      }
    } catch {
    }
  }
  return json({
    rows,
    meta: {
      rowsRead: res.meta?.rows_read ?? null,
      rowsWritten: res.meta?.rows_written ?? null,
      durationMs: res.meta?.duration ?? null
    },
    kv: env.KV && typeof env.KV.get === "function" ? "miss" : "passthrough"
  });
}
__name(handleKvCache, "handleKvCache");
async function handleKvStoreGet(env, body) {
  const { key } = body ?? {};
  if (typeof key !== "string" || !KVCACHE_KEY_RE.test(key)) {
    return json({ error: "invalid key" }, 400);
  }
  if (!env.KV || typeof env.KV.get !== "function") {
    return json({ value: null, kv: "disabled" });
  }
  try {
    const value = await env.KV.get(key, "text");
    return json({ value: value == null ? null : value, kv: value == null ? "miss" : "hit" });
  } catch (err) {
    return json({ value: null, kv: "error", error: String(err?.message ?? err) }, 200);
  }
}
__name(handleKvStoreGet, "handleKvStoreGet");
async function handleKvStorePut(env, body) {
  const { key, value, ttlSec } = body ?? {};
  if (typeof key !== "string" || !KVCACHE_KEY_RE.test(key)) {
    return json({ error: "invalid key" }, 400);
  }
  if (typeof value !== "string" || value.length === 0) {
    return json({ error: "value required (string)" }, 400);
  }
  if (value.length > KVCACHE_VALUE_MAX_CHARS) {
    return json({ error: `value too large (max ${KVCACHE_VALUE_MAX_CHARS} chars)`, limitChars: KVCACHE_VALUE_MAX_CHARS }, 413);
  }
  const ttl = Number(ttlSec);
  if (!Number.isFinite(ttl) || ttl < KVCACHE_TTL_MIN_SEC || ttl > KVCACHE_TTL_MAX_SEC) {
    return json({ error: `ttlSec out of range (${KVCACHE_TTL_MIN_SEC}..${KVCACHE_TTL_MAX_SEC})` }, 400);
  }
  if (!env.KV || typeof env.KV.put !== "function") {
    return json({ ok: false, kv: "disabled" });
  }
  try {
    await env.KV.put(key, value, { expirationTtl: Math.max(ttl, KV_PLATFORM_MIN_TTL_SEC) });
    return json({ ok: true, kv: "put" });
  } catch (err) {
    return json({ ok: false, kv: "error", error: String(err?.message ?? err) }, 200);
  }
}
__name(handleKvStorePut, "handleKvStorePut");
var BUDGET_KV_PREFIX = "quota:day:";
var BUDGET_FLUSH_MIN_MS = 6e4;
var BUDGET_DAILY_READ_LIMIT = 5e6;
var globalForBudget = globalThis;
if (!globalForBudget.__d1GatewayBudget) {
  globalForBudget.__d1GatewayBudget = { day: "", read: 0, written: 0, quotaExhaustedAt: null, lastFlushAt: 0, flushInFlight: false };
}
var budgetState = globalForBudget.__d1GatewayBudget;
function budgetDayKey(now = /* @__PURE__ */ new Date()) {
  return now.toISOString().slice(0, 10);
}
__name(budgetDayKey, "budgetDayKey");
function budgetTrack(rowsRead, rowsWritten) {
  const day = budgetDayKey();
  if (budgetState.day !== day) {
    if (budgetState.read > 0 || budgetState.written > 0 || budgetState.quotaExhaustedAt) {
      flushBudgetPending({ forceDay: budgetState.day });
    }
    budgetState.day = day;
    budgetState.read = 0;
    budgetState.written = 0;
    budgetState.quotaExhaustedAt = null;
  }
  const read = Number(rowsRead);
  const written = Number(rowsWritten);
  if (Number.isFinite(read) && read > 0) budgetState.read += read;
  if (Number.isFinite(written) && written > 0) budgetState.written += written;
}
__name(budgetTrack, "budgetTrack");
function budgetMarkExhausted(errMessage) {
  if (/exceeded D1'?s free tier daily row read limit/i.test(String(errMessage))) {
    if (!budgetState.quotaExhaustedAt) {
      budgetState.quotaExhaustedAt = (/* @__PURE__ */ new Date()).toISOString();
      if (budgetState.day === "") budgetState.day = budgetDayKey();
    }
  }
}
__name(budgetMarkExhausted, "budgetMarkExhausted");
async function flushBudgetPending(opts = {}) {
  const state = budgetState;
  if (state.flushInFlight) return;
  const day = opts.forceDay ?? state.day;
  const isCurrent = day === state.day;
  const payload = isCurrent ? { read: state.read, written: state.written, quotaExhaustedAt: state.quotaExhaustedAt } : opts.pending ?? { read: 0, written: 0, quotaExhaustedAt: null };
  if (payload.read <= 0 && payload.written <= 0 && !payload.quotaExhaustedAt) return;
  if (isCurrent && Date.now() - state.lastFlushAt < BUDGET_FLUSH_MIN_MS && !opts.force) return;
  const kv = globalEnvKV();
  if (!kv) return;
  state.flushInFlight = true;
  try {
    const key = BUDGET_KV_PREFIX + day;
    let base = { rowsRead: 0, rowsWritten: 0, quotaExhaustedAt: null };
    try {
      const raw = await kv.get(key, "text");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Number.isFinite(Number(parsed?.rowsRead))) base.rowsRead = Number(parsed.rowsRead);
        if (Number.isFinite(Number(parsed?.rowsWritten))) base.rowsWritten = Number(parsed.rowsWritten);
        if (typeof parsed?.quotaExhaustedAt === "string") base.quotaExhaustedAt = parsed.quotaExhaustedAt;
      }
    } catch {
    }
    const record = {
      day,
      rowsRead: base.rowsRead + payload.read,
      rowsWritten: base.rowsWritten + payload.written,
      quotaExhaustedAt: payload.quotaExhaustedAt ?? base.quotaExhaustedAt,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await kv.put(key, JSON.stringify(record), { expirationTtl: 2 * 24 * 60 * 60 });
    if (isCurrent && state.day === day) {
      state.read = 0;
      state.written = 0;
      state.lastFlushAt = Date.now();
    }
  } catch {
  } finally {
    state.flushInFlight = false;
  }
}
__name(flushBudgetPending, "flushBudgetPending");
var __envKV = null;
function globalEnvKV() {
  return __envKV && typeof __envKV.get === "function" ? __envKV : null;
}
__name(globalEnvKV, "globalEnvKV");
async function budgetSnapshot(env) {
  const day = budgetDayKey();
  let record = { day, rowsRead: 0, rowsWritten: 0, quotaExhaustedAt: null, updatedAt: null };
  try {
    if (env.KV && typeof env.KV.get === "function") {
      const raw = await env.KV.get(BUDGET_KV_PREFIX + day, "text");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Number.isFinite(Number(parsed?.rowsRead))) record.rowsRead = Number(parsed.rowsRead);
        if (Number.isFinite(Number(parsed?.rowsWritten))) record.rowsWritten = Number(parsed.rowsWritten);
        if (typeof parsed?.quotaExhaustedAt === "string") record.quotaExhaustedAt = parsed.quotaExhaustedAt;
        if (typeof parsed?.updatedAt === "string") record.updatedAt = parsed.updatedAt;
      }
    }
  } catch {
  }
  if (budgetState.day === day) {
    record.rowsRead += budgetState.read;
    record.rowsWritten += budgetState.written;
    record.quotaExhaustedAt = record.quotaExhaustedAt ?? budgetState.quotaExhaustedAt;
  }
  record.quota = BUDGET_DAILY_READ_LIMIT;
  return record;
}
__name(budgetSnapshot, "budgetSnapshot");
async function handleKvInvalidate(env, body) {
  const { prefix } = body ?? {};
  if (typeof prefix !== "string" || !KVCACHE_KEY_RE.test(prefix)) {
    return json({ error: "invalid prefix" }, 400);
  }
  if (!env.KV || typeof env.KV.list !== "function") {
    return json({ invalidated: 0, kv: "disabled" });
  }
  let invalidated = 0;
  let cursor;
  try {
    for (let page = 0; page < KVCACHE_INVALIDATE_MAX_PAGES; page++) {
      const list = await env.KV.list({ prefix, cursor });
      const keys = Array.isArray(list?.keys) ? list.keys : [];
      if (keys.length === 0) break;
      const settled = await Promise.allSettled(
        keys.map((k) => env.KV.delete(k.name))
      );
      invalidated += settled.filter((s) => s.status === "fulfilled").length;
      if (list?.list_complete || !list?.cursor) break;
      cursor = list.cursor;
    }
  } catch {
  }
  return json({ invalidated });
}
__name(handleKvInvalidate, "handleKvInvalidate");
function normalizeCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return String(expr);
  const dowMap = { SUN: "0", MON: "1", TUE: "2", WED: "3", THU: "4", FRI: "5", SAT: "6" };
  const fixed = parts.map((p) => p === "*/1" ? "*" : p);
  const dow = dowMap[String(fixed[4]).toUpperCase()] ?? fixed[4];
  return [fixed[0], fixed[1], fixed[2], fixed[3], dow].join(" ");
}
__name(normalizeCron, "normalizeCron");
var CRON_SCHEDULES = {
  "*/1 * * * *": ["tick"],
  "*/5 * * * *": ["finalize-sessions", "alerts", "turso-migrate"],
  "0 3 * * *": ["retention"],
  "30 3 * * *": ["backup"],
  "0 4 * * SUN": ["backup-github"]
};
var CRON_SCHEDULES_BY_NORM = new Map(
  Object.entries(CRON_SCHEDULES).map(([expr, jobs]) => [normalizeCron(expr), jobs])
);
var CRON_APP_PATHS = {
  tick: "/api/worker/tick",
  "finalize-sessions": "/api/cron/finalize-sessions",
  alerts: "/api/cron/alerts",
  retention: "/api/cron/retention",
  backup: "/api/admin/backup",
  "backup-github": "/api/admin/backup/github"
};
var CRON_ALL_JOBS = [
  ...Object.keys(CRON_APP_PATHS),
  "turso-migrate"
];
var CRON_LAST_PREFIX = "cron:last:";
var CRON_BACKUP_TIMEOUT_MS = 14 * 6e4;
var LONG_CRON_JOBS = /* @__PURE__ */ new Set(["backup", "backup-github"]);
var CRON_LAST_WRITE_MIN_MS = {
  tick: 4.5 * 6e4,
  // ~каждый 5-й тик при стабильном ok
  "finalize-sessions": 24 * 6e4,
  // ~каждый 5-й прогон */5
  alerts: 24 * 6e4,
  "turso-migrate": 24 * 6e4
  // retention / backup / backup-github — суточные, всегда пишутся (0)
};
var TURSO_STATE_BLOCKED_SAVE_MIN_MS = 15 * 6e4;
async function putCronLastThrottled(env, job, record) {
  if (!env.KV || typeof env.KV.put !== "function") return;
  try {
    const intervalMs = CRON_LAST_WRITE_MIN_MS[job] ?? 0;
    if (intervalMs > 0) {
      const raw = await env.KV.get(TURSO_CRON_LAST_KEY(job)).catch(() => null);
      if (raw) {
        try {
          const prev = JSON.parse(raw);
          const prevAt = Date.parse(prev && prev.at);
          if (Number.isFinite(prevAt) && prev.ok === record.ok && Date.now() - prevAt < intervalMs) {
            return;
          }
        } catch {
        }
      }
    }
    await env.KV.put(TURSO_CRON_LAST_KEY(job), JSON.stringify(record));
  } catch {
  }
}
__name(putCronLastThrottled, "putCronLastThrottled");
async function callAppCron(env, path, timeoutMs = 6e4) {
  if (!env.APP_ORIGIN) return { ok: false, error: "APP_ORIGIN not configured" };
  if (!env.CRON_SECRET) return { ok: false, error: "CRON_SECRET not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(env.APP_ORIGIN + path, {
      method: "POST",
      headers: { authorization: "Bearer " + env.CRON_SECRET, "content-type": "application/json" },
      body: "{}",
      signal: controller.signal
    });
    const bodyText = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: bodyText.slice(0, 2e3) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}
__name(callAppCron, "callAppCron");
var TURSO_STATE_KEY = "turso_delta:v1";
var TURSO_SPLIT_ISO = "2026-09-17T21:00:00.000Z";
var TURSO_SPLIT_MS = Date.parse(TURSO_SPLIT_ISO);
var TURSO_GPS_PAGE = 1500;
var TURSO_SMALL_LIMIT = 5e3;
var TURSO_PHASES = [
  { table: "User", mode: "compare", where: null },
  { table: "Setting", mode: "compare", where: null },
  { table: "Session", mode: "compare", where: "updatedAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "Trip", mode: "compare", where: "updatedAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "TrafficJob", mode: "compare", where: "updatedAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "Route", mode: "ignore", where: "createdAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "IngestMessage", mode: "ignore", where: "firstSeenAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "AuditLog", mode: "ignore", where: "createdAt > ?", args: [TURSO_SPLIT_ISO] },
  { table: "GpsPoint", mode: "ignore-keyset", where: null }
];
function newTursoState() {
  return {
    status: "pending",
    phase: 0,
    lastTs: TURSO_SPLIT_MS,
    lastId: "",
    stats: {},
    blockedCount: 0,
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    lastAttemptAt: null,
    lastError: null
  };
}
__name(newTursoState, "newTursoState");
async function loadTursoState(env) {
  if (!env.KV) return { ...newTursoState(), status: "no-kv" };
  try {
    const raw = await env.KV.get(TURSO_STATE_KEY);
    if (!raw) return newTursoState();
    const s = JSON.parse(raw);
    if (s && typeof s === "object" && typeof s.phase === "number" && s.stats && typeof s.stats === "object") {
      return { ...newTursoState(), ...s };
    }
  } catch {
  }
  return newTursoState();
}
__name(loadTursoState, "loadTursoState");
async function saveTursoState(env, state) {
  if (!env.KV) return;
  try {
    if (state && state.status === "blocked" && Date.now() - lastTursoBlockedSaveAt < TURSO_STATE_BLOCKED_SAVE_MIN_MS) {
      return;
    }
    await env.KV.put(TURSO_STATE_KEY, JSON.stringify(state));
    lastTursoBlockedSaveAt = Date.now();
  } catch {
  }
}
__name(saveTursoState, "saveTursoState");
var lastTursoBlockedSaveAt = 0;
function tursoValueToJs(v) {
  if (v == null) return null;
  if (typeof v !== "object") return v;
  const t = String(v.type || "");
  const val = v.value;
  if (t === "integer" || t === "float") return val == null ? null : Number(val);
  if (t === "text") return val == null ? null : String(val);
  if (t === "blob") {
    if (typeof val !== "string" || val === "") return null;
    try {
      const bin = atob(val);
      return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    } catch {
      return null;
    }
  }
  return val ?? null;
}
__name(tursoValueToJs, "tursoValueToJs");
async function tursoExecute(env, sql, args = []) {
  const url = env.TURSO_URL || "";
  const token = env.TURSO_AUTH_TOKEN || "";
  if (!url || !token) return { ok: false, code: "CONFIG", error: "TURSO_URL/TURSO_AUTH_TOKEN not configured" };
  try {
    const res = await fetch(String(url).replace(/\/+$/, "") + "/v2/pipeline", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql, args } }] })
    });
    if (!res.ok) return { ok: false, code: "HTTP_" + res.status, error: "turso http " + res.status };
    const data = await res.json();
    const first = data && data.results && data.results[0];
    if (!first) return { ok: false, code: "EMPTY", error: "turso: empty pipeline response" };
    if (first.type === "error") {
      const e = first.error || {};
      return { ok: false, code: String(e.code || "ERROR"), error: String(e.message || "turso error") };
    }
    const result = first.response && first.response.result || {};
    const cols = (result.cols || []).map((c) => c.name);
    const rows = (result.rows || []).map((raw) => {
      const row = {};
      cols.forEach((c, i) => {
        row[c] = tursoValueToJs(raw[i]);
      });
      return row;
    });
    return { ok: true, rows, cols };
  } catch (err) {
    return { ok: false, code: "NETWORK", error: String(err && err.message || err) };
  }
}
__name(tursoExecute, "tursoExecute");
function d1BindValue(v) {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Uint8Array) return v.buffer && v.byteLength ? v : null;
  return String(v);
}
__name(d1BindValue, "d1BindValue");
var SAFE_IDENT_RE = /^[A-Za-z0-9_]+$/;
function d1InsertChunks(table, rows, mode) {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]).filter((c) => SAFE_IDENT_RE.test(c));
  if (!cols.length) return [];
  const rowsPerStmt = Math.max(1, Math.floor(90 / cols.length));
  const action = mode === "replace" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
  const colList = cols.map((c) => '"' + c + '"').join(",");
  const out = [];
  for (let i = 0; i < rows.length; i += rowsPerStmt) {
    const slice = rows.slice(i, i + rowsPerStmt);
    const placeholders = slice.map(() => "(" + cols.map(() => "?").join(",") + ")").join(",");
    const params = [];
    for (const r of slice) {
      for (const c of cols) params.push(d1BindValue(r[c]));
    }
    out.push({ sql: action + ' INTO "' + table + '" (' + colList + ") VALUES " + placeholders, params });
  }
  return out;
}
__name(d1InsertChunks, "d1InsertChunks");
async function d1RunInserts(env, table, rows, mode) {
  const chunks = d1InsertChunks(table, rows, mode);
  let written = 0;
  for (let i = 0; i < chunks.length; i += 100) {
    const batch = chunks.slice(i, i + 100).map((s) => {
      const st = env.DB.prepare(s.sql);
      return s.params.length ? st.bind(...s.params) : st;
    });
    const results = await env.DB.batch(batch);
    for (const r of results) written += Number(r.meta && r.meta.changes || 0);
  }
  return written;
}
__name(d1RunInserts, "d1RunInserts");
function bumpTableStat(state, table, key, n) {
  if (!state.stats[table]) state.stats[table] = { scanned: 0, written: 0 };
  state.stats[table][key] = (state.stats[table][key] || 0) + n;
}
__name(bumpTableStat, "bumpTableStat");
async function migrateCompareTable(env, phase, state) {
  const sql = phase.where ? 'SELECT * FROM "' + phase.table + '" WHERE ' + phase.where : 'SELECT * FROM "' + phase.table + '"';
  const t = await tursoExecute(env, sql, phase.args || []);
  if (!t.ok) return t;
  const rows = t.rows.slice(0, TURSO_SMALL_LIMIT);
  const idCol = phase.table === "Setting" ? "key" : "id";
  const d1map = /* @__PURE__ */ new Map();
  for (let i = 0; i < rows.length; i += 400) {
    const slice = rows.slice(i, i + 400).map((r) => String(r[idCol]));
    if (!slice.length) continue;
    const st = env.DB.prepare(
      'SELECT "' + idCol + '" AS k, "updatedAt" AS u FROM "' + phase.table + '" WHERE "' + idCol + '" IN (' + slice.map(() => "?").join(",") + ")"
    ).bind(...slice);
    const res = await st.all();
    for (const r of res.results || []) d1map.set(String(r.k), r.u == null ? null : String(r.u));
  }
  const fresh = rows.filter((r) => {
    const id = String(r[idCol]);
    if (!d1map.has(id)) return true;
    const d1u = d1map.get(id) || "";
    const tu = r.updatedAt == null ? "" : String(r.updatedAt);
    return tu > d1u;
  });
  const written = await d1RunInserts(env, phase.table, fresh, "replace");
  bumpTableStat(state, phase.table, "scanned", rows.length);
  bumpTableStat(state, phase.table, "written", written);
  return { ok: true, phaseDone: true, scanned: rows.length, written };
}
__name(migrateCompareTable, "migrateCompareTable");
async function migrateIgnoreTable(env, phase, state) {
  const t = await tursoExecute(env, 'SELECT * FROM "' + phase.table + '" WHERE ' + phase.where, phase.args || []);
  if (!t.ok) return t;
  const rows = t.rows.slice(0, TURSO_SMALL_LIMIT);
  const written = await d1RunInserts(env, phase.table, rows, "ignore");
  bumpTableStat(state, phase.table, "scanned", rows.length);
  bumpTableStat(state, phase.table, "written", written);
  return { ok: true, phaseDone: true, scanned: rows.length, written };
}
__name(migrateIgnoreTable, "migrateIgnoreTable");
async function migrateGpsPointsStep(env, state) {
  const lastTs = typeof state.lastTs === "number" && Number.isFinite(state.lastTs) ? state.lastTs : TURSO_SPLIT_MS;
  const lastId = typeof state.lastId === "string" ? state.lastId : "";
  const t = await tursoExecute(
    env,
    "SELECT * FROM GpsPoint WHERE timestamp > ? OR (timestamp = ? AND id > ?) ORDER BY timestamp, id LIMIT " + TURSO_GPS_PAGE,
    [lastTs, lastTs, lastId]
  );
  if (!t.ok) return t;
  const rows = t.rows;
  const written = rows.length ? await d1RunInserts(env, "GpsPoint", rows, "ignore") : 0;
  bumpTableStat(state, "GpsPoint", "scanned", rows.length);
  bumpTableStat(state, "GpsPoint", "written", written);
  if (rows.length < TURSO_GPS_PAGE) {
    return { ok: true, phaseDone: true, scanned: rows.length, written };
  }
  const last = rows[rows.length - 1];
  state.lastTs = Number(last.timestamp) || lastTs;
  state.lastId = String(last.id || "");
  return { ok: true, phaseDone: false, scanned: rows.length, written };
}
__name(migrateGpsPointsStep, "migrateGpsPointsStep");
async function runTursoMigrationStep(env, maxSteps = 1) {
  const state = await loadTursoState(env);
  if (state.status === "done") return { state, alreadyDone: true };
  state.attempts = (state.attempts || 0) + 1;
  state.lastAttemptAt = (/* @__PURE__ */ new Date()).toISOString();
  const probe = await tursoExecute(env, "SELECT 1 AS ok");
  if (!probe.ok) {
    if (probe.code === "BLOCKED") {
      state.status = "blocked";
      state.blockedCount = (state.blockedCount || 0) + 1;
      state.lastError = "turso read quota still blocked (probe)";
    } else {
      state.status = "error";
      state.lastError = probe.error;
    }
    await saveTursoState(env, state);
    return { state, probe: probe.code };
  }
  if (!state.startedAt) state.startedAt = (/* @__PURE__ */ new Date()).toISOString();
  state.status = "running";
  state.lastError = null;
  let steps = 0;
  let last = null;
  while (steps < maxSteps && state.phase < TURSO_PHASES.length) {
    const phase = TURSO_PHASES[state.phase];
    if (phase.mode === "ignore-keyset") last = await migrateGpsPointsStep(env, state);
    else if (phase.mode === "compare") last = await migrateCompareTable(env, phase, state);
    else last = await migrateIgnoreTable(env, phase, state);
    if (!last.ok) {
      state.status = "error";
      state.lastError = last.error || "unknown migration step error";
      break;
    }
    steps++;
    if (last.phaseDone) state.phase++;
  }
  if (state.phase >= TURSO_PHASES.length && state.status !== "error") {
    state.status = "done";
    state.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  await saveTursoState(env, state);
  return { state, steps, last };
}
__name(runTursoMigrationStep, "runTursoMigrationStep");
async function readCronStatus(env) {
  const cron = {};
  for (const job of CRON_ALL_JOBS) {
    const raw = env.KV ? await env.KV.get(TURSO_CRON_LAST_KEY(job)) : null;
    try {
      cron[job] = raw ? JSON.parse(raw) : null;
    } catch {
      cron[job] = null;
    }
  }
  return cron;
}
__name(readCronStatus, "readCronStatus");
function TURSO_CRON_LAST_KEY(job) {
  return CRON_LAST_PREFIX + job;
}
__name(TURSO_CRON_LAST_KEY, "TURSO_CRON_LAST_KEY");
var FM_ENABLED = true;
function fmNextDayKey(key) {
  return new Date(Date.parse(key + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);
}
__name(fmNextDayKey, "fmNextDayKey");
function fmParseStatsCache(s) {
  const t = { distanceM: 0, durationSec: 0, ecoSum: 0, ecoCount: 0 };
  if (typeof s != "string" || s.length === 0 || s === "__TELEMAT_CACHE_OVERSIZED__") return t;
  try {
    const n = JSON.parse(s);
    if (n?.kind !== "full" || !n.payload) return t;
    const a = Number(n.payload.distance);
    if (Number.isFinite(a) && a > 0) t.distanceM += a;
    const d = Number(n.payload.duration);
    if (Number.isFinite(d) && d > 0) t.durationSec += d;
    const e = n.payload?.methodology?.ecoScore?.value;
    if (e != null && Number.isFinite(Number(e))) {
      t.ecoSum += Number(e);
      t.ecoCount += 1;
    }
  } catch {
  }
  return t;
}
__name(fmParseStatsCache, "fmParseStatsCache");
function fmRollupUpserts(rows, nowIso) {
  return rows.map((r) => ({
    sql: `INSERT INTO StatsRollup (day, userId, sessions, points, distanceM, durationSec, ecoSum, ecoCount, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(day, userId) DO UPDATE SET
  sessions = excluded.sessions,
  points = excluded.points,
  distanceM = excluded.distanceM,
  durationSec = excluded.durationSec,
  ecoSum = excluded.ecoSum,
  ecoCount = excluded.ecoCount,
  updatedAt = excluded.updatedAt`,
    args: [r.day, r.userId, r.sessions, r.points, Math.round(r.distanceM), Math.round(r.durationSec), Math.round(1e3 * r.ecoSum) / 1e3, r.ecoCount, nowIso]
  }));
}
__name(fmRollupUpserts, "fmRollupUpserts");
async function fmSessionsInRange(env, fromMs, toMs) {
  const res = await env.DB.prepare("SELECT startTime, userId, pointCount, statsCache FROM Session WHERE deletedAt IS NULL AND startTime >= ? AND startTime < ?").bind(new Date(fromMs).toISOString(), new Date(toMs).toISOString()).all();
  return res.results ?? [];
}
__name(fmSessionsInRange, "fmSessionsInRange");
function fmComputeDays(rows, dayFrom, dayTo, zone) {
  const agg = /* @__PURE__ */ new Map();
  for (const s of rows) {
    const ts = Date.parse(String(s.startTime));
    if (!Number.isFinite(ts)) continue;
    const day = rollupDayKey(ts, zone);
    if (day < dayFrom || day > dayTo) continue;
    const uid = s.userId == null ? "" : String(s.userId);
    const k = day + "|" + uid;
    let d = agg.get(k);
    if (!d) {
      d = { day, userId: uid, sessions: 0, points: 0, distanceM: 0, durationSec: 0, ecoSum: 0, ecoCount: 0 };
      agg.set(k, d);
    }
    d.sessions += 1;
    d.points += Number(s.pointCount ?? 0);
    const sc = fmParseStatsCache(s.statsCache);
    d.distanceM += sc.distanceM;
    d.durationSec += sc.durationSec;
    d.ecoSum += sc.ecoSum;
    d.ecoCount += sc.ecoCount;
  }
  return [...agg.values()];
}
__name(fmComputeDays, "fmComputeDays");
async function fmWriteDayRows(env, rows) {
  if (rows.length === 0) return 0;
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  const stmts = fmRollupUpserts(rows, nowIso);
  for (let i = 0; i < stmts.length; i += 100) {
    const chunk = stmts.slice(i, i + 100).map((s) => env.DB.prepare(s.sql).bind(...s.args));
    await env.DB.batch(chunk);
  }
  return rows.length;
}
__name(fmWriteDayRows, "fmWriteDayRows");
async function fmBackfillOnce(env, zone, yesterdayKey) {
  const kv = env.KV;
  if (!kv) return;
  const marker = await kv.get("fm:backfill:v1").catch(() => null);
  if (marker) return;
  const res = await env.DB.prepare("SELECT startTime, userId, pointCount, statsCache FROM Session WHERE deletedAt IS NULL").all();
  const rows = fmComputeDays(res.results ?? [], "0000-00-00", "9999-12-31", zone);
  const written = await fmWriteDayRows(env, rows);
  const keep = rows.map((r) => r.day + "|" + r.userId);
  if (keep.length > 0) {
    const ph = keep.map(() => "?").join(", ");
    await env.DB.prepare(`DELETE FROM StatsRollup WHERE (day || '|' || userId) NOT IN (${ph})`).bind(...keep).run();
  } else {
    await env.DB.prepare("DELETE FROM StatsRollup").run();
  }
  await kv.put("fm:backfill:v1", JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), days: rows.length, written }));
  await kv.put("fm:frozenThru", yesterdayKey);
  console.log(JSON.stringify({ level: "info", msg: "fm backfill-once complete (history frozen)", days: rows.length, written, frozenThru: yesterdayKey }));
}
__name(fmBackfillOnce, "fmBackfillOnce");
async function fmEngineTick(env) {
  if (!FM_ENABLED || !env.DB) return { ok: false, reason: "disabled" };
  const zone = env.TELEMAT_TIMEZONE || "UTC";
  const now = Date.now();
  const todayKey = rollupDayKey(now, zone);
  const yesterdayKey = rollupDayKey(now - 864e5, zone);
  const kv = env.KV;
  const out = { todayRows: 0, froze: 0, refresh7d: false, tsw: null, backupReaped: 0 };
  try {
    await fmBackfillOnce(env, zone, yesterdayKey);
  } catch (e) {
    console.log(JSON.stringify({ level: "warn", msg: "fm backfill step failed", error: String(e && e.message || e) }));
  }
  try {
    const fromMs = Date.parse(todayKey + "T00:00:00Z") - 648e5;
    const toMs = Date.parse(fmNextDayKey(todayKey) + "T00:00:00Z") + 648e5;
    const rows = fmComputeDays(await fmSessionsInRange(env, fromMs, toMs), todayKey, todayKey, zone);
    out.todayRows = await fmWriteDayRows(env, rows);
  } catch (e) {
    console.log(JSON.stringify({ level: "warn", msg: "fm today step failed", error: String(e && e.message || e) }));
  }
  if (kv) {
    let frozenThru = null;
    try {
      frozenThru = await kv.get("fm:frozenThru").catch(() => null);
      if (typeof frozenThru !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(frozenThru)) frozenThru = null;
    } catch {
    }
    try {
      if (frozenThru == null) {
        await kv.put("fm:frozenThru", yesterdayKey);
      } else if (frozenThru < yesterdayKey) {
        const from = fmNextDayKey(frozenThru);
        const fromMs = Math.max(Date.parse(from + "T00:00:00Z") - 648e5, 1262304e6);
        const toMs = Date.parse(fmNextDayKey(yesterdayKey) + "T00:00:00Z") + 648e5;
        const rows = fmComputeDays(await fmSessionsInRange(env, fromMs, toMs), from, yesterdayKey, zone);
        await fmWriteDayRows(env, rows);
        await kv.put("fm:frozenThru", yesterdayKey);
        out.froze = rows.length;
        console.log(JSON.stringify({ level: "info", msg: "fm day-flip freeze", from, thru: yesterdayKey, rows: rows.length }));
      }
    } catch (e) {
      console.log(JSON.stringify({ level: "warn", msg: "fm freeze step failed", error: String(e && e.message || e) }));
    }
    try {
      const last7 = await kv.get("fm:refresh7d:at").catch(() => null);
      if (!last7 || now - Date.parse(last7) > 36e5) {
        const fromKey = rollupDayKey(now - 7 * 864e5, zone);
        const fromMs = Date.parse(fromKey + "T00:00:00Z") - 648e5;
        const rows = fmComputeDays(await fmSessionsInRange(env, fromMs, now + 648e5), fromKey, todayKey, zone);
        await fmWriteDayRows(env, rows);
        await kv.put("fm:refresh7d:at", new Date(now).toISOString());
        out.refresh7d = true;
      }
    } catch (e) {
      console.log(JSON.stringify({ level: "warn", msg: "fm refresh7d step failed", error: String(e && e.message || e) }));
    }
  }
  if (new Date(now).getUTCMinutes() % 5 === 0) {
    try {
      const bj = await env.DB.prepare("UPDATE BackupJob SET status = 'failed', error = 'fm: reclaimed stuck running > 2h (worker CPU limit)', completedAt = ? WHERE status = 'running' AND createdAt < ?").bind(new Date(now).toISOString(), new Date(now - 72e5).toISOString()).run();
      out.backupReaped = Number(bj.meta?.changes ?? 0);
    } catch {
    }
    try {
      const t = await env.DB.prepare("SELECT id, userId FROM Trip WHERE deletedAt IS NULL AND statsComputedAt IS NULL AND status = 'completed' AND spanEnd < ? ORDER BY spanStart ASC LIMIT 3").bind(new Date(now - 216e5).toISOString()).all();
      for (const tr of t.results ?? []) {
        const id = String(tr.id);
        const key = "fm:tsw:" + id;
        const last = kv ? await kv.get(key).catch(() => null) : null;
        if (last) continue;
        if (kv) await kv.put(key, new Date(now).toISOString(), { expirationTtl: 21600 });
        const uid = tr.userId == null ? null : String(tr.userId);
        let apiKey = null;
        if (uid) {
          const u = await env.DB.prepare("SELECT apiKey FROM User WHERE id = ?").bind(uid).first().catch(() => null);
          apiKey = u && u.apiKey ? String(u.apiKey) : null;
        }
        if (apiKey && env.APP_ORIGIN) {
          const ctrl = new AbortController();
          const tm = setTimeout(() => ctrl.abort(), 3e4);
          try {
            const r = await fetch(env.APP_ORIGIN + "/api/trips/batch?ids=" + encodeURIComponent(id), { headers: { authorization: "Bearer " + apiKey }, signal: ctrl.signal });
            out.tsw = { tripId: id, status: r.status };
          } catch (e) {
            out.tsw = { tripId: id, error: String(e && e.message || e) };
          } finally {
            clearTimeout(tm);
          }
        }
        break;
      }
    } catch {
    }
  }
  return out;
}
__name(fmEngineTick, "fmEngineTick");
function fmScopeClause(sql) {
  if (/AND\s+userId\s+IS\s+NULL/i.test(sql)) return { clause: " WHERE userId = ''", param: null };
  if (/AND\s+userId\s*=\s*\?/i.test(sql)) return { clause: " WHERE userId = ?", param: 0 };
  return { clause: "", param: null };
}
__name(fmScopeClause, "fmScopeClause");
async function fmInterceptQuery(env, sql, params) {
  if (!FM_ENABLED || typeof sql !== "string") return null;
  try {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^SELECT startTime, userId, pointCount(, statsCache)? FROM Session WHERE deletedAt IS NULL AND startTime >= \? AND startTime < \?/i.test(s) && typeof params[0] === "string" && params[0] < "2001-01-01") {
      return json({ rows: [], rowsAffected: 0, meta: { rowsRead: 0, rowsWritten: 0, durationMs: 0, fm: "heal-neutralized" } });
    }
    if (/^SELECT COUNT\(\*\) AS c, MAX\(updatedAt\) AS m FROM Session WHERE deletedAt IS NULL( AND userId = \?| AND userId IS NULL)?$/i.test(s)) {
      const scope = fmScopeClause(s);
      const stmt = env.DB.prepare("SELECT COALESCE(SUM(sessions), 0) AS c, MAX(updatedAt) AS m FROM StatsRollup" + scope.clause);
      const res = await (scope.param === 0 ? stmt.bind(params[0]) : stmt).all();
      budgetTrack(res.meta?.rows_read ?? 0, res.meta?.rows_written ?? 0);
      const r = (res.results ?? [])[0] ?? {};
      return json({ rows: [{ c: Number(r.c ?? 0), m: r.m ?? null }], rowsAffected: 0, meta: { rowsRead: res.meta?.rows_read ?? 0, rowsWritten: 0, durationMs: res.meta?.duration ?? 0, fm: "rollup-scope-counters" } });
    }
    if (/^SELECT COUNT\(\*\) as count FROM Session WHERE deletedAt IS NULL( AND userId = \?| AND userId IS NULL)?$/i.test(s)) {
      const scope = fmScopeClause(s);
      const stmt = env.DB.prepare("SELECT COALESCE(SUM(sessions), 0) AS count FROM StatsRollup" + scope.clause);
      const res = await (scope.param === 0 ? stmt.bind(params[0]) : stmt).all();
      budgetTrack(res.meta?.rows_read ?? 0, res.meta?.rows_written ?? 0);
      const r = (res.results ?? [])[0] ?? {};
      return json({ rows: [{ count: Number(r.count ?? 0) }], rowsAffected: 0, meta: { rowsRead: res.meta?.rows_read ?? 0, rowsWritten: 0, durationMs: res.meta?.duration ?? 0, fm: "rollup-total-sessions" } });
    }
    if (/^SELECT COUNT\(\*\) AS c FROM GpsPoint WHERE sessionId IN \(SELECT id FROM Session WHERE deletedAt IS NULL( AND userId = \?| AND userId IS NULL)?\)$/i.test(s)) {
      const scope = fmScopeClause(s);
      const stmt = env.DB.prepare("SELECT COALESCE(SUM(points), 0) AS c FROM StatsRollup" + scope.clause);
      const res = await (scope.param === 0 ? stmt.bind(params[0]) : stmt).all();
      budgetTrack(res.meta?.rows_read ?? 0, res.meta?.rows_written ?? 0);
      const r = (res.results ?? [])[0] ?? {};
      return json({ rows: [{ c: Number(r.c ?? 0) }], rowsAffected: 0, meta: { rowsRead: res.meta?.rows_read ?? 0, rowsWritten: 0, durationMs: res.meta?.duration ?? 0, fm: "rollup-total-points" } });
    }
  } catch (e) {
    console.log(JSON.stringify({ level: "warn", msg: "fm intercept failed (fallthrough)", error: String(e && e.message || e) }));
  }
  return null;
}
__name(fmInterceptQuery, "fmInterceptQuery");

var worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    __envKV = env.KV ?? null;
    if (url.pathname === "/health") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      return json({ ok: true, gateway: "d1", db: env.DB ? "bound" : "missing-binding", version: "2.42.1" });
    }
    if (url.pathname === "/ingest" || url.pathname === "/api/ingest") {
      return await handleEdgeIngest(request, env);
    }
    if (url.pathname === "/api/ingest/sensorlogger") {
      return await handleEdgeSensorLogger(request, env);
    }
    if (url.pathname === "/admin/turso-migrate/status" || url.pathname === "/admin/cron-status") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      if (!env.GATEWAY_SECRET || !await secretEquals(request.headers.get("x-gateway-secret") ?? "", env.GATEWAY_SECRET)) {
        return json({ error: "unauthorized" }, 401);
      }
      const turso = await loadTursoState(env);
      const cron = await readCronStatus(env);
      const budget = await budgetSnapshot(env);
      return json({ turso, cron, budget, schedules: CRON_SCHEDULES, appPaths: CRON_APP_PATHS });
    }
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const secret = request.headers.get("x-gateway-secret") ?? "";
    if (!env.GATEWAY_SECRET || !await secretEquals(secret, env.GATEWAY_SECRET)) {
      return json({ error: "unauthorized" }, 401);
    }
    const maxBody = Number(env.GATEWAY_MAX_BODY_BYTES) > 0 ? Number(env.GATEWAY_MAX_BODY_BYTES) : MAX_BODY_BYTES_DEFAULT;
    const bodyLimit = url.pathname === "/kvcache" || url.pathname === "/kvcache/invalidate" || url.pathname === "/kvstore/get" || url.pathname === "/kvstore/put" ? Math.min(maxBody, KVCACHE_MAX_BODY_BYTES) : maxBody;
    const cl = Number(request.headers.get("content-length") || "0");
    if (cl > bodyLimit) {
      return json({ error: "payload too large", limitBytes: bodyLimit }, 413);
    }
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const rlMax = Number(env.GATEWAY_RATE_LIMIT_MAX) > 0 ? Number(env.GATEWAY_RATE_LIMIT_MAX) : RATE_LIMIT_MAX_DEFAULT;
    if (rateLimitExceeded(ip, rlMax, RATE_LIMIT_WINDOW_MS)) {
      return json({ error: "rate limit exceeded", retryAfterSec: 60, limit: rlMax }, 429);
    }
    const bodyRes = await readBodyLimited(request, bodyLimit);
    if (!bodyRes.ok) {
      return json({ error: bodyRes.error, limitBytes: bodyRes.limitBytes }, bodyRes.status);
    }
    let body;
    try {
      body = JSON.parse(bodyRes.text);
    } catch {
      return json({ error: "invalid json body" }, 400);
    }
    try {
      if (url.pathname === "/query") {
        const { sql, params } = body ?? {};
        if (typeof sql !== "string" || sql.length === 0) return json({ error: "sql required" }, 400);
        const violation = validateStatement(sql, isReadOnly(env));
        if (violation) return json({ error: "forbidden", reason: violation }, 403);
        const fmRes = await fmInterceptQuery(env, sql, Array.isArray(params) ? params : []);
        if (fmRes) return fmRes;
        let stmt = env.DB.prepare(sql);
        if (Array.isArray(params) && params.length > 0) stmt = stmt.bind(...params.map(normParam));
        const res = await stmt.all();
        budgetTrack(res.meta?.rows_read ?? 0, res.meta?.rows_written ?? 0);
        if (ctx && ctx.waitUntil) ctx.waitUntil(flushBudgetPending({}));
        return json({
          rows: bigintSafe(res.results ?? []),
          rowsAffected: res.meta?.changes ?? 0,
          meta: {
            rowsRead: res.meta?.rows_read ?? null,
            rowsWritten: res.meta?.rows_written ?? null,
            durationMs: res.meta?.duration ?? null
          }
        });
      }
      if (url.pathname === "/kvcache") {
        return await handleKvCache(env, body);
      }
      if (url.pathname === "/kvcache/invalidate") {
        return await handleKvInvalidate(env, body);
      }
      if (url.pathname === "/kvstore/get") {
        return await handleKvStoreGet(env, body);
      }
      if (url.pathname === "/kvstore/put") {
        return await handleKvStorePut(env, body);
      }
      if (url.pathname === "/admin/turso-migrate") {
        if (body && body.reset === true) {
          const state = newTursoState();
          await saveTursoState(env, state);
          return json({ state, reset: true });
        }
        const steps = Math.min(Math.max(Number(body && body.steps || 1) || 1, 1), 40);
        const result = await runTursoMigrationStep(env, steps);
        return json(result);
      }
      if (url.pathname === "/batch") {
        const { statements } = body ?? {};
        if (!Array.isArray(statements) || statements.length === 0) {
          return json({ error: "statements required" }, 400);
        }
        if (statements.length > 500) {
          return json({ error: "too many statements (max 500 per batch)" }, 400);
        }
        const batchReadOnly = isReadOnly(env);
        for (const s of statements) {
          if (typeof s?.sql !== "string" || s.sql.length === 0) {
            return json({ error: "each statement requires non-empty sql" }, 400);
          }
          const violation = validateStatement(s.sql, batchReadOnly);
          if (violation) {
            return json({ error: "forbidden", reason: violation }, 403);
          }
        }
        const stmts = statements.map((s) => {
          let st = env.DB.prepare(s.sql);
          if (Array.isArray(s.params) && s.params.length > 0) {
            st = st.bind(...s.params.map(normParam));
          }
          return st;
        });
        const results = await env.DB.batch(stmts);
        for (const r of results) {
          budgetTrack(r.meta?.rows_read ?? 0, r.meta?.rows_written ?? 0);
        }
        if (ctx && ctx.waitUntil) ctx.waitUntil(flushBudgetPending({}));
        return json(results.map((r) => ({
          rows: bigintSafe(r.results ?? []),
          rowsAffected: r.meta?.changes ?? 0,
          meta: {
            rowsRead: r.meta?.rows_read ?? null,
            rowsWritten: r.meta?.rows_written ?? null,
            durationMs: r.meta?.duration ?? null
          }
        })));
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      budgetMarkExhausted(String(err?.message ?? err));
      if (ctx && ctx.waitUntil) ctx.waitUntil(flushBudgetPending({ force: true }));
      return json({ error: String(err?.message ?? err), d1: true }, 500);
    }
  },
  // v2.40.0 (§B5): Cron Triggers — планировщик бывших cron-сервисов Render.
  // Каждый тик: разбор расписания → вызов исполнителей приложения (или
  // внутренний шаг мигратора Turso) → запись cron:last:<job> в KV
  // (наблюдаемость через GET /admin/cron-status) + структурный лог.
  async scheduled(controller, env, ctx) {
    __envKV = env.KV ?? null;
    const budgetFlush = flushBudgetPending({ force: true }).catch(() => {
    });
    const jobs = CRON_SCHEDULES_BY_NORM.get(normalizeCron(controller.cron)) ?? [];
    if (jobs.includes("tick")) {
      try {
        const fmOut = await fmEngineTick(env);
        console.log(JSON.stringify({ level: "info", msg: "fm engine tick", today: fmOut.todayRows, froze: fmOut.froze, refresh7d: fmOut.refresh7d, tsw: fmOut.tsw, backupReaped: fmOut.backupReaped }));
      } catch (e) {
        console.log(JSON.stringify({ level: "warn", msg: "fm engine tick failed", error: String(e && e.message || e) }));
      }
    }
    const run = (async () => {
      const results = {};
      for (const job of jobs) {
        try {
          if (job === "turso-migrate") {
            const r = await runTursoMigrationStep(env, 1);
            results[job] = {
              ok: r.state.status !== "error",
              state: {
                status: r.state.status,
                phase: r.state.phase,
                stats: r.state.stats,
                blockedCount: r.state.blockedCount,
                lastError: r.state.lastError
              }
            };
            if (env.KV) {
              await putCronLastThrottled(env, job, {
                at: (/* @__PURE__ */ new Date()).toISOString(),
                ok: results[job].ok,
                state: results[job].state
              });
            }
          } else {
            const path = CRON_APP_PATHS[job];
            const timeout = LONG_CRON_JOBS.has(job) ? CRON_BACKUP_TIMEOUT_MS : 6e4;
            const r = await callAppCron(env, path, timeout);
            results[job] = r;
            if (env.KV) {
              await putCronLastThrottled(env, job, {
                at: (/* @__PURE__ */ new Date()).toISOString(),
                ok: r.ok,
                status: r.status ?? null,
                error: r.error ?? null
              });
            }
          }
        } catch (err) {
          results[job] = { ok: false, error: String(err && err.message || err) };
        }
      }
      console.log(JSON.stringify({ level: "info", msg: "d1-gateway cron run", cron: controller.cron, jobs, results }));
    })();
    ctx.waitUntil(Promise.allSettled([run, budgetFlush]));
  }
};
var d1_gateway_default = worker;
export {
  d1_gateway_default as default
};
//# sourceMappingURL=d1-gateway.js.map

