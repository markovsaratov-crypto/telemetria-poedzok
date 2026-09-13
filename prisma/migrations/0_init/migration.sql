-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "apiKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "userId" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "clientId" TEXT,
    "deviceName" TEXT,
    "startTime" DATETIME NOT NULL,
    "endTime" DATETIME,
    "pointCount" INTEGER NOT NULL DEFAULT 0,
    "payloadBytes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "deletedAt" DATETIME,
    "purgedAt" DATETIME,
    "routeId" TEXT,
    "routeHash" TEXT,
    "topologyHash" TEXT,
    "trafficJobId" TEXT,
    "tripId" TEXT,
    "notes" TEXT,
    "tags" TEXT,
    "statsCache" TEXT,
    "eventsCache" TEXT,
    "trackCache" TEXT,
    "cachePointCount" INTEGER,
    "cacheVersion" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Session_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recording',
    "startTime" DATETIME NOT NULL,
    "endTime" DATETIME,
    "spanStart" DATETIME NOT NULL,
    "spanEnd" DATETIME,
    "startLat" REAL,
    "startLon" REAL,
    "endLat" REAL,
    "endLon" REAL,
    "sessionIds" TEXT NOT NULL DEFAULT '[]',
    "sessionCount" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" DATETIME,
    "trafficJobId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "activeDurationSec" REAL,
    "movingTimeSec" REAL,
    "idleTimeSec" REAL,
    "gapTimeSec" REAL,
    "interFragmentGapSec" REAL,
    "internalStopTimeSec" REAL,
    "distanceM" REAL,
    "pointCountActual" INTEGER,
    "maxSpeedMs" REAL,
    "ecoScore" REAL,
    "planDistanceM" REAL,
    "planDurationSec" REAL,
    "planComparable" BOOLEAN,
    "planCoverage" REAL,
    "routingLegCount" INTEGER,
    "statsComputedAt" DATETIME
);

-- CreateTable
CREATE TABLE "GpsPoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "lat" REAL NOT NULL,
    "lon" REAL NOT NULL,
    "speed" REAL,
    "altitude" REAL,
    "accuracy" REAL,
    "timestamp" BIGINT NOT NULL,
    "bearing" REAL,
    CONSTRAINT "GpsPoint_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Route" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "startLat" REAL NOT NULL,
    "startLon" REAL NOT NULL,
    "endLat" REAL NOT NULL,
    "endLon" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Route_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RouteCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hash" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "todBucket" INTEGER NOT NULL,
    "routeId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RouteCache_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrafficJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT,
    "tripId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "scheduledFor" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockedAt" DATETIME,
    "result" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TrafficJob_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "metadata" TEXT,
    "sessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fileUrl" TEXT,
    "fileSize" INTEGER,
    "expiresAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "error" TEXT,
    CONSTRAINT "ExportJob_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BackupJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "type" TEXT NOT NULL DEFAULT 'full',
    "filePath" TEXT,
    "fileSize" INTEGER,
    "checksum" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "error" TEXT
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT
);

-- CreateTable
CREATE TABLE "IngestMessage" (
    "deviceId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("deviceId", "messageId")
);

-- CreateTable
CREATE TABLE "_SessionTrips" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_SessionTrips_A_fkey" FOREIGN KEY ("A") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_SessionTrips_B_fkey" FOREIGN KEY ("B") REFERENCES "Trip" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_apiKey_key" ON "User"("apiKey");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "Session_status_endTime_idx" ON "Session"("status", "endTime");

-- CreateIndex
CREATE INDEX "Session_routeId_idx" ON "Session"("routeId");

-- CreateIndex
CREATE INDEX "Session_routeHash_idx" ON "Session"("routeHash");

-- CreateIndex
CREATE INDEX "Session_topologyHash_idx" ON "Session"("topologyHash");

-- CreateIndex
CREATE INDEX "Session_deletedAt_idx" ON "Session"("deletedAt");

-- CreateIndex
CREATE INDEX "Session_startTime_idx" ON "Session"("startTime");

-- CreateIndex
CREATE INDEX "Session_tripId_idx" ON "Session"("tripId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_deviceId_clientId_key" ON "Session"("deviceId", "clientId");

-- CreateIndex
CREATE INDEX "Trip_deviceId_spanStart_idx" ON "Trip"("deviceId", "spanStart");

-- CreateIndex
CREATE INDEX "Trip_userId_spanStart_idx" ON "Trip"("userId", "spanStart");

-- CreateIndex
CREATE INDEX "Trip_status_spanEnd_idx" ON "Trip"("status", "spanEnd");

-- CreateIndex
CREATE INDEX "Trip_deletedAt_idx" ON "Trip"("deletedAt");

-- CreateIndex
CREATE INDEX "GpsPoint_sessionId_idx" ON "GpsPoint"("sessionId");

-- CreateIndex
CREATE INDEX "GpsPoint_sessionId_timestamp_idx" ON "GpsPoint"("sessionId", "timestamp");

-- CreateIndex
CREATE INDEX "Route_userId_idx" ON "Route"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RouteCache_hash_key" ON "RouteCache"("hash");

-- CreateIndex
CREATE INDEX "RouteCache_todBucket_expiresAt_idx" ON "RouteCache"("todBucket", "expiresAt");

-- CreateIndex
CREATE INDEX "RouteCache_routeId_idx" ON "RouteCache"("routeId");

-- CreateIndex
CREATE INDEX "TrafficJob_status_scheduledFor_priority_idx" ON "TrafficJob"("status", "scheduledFor", "priority");

-- CreateIndex
CREATE INDEX "TrafficJob_sessionId_idx" ON "TrafficJob"("sessionId");

-- CreateIndex
CREATE INDEX "TrafficJob_tripId_idx" ON "TrafficJob"("tripId");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetId_targetType_idx" ON "AuditLog"("targetId", "targetType");

-- CreateIndex
CREATE INDEX "AuditLog_actorType_actorId_idx" ON "AuditLog"("actorType", "actorId");

-- CreateIndex
CREATE INDEX "AuditLog_sessionId_idx" ON "AuditLog"("sessionId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "ExportJob_status_createdAt_idx" ON "ExportJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ExportJob_sessionId_idx" ON "ExportJob"("sessionId");

-- CreateIndex
CREATE INDEX "BackupJob_status_createdAt_idx" ON "BackupJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "IngestMessage_firstSeenAt_idx" ON "IngestMessage"("firstSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "_SessionTrips_AB_unique" ON "_SessionTrips"("A", "B");

-- CreateIndex
CREATE INDEX "_SessionTrips_B_index" ON "_SessionTrips"("B");

