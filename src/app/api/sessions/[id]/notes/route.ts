// PATCH /api/sessions/[id]/notes — обновить заметки и теги сессии.
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";

const zNotesBody = z.object({
  notes: z.string().max(2000).optional(),
  tags: z.string().max(500).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { id } = await params;
    const body = await request.json().catch(() => null);
    const parsed = zNotesBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }

    const session = await db.session.findUnique({ where: { id }, select: { id: true, deletedAt: true, notes: true, tags: true } });
    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    const updateData: Record<string, unknown> = {};
    if (parsed.data.notes !== undefined) updateData.notes = parsed.data.notes || null;
    if (parsed.data.tags !== undefined) updateData.tags = parsed.data.tags || null;

    if (Object.keys(updateData).length === 0) {
      return json({ notes: session.notes, tags: session.tags }, 200, { "X-Request-Id": requestId });
    }

    const updated = await db.session.update({
      where: { id },
      data: updateData,
      select: { notes: true, tags: true },
    });

    await writeAudit({
      action: "session.notes",
      targetId: id,
      targetType: "Session",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: auth.via === "cookie" ? "owner" : "api",
      sessionId: id,
      metadata: { notes: !!parsed.data.notes, tags: parsed.data.tags },
    });

    return json(updated, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Session notes update error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
