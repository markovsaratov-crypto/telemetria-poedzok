// AUDIT B-13: корень /api раньше отдавал «Hello, world!» без авторизации —
// отладочный остаток. Теперь 404: API не имеет индексной страницы.
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ error: "Not Found" }, { status: 404 });
}

export async function POST() {
  return NextResponse.json({ error: "Not Found" }, { status: 404 });
}
