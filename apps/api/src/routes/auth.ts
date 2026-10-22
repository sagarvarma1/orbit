import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { HttpError, NotFoundError } from "../lib/errors.js";
import { type PublicUser, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, UnauthorizedError } from "../services/auth.js";

declare module "fastify" {
  interface FastifyRequest {
    user: PublicUser | null;
  }
}

/** Reachable without signing in. Everything else under /api requires a session or API token. */
const PUBLIC_ROUTES = new Set([
  "GET /api/health",
  "GET /api/auth/status",
  "POST /api/auth/setup",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  // HMAC-verified instead.
  "POST /api/webhooks/github",
  // Caddy's on-demand TLS check; only answers yes/no for a hostname.
  "GET /api/tls/allowed",
]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function sessionCookie(ctx: AppContext, value: string, maxAge: number): string {
  const secure = ctx.config.dashboardUrl.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/**
 * Cookie-authenticated writes must come from the dashboard itself. SameSite=Lax doesn't cover
 * this alone: deployments live on sibling subdomains, which count as the same site.
 */
function sameOriginRequest(req: FastifyRequest, dashboardOrigin: string): boolean {
  const source = req.headers.origin ?? req.headers.referer;
  if (!source) return false;
  let origin: URL;
  try {
    origin = new URL(source);
  } catch {
    return false;
  }
  if (origin.origin === dashboardOrigin) return true;
  return origin.host === req.headers.host;
}

const credentials = z.object({ email: z.string().min(1).max(200), password: z.string().min(1).max(200) });

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  const dashboardOrigin = new URL(ctx.config.dashboardUrl).origin;
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (req) => {
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/api/") || req.method === "OPTIONS") return;
    const auth = req.headers.authorization;
    const result = ctx.auth.authenticate(
      readCookie(req.headers.cookie, SESSION_COOKIE),
      auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined,
    );
    req.user = result?.user ?? null;
    if (PUBLIC_ROUTES.has(`${req.method} ${path}`)) return;
    if (!result) throw new UnauthorizedError();
    if (result.via === "session" && !SAFE_METHODS.has(req.method) && !sameOriginRequest(req, dashboardOrigin)) {
      throw new HttpError(403, "Cross-origin request blocked");
    }
  });

  const startSession = (reply: FastifyReply, session: string) =>
    reply.header("set-cookie", sessionCookie(ctx, session, SESSION_MAX_AGE_SECONDS));

  app.get("/api/auth/status", async (req) => ({ setupRequired: ctx.auth.setupRequired, user: req.user }));

  app.post("/api/auth/setup", async (req, reply) => {
    const input = credentials.extend({ code: z.string().min(1).max(50) }).parse(req.body);
    const { user, session } = await ctx.auth.setup(input.code, input.email, input.password);
    startSession(reply, session);
    return { user };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const input = credentials.parse(req.body);
    const { user, session } = await ctx.auth.login(input.email, input.password, req.ip);
    startSession(reply, session);
    return { user };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const session = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (session) ctx.auth.logout(session);
    reply.header("set-cookie", sessionCookie(ctx, "", 0));
    return { ok: true };
  });

  app.post("/api/auth/password", async (req, reply) => {
    const input = z.object({ current: z.string().min(1), next: z.string().min(1).max(200) }).parse(req.body);
    startSession(reply, await ctx.auth.changePassword(req.user!.id, input.current, input.next));
    return { ok: true };
  });

  // -------------------------------------------------------------- API tokens

  app.get("/api/tokens", async (req) => ({ tokens: ctx.repo.listApiTokens(req.user!.id) }));

  app.post("/api/tokens", async (req, reply) => {
    const { name } = z.object({ name: z.string().max(100).default("") }).parse(req.body ?? {});
    const { token, apiToken } = ctx.auth.createApiToken(req.user!.id, name);
    reply.code(201);
    // The only time the token itself is ever returned.
    return { token, apiToken };
  });

  app.delete<{ Params: { id: string } }>("/api/tokens/:id", async (req) => {
    if (!ctx.repo.deleteApiToken(req.user!.id, req.params.id)) throw new NotFoundError("Token not found");
    return { ok: true };
  });
}
