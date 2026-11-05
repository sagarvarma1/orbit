import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppContext, requireProject } from "../context.js";
import { type BlobStore, blobToken } from "../db/repo.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import type { PublicUser } from "../services/auth.js";

const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyz0123456789";
const random = (length: number, alphabet = ALPHANUMERIC) =>
  Array.from(randomBytes(length), (b) => alphabet[b % alphabet.length]).join("");

const nameInput = z.string().trim().min(1).max(64);
const connectionInput = z.object({
  targets: z
    .array(z.enum(["production", "preview"]))
    .min(1)
    .default(["production", "preview"]),
  /** Vercel's "Environment variables prefix": BLOB gives BLOB_READ_WRITE_TOKEN. */
  envPrefix: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,31}$/, "Use uppercase letters, digits and underscores")
    .default("BLOB"),
});

/**
 * Managing Blob stores from the dashboard, like Vercel's Storage tab: create a store, connect it
 * to projects (which then get <prefix>_READ_WRITE_TOKEN), browse and delete. Reading and writing
 * files goes through the store's own API with its token.
 */
export function blobStoreRoutes(app: FastifyInstance, ctx: AppContext): void {
  function requireStore(id: string, user: PublicUser | null): BlobStore {
    const store = ctx.repo.getBlobStore(id);
    if (!store || !user || (user.role !== "admin" && store.ownerId !== user.id)) {
      throw new NotFoundError(`Blob store "${id}" not found`);
    }
    return store;
  }

  function serialize(store: BlobStore, withToken = false) {
    return {
      id: store.id,
      name: store.name,
      createdAt: store.createdAt,
      baseUrl: `${ctx.blob.origin}/${store.id}`,
      usage: ctx.repo.blobUsage(store.id),
      connections: ctx.repo.listBlobConnections({ storeId: store.id }).flatMap((c) => {
        const project = ctx.repo.getProject(c.projectId);
        return project ? [{ project: project.name, targets: c.targets, envPrefix: c.envPrefix, createdAt: c.createdAt }] : [];
      }),
      ...(withToken ? { token: blobToken(store), apiUrl: ctx.blob.apiUrl } : {}),
    };
  }

  app.get("/api/blob-stores", async (req) => ({
    stores: ctx.repo.listBlobStores(req.user!.role === "admin" ? undefined : req.user!.id).map((s) => serialize(s)),
    apiUrl: ctx.blob.apiUrl,
  }));

  app.post("/api/blob-stores", async (req, reply) => {
    const { name } = z.object({ name: nameInput }).parse(req.body);
    const store: BlobStore = {
      id: random(16),
      ownerId: req.user!.id,
      name,
      secret: random(32, ALPHANUMERIC + ALPHANUMERIC.toUpperCase()),
      createdAt: Date.now(),
    };
    ctx.repo.insertBlobStore(store);
    reply.code(201);
    return { store: serialize(store, true) };
  });

  app.get<{ Params: { id: string } }>("/api/blob-stores/:id", async (req) => ({
    store: serialize(requireStore(req.params.id, req.user), true),
  }));

  app.patch<{ Params: { id: string } }>("/api/blob-stores/:id", async (req) => {
    const store = requireStore(req.params.id, req.user);
    const { name } = z.object({ name: nameInput }).parse(req.body);
    ctx.repo.updateBlobStore(store.id, { name });
    return { store: serialize(requireStore(store.id, req.user), true) };
  });

  /** A new read-write token; connected projects pick it up on their next deployment. */
  app.post<{ Params: { id: string } }>("/api/blob-stores/:id/rotate-token", async (req) => {
    const store = requireStore(req.params.id, req.user);
    ctx.repo.updateBlobStore(store.id, { secret: random(32, ALPHANUMERIC + ALPHANUMERIC.toUpperCase()) });
    return { store: serialize(requireStore(store.id, req.user), true) };
  });

  app.delete<{ Params: { id: string } }>("/api/blob-stores/:id", async (req) => {
    const store = requireStore(req.params.id, req.user);
    ctx.repo.deleteBlobStore(store.id);
    ctx.blob.removeStoreFiles(store.id);
    return { ok: true };
  });

  app.put<{ Params: { id: string; project: string } }>("/api/blob-stores/:id/connections/:project", async (req) => {
    const store = requireStore(req.params.id, req.user);
    const project = requireProject(ctx, req.params.project, req.user);
    const input = connectionInput.parse(req.body ?? {});
    const clash = ctx.repo
      .listBlobConnections({ projectId: project.id })
      .find((c) => c.storeId !== store.id && c.envPrefix === input.envPrefix);
    if (clash) {
      throw new ConflictError(
        `${project.name} already has a store connected as ${input.envPrefix}_READ_WRITE_TOKEN; choose another prefix`,
      );
    }
    ctx.repo.upsertBlobConnection({ storeId: store.id, projectId: project.id, ...input });
    return { store: serialize(store, true) };
  });

  app.delete<{ Params: { id: string; project: string } }>("/api/blob-stores/:id/connections/:project", async (req) => {
    const store = requireStore(req.params.id, req.user);
    const project = requireProject(ctx, req.params.project, req.user);
    ctx.repo.deleteBlobConnection(store.id, project.id);
    return { store: serialize(store, true) };
  });

  /** The stores connected to a project (its Storage tab). */
  app.get<{ Params: { id: string } }>("/api/projects/:id/blob-stores", async (req) => {
    const project = requireProject(ctx, req.params.id, req.user);
    return {
      connections: ctx.repo.listBlobConnections({ projectId: project.id }).flatMap((c) => {
        const store = ctx.repo.getBlobStore(c.storeId);
        return store
          ? [
              {
                store: { id: store.id, name: store.name, usage: ctx.repo.blobUsage(store.id) },
                targets: c.targets,
                envPrefix: c.envPrefix,
              },
            ]
          : [];
      }),
    };
  });
}
