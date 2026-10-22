import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { BadRequestError } from "../lib/errors.js";

export function githubRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Connection status for the Settings page. */
  app.get("/api/github", async () => {
    const creds = ctx.githubApp.credentials;
    let installations: Awaited<ReturnType<typeof ctx.githubApp.installations>> = [];
    let error: string | null = null;
    if (creds) {
      try {
        installations = await ctx.githubApp.installations();
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
    if (ctx.githubApp.configured) throw new BadRequestError("A GitHub App is already connected. Disconnect it first.");
    return ctx.githubApp.createManifest(org);
  });

  /** GitHub redirected back with a one-time code: trade it for the app's credentials. */
  app.post("/api/github/manifest/complete", async (req) => {
    const { code, state } = z.object({ code: z.string().min(1).max(200), state: z.string().min(1).max(200) }).parse(req.body);
    const creds = await ctx.githubApp.completeManifest(code, state);
    return { app: { name: creds.name, slug: creds.slug, htmlUrl: creds.htmlUrl }, installUrl: ctx.githubApp.installUrl(creds) };
  });

  app.get("/api/github/repositories", async () => {
    if (!ctx.githubApp.configured) return { repositories: [] };
    return { repositories: await ctx.githubApp.repositories() };
  });

  /** Forget the app's credentials. The app itself stays on GitHub until deleted there. */
  app.delete("/api/github", async () => {
    ctx.githubApp.disconnect();
    return { ok: true };
  });
}
