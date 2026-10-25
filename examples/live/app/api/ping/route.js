import { countRequest } from "../../lib/state";

export const dynamic = "force-dynamic";

export function GET() {
  const { request, bootedAt } = countRequest();
  return Response.json(
    { request, serverTime: Date.now(), uptimeMs: Date.now() - bootedAt, pid: process.pid },
    { headers: { "cache-control": "no-store" } },
  );
}
