// A serverless function: served by Orbit at /api/hello in an isolated process.
export default async function handler(request) {
  const url = new URL(request.url);
  return Response.json({
    message: `Hello, ${url.searchParams.get("name") ?? "world"}!`,
    environment: process.env.ORBIT_ENV ?? "unknown",
    secretConfigured: Boolean(process.env.API_SECRET),
    time: new Date().toISOString(),
  });
}
