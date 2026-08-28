// POST /api/admin/backup/github — create GitHub release backup (dynamic import to prevent build errors).
// GET /api/admin/backup/github — list GitHub release backups.
import { NextRequest } from "next/server";
import { authorizeRequest, getUserIdFromRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const userId = await getUserIdFromRequest(request);
    const actorId = userId ?? (auth.via === "cookie" ? "owner" : "admin-token");

    // Dynamic import prevents fs/path from being statically analyzed at build time.
    const { backupToGitHub } = await import("@/lib/github-backup");
    const result = await backupToGitHub(actorId);
    return json(result, 201, { "X-Request-Id": requestId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("GitHub backup create error", { requestId, error: msg });
    return json({ error: "GitHub backup failed", message: msg }, 500, {
      "X-Request-Id": requestId,
    });
  }
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { listGitHubBackups, isGitHubBackupConfigured } = await import("@/lib/github-backup");
    if (!isGitHubBackupConfigured()) {
      return json(
        { configured: false, backups: [], message: "GITHUB_TOKEN not configured" },
        200,
        { "X-Request-Id": requestId }
      );
    }
    const backups = await listGitHubBackups();
    return json({ configured: true, backups }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("GitHub backup list error", { requestId, error: msg });
    return json({ error: "GitHub backup list failed", message: msg }, 500, {
      "X-Request-Id": requestId,
    });
  }
}
