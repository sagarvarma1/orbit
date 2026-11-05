import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import { ZodError } from "zod";
import type { AppContext } from "./context.js";
import { PRESETS } from "./build/detect.js";
import { HttpError } from "./lib/errors.js";
import { Access } from "./services/access.js";
import { deploymentRoutes } from "./routes/deployments.js";
import { domainRoutes } from "./routes/domains.js";
import { githubRoutes } from "./routes/github.js";
import { inspectRoutes } from "./routes/inspect.js";
import { authRoutes } from "./routes/auth.js";
import { cronRoutes } from "./routes/crons.js";
import { blobApiRoutes } from "./routes/blob-api.js";
import { blobStoreRoutes } from "./routes/blob-stores.js";
import { BlobService } from "./services/blob.js";
import { projectRoutes } from "./routes/projects.js";
import { webhookRoutes } from "./routes/webhooks.js";

export async function buildApp(
  base: Omit<AppContext, "access" | "blob"> & { access?: Access; blob?: BlobService },
): Promise<FastifyInstance> {
  const ctx: AppContext = {
    ...base,
    access: base.access ?? new Access(base.repo, base.githubApp, base.config),
    blob: base.blob ?? new BlobService(base.repo, base.config),
  };
  const pretty = process.env.NODE_ENV !== "production";
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Human-readable logs in dev; JSON lines in production.
      ...(pretty
        ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } } }
        : {}),
    },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: ctx.config.trustProxy,
  });
  // Only the dashboard may call the API from a browser on another origin (in development the
  // dashboard runs on :3000 and the API on :4000). In production both share one origin.
  const dashboardOrigin = new URL(ctx.config.dashboardUrl).origin;
  // Blob is token-authenticated and called from any origin (browser uploads), like Vercel's API.
  await app.register(cors, {
    delegator: (req, cb) => {
      if (req.url?.startsWith("/blob/")) {
        return cb(null, { origin: "*", methods: ["GET", "HEAD", "PUT", "POST"], allowedHeaders: "*", maxAge: 86400 });
      }
      cb(null, {
        origin: req.headers.origin === dashboardOrigin,
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      });
    },
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      return reply.code(400).send({ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request" });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: "Internal server error" });
  });

  authRoutes(app, ctx);
  app.get("/api/health", async () => ({ ok: true }));

  /** Everything the dashboard needs to render URLs and status. */
  app.get("/api/config", async () => ({
    rootDomain: ctx.config.rootDomain,
    protocol: ctx.config.publicProtocol,
    edgePort: ctx.config.publicEdgePort,
    builder: ctx.deployments.builderDescription,
    queue: ctx.deployments.queue.stats(),
    webhookConfigured: Boolean(ctx.config.githubWebhookSecret) || ctx.githubApp.configured,
    githubConfigured: Boolean(ctx.config.githubToken) || ctx.githubApp.configured,
    githubApp: ctx.githubApp.configured,
    buildCache: ctx.config.buildCache,
    gitPollIntervalSeconds: ctx.config.gitPollIntervalSeconds,
    blobApiUrl: ctx.blob.apiUrl,
    presets: Object.values(PRESETS),
  }));

  projectRoutes(app, ctx);
  deploymentRoutes(app, ctx);
  inspectRoutes(app, ctx);
  webhookRoutes(app, ctx);
  domainRoutes(app, ctx);
  githubRoutes(app, ctx);
  cronRoutes(app, ctx);
  blobStoreRoutes(app, ctx);
  blobApiRoutes(app, ctx, ctx.blob);
  return app;
}
