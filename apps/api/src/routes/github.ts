import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { apiPublicUrl } from "../config.js";
import type { AppContext } from "../context.js";
import { BadRequestError } from "../lib/errors.js";
import { ForbiddenError } from "../services/auth.js";

/** Creating or removing the instance's GitHub App is for the admin only. */
function requireAdmin(req: FastifyRequest): void {
  if (req.user?.role !== "admin") throw new ForbiddenError("Only the Orbit admin can change the GitHub App");
}

export function githubRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Connection status for the Settings page: the app, and the installations this user can use. */
  app.get("/api/github", async (req) => {
    const creds = ctx.githubApp.credentials;
    let installations: Awaited<ReturnType<typeof ctx.githubApp.installations>> = [];
    let error: string | null = null;
    if (creds) {
      try {
        installations = await ctx.access.installations(req.user!);
      } catch (err) {
        error = (err as Error).message;
      }
    }
    return {
      app: creds
        ? {
            name: creds.name,
            slug: creds.slug,
            owner: creds.owner,
            htmlUrl: creds.htmlUrl,
            installUrl: ctx.githubApp.installUrl(creds),
          }
        : null,
      installations,
      error,
      personalAccessToken: Boolean(ctx.config.githubToken),
      canManage: req.user!.role === "admin",
      signInCallbackUrl: `${apiPublicUrl(ctx.config)}/api/auth/github/callback`,
    };
  });

  /** Starts GitHub's manifest flow; the dashboard auto-submits the returned form to GitHub. */
  app.post("/api/github/manifest", async (req) => {
    const { org } = z
      .object({
        org: z
          .string()
          .regex(/^[A-Za-z0-9-]{1,39}$/, "Invalid organization name")
          .optional(),
      })
      .parse(req.body ?? {});
    requireAdmin(req);
    if (ctx.githubApp.configured) throw new BadRequestError("A GitHub App is already connected. Disconnect it first.");
    return ctx.githubApp.createManifest(org, {
      public: ctx.config.signups,
      callbackUrl: `${apiPublicUrl(ctx.config)}/api/auth/github/callback`,
    });
  });

  /** GitHub redirected back with a one-time code: trade it for the app's credentials. */
  app.post("/api/github/manifest/complete", async (req) => {
    const { code, state } = z.object({ code: z.string().min(1).max(200), state: z.string().min(1).max(200) }).parse(req.body);
    requireAdmin(req);
    const creds = await ctx.githubApp.completeManifest(code, state);
    return { app: { name: creds.name, slug: creds.slug, htmlUrl: creds.htmlUrl }, installUrl: ctx.githubApp.installUrl(creds) };
  });

  app.get("/api/github/repositories", async (req) => {
    if (!ctx.githubApp.configured) return { repositories: [] };
    return { repositories: await ctx.access.repositories(req.user!) };
  });

  /** Forget the app's credentials. The app itself stays on GitHub until deleted there. */
  app.delete("/api/github", async (req) => {
    requireAdmin(req);
    ctx.githubApp.disconnect();
    return { ok: true };
  });
}
