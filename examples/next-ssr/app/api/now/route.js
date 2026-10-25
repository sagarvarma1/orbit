export const dynamic = "force-dynamic";

export function GET(request) {
  return Response.json({ now: new Date().toISOString(), path: new URL(request.url).pathname });
}
