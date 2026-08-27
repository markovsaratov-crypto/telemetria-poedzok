// GET /api/keepalive — simple endpoint for keep-alive pings
export async function GET() {
  return new Response(JSON.stringify({ ok: true, timestamp: Date.now() }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
