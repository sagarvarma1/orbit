import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { PRESETS, findWorkspaceRoot, normalizeRelative, readSnapshot, resolveBuildSettings } from "../build/detect.js";
import { lsRemote, parseRepoUrl, shallowCheckout } from "../build/git.js";
import { BadRequestError } from "../lib/errors.js";
import { slugify } from "../lib/ids.js";

const inspectInput = z.object({
  repoUrl: z.string().min(1),
  branch: z.string().optional(),
  rootDirectory: z.string().optional(),
});

/** Peek at a repo before importing: branches + detected framework and build settings. */
export function inspectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/inspect", async (req) => {
    const input = inspectInput.parse(req.body);
    const repoRef = parseRepoUrl(input.repoUrl, ctx.config.allowLocalRepos);
    await ctx.access.assertCanImport(req.user!, repoRef.url);
    const token = await ctx.githubApp.tokenFor(repoRef.url);
    const remote = await lsRemote(repoRef.url, token).catch(() => {
      throw new BadRequestError(
        "Could not reach that repository. Check the URL; if it's private, install the Orbit GitHub App on it (Settings → GitHub).",
      );
    });
    const branch = input.branch || remote.defaultBranch;
    if (!remote.branches.some((b) => b.name === branch)) throw new BadRequestError(`Branch "${branch}" does not exist`);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-inspect-"));
    try {
      const commit = await shallowCheckout(repoRef.url, branch, dir, undefined, token);
      const rootDirectory = normalizeRelative(input.rootDirectory || ".");
      const projectDir = path.join(dir, rootDirectory);
      if (!fs.existsSync(projectDir)) throw new BadRequestError(`Root directory "${rootDirectory}" not found`);
      const settings = resolveBuildSettings(readSnapshot(projectDir), {}, findWorkspaceRoot(dir, rootDirectory));
      const hasFunctions = fs.existsSync(path.join(projectDir, "api"));
      return {
        repoUrl: repoRef.url,
        fullName: repoRef.fullName,
        suggestedName: slugify(path.basename(repoRef.url).replace(/\.git$/, "")),
        defaultBranch: remote.defaultBranch,
        branches: remote.branches
          .map((b) => b.name)
          .sort((a, b) => (a === remote.defaultBranch ? -1 : b === remote.defaultBranch ? 1 : a.localeCompare(b))),
        branch,
        rootDirectory,
        commit,
        settings,
        hasFunctions,
        presets: Object.values(PRESETS),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
