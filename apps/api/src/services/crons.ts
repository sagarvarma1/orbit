import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { Config } from "../config.js";
import type { CronRun, Project, Repo } from "../db/repo.js";
import { type CronJob, matches, minuteOf, nextRun, parseSchedule, type Schedule } from "../lib/cron.js";
import { NotFoundError } from "../lib/errors.js";
import { type DeploymentManifest, FUNCTION_ENV_FILE, MANIFEST_FILE } from "../lib/manifest.js";

type CronConfig = Pick<Config, "artifactsDir" | "rootDomain" | "edgeInternalUrl" | "functionMaxDurationSeconds">;

/** Like Vercel's cron requests, so apps that check the user agent keep working. */
export const CRON_USER_AGENT = "vercel-cron/1.0";
/** How much of a response body is kept with the run. */
const OUTPUT_LIMIT = 2048;
/** How often the clock is checked; each UTC minute is run once. */
const TICK_MS = 5_000;

export interface CronJobStatus extends CronJob {
  nextRunAt: number | null;
  lastRun: CronRun | null;
}

interface LoadedDeployment {
  jobs: { job: CronJob; schedule: Schedule }[];
  /** CRON_SECRET from the deployment's env (snapshotted at build time, like every function env var). */
  secret: string | null;
}

/**
 * Runs the production deployment's cron jobs, Vercel style: once a minute, every job whose
 * schedule matches gets a GET request to its path, through the edge, with
 * `Authorization: Bearer $CRON_SECRET` when the project sets CRON_SECRET. Redirects aren't
 * followed, runs aren't retried, and minutes missed while Orbit was down aren't caught up.
 *
 * It lives in the control plane rather than the edge because it writes state (the run history);
 * the requests themselves go through the edge, so a cron path can be a function, a Next.js route
 * handler or anything else the deployment serves.
 */
export class CronService {
  private timer: NodeJS.Timeout | null = null;
  private lastMinute = 0;
  private readonly loaded = new Map<string, LoadedDeployment>();
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly repo: Repo,
    private readonly config: CronConfig,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    const interrupted = this.repo.failInterruptedCronRuns();
    if (interrupted) console.warn(`[cron] marked ${interrupted} interrupted run(s) as failed`);
    // The current minute counts: the unique index stops a restart from running a job twice.
    this.lastMinute = minuteOf(this.now()) - 60_000;
    this.timer = setInterval(() => void this.check(), TICK_MS);
    this.timer.unref();
    void this.check();
  }

  /** Stops scheduling and waits for runs in progress. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inflight]);
  }

  private async check(): Promise<void> {
    const minute = minuteOf(this.now());
    if (minute <= this.lastMinute) return;
    this.lastMinute = minute;
    await this.tick(minute);
  }

  /** Starts every job due in `minute` and resolves when they've finished. */
  async tick(minute: number): Promise<CronRun[]> {
    const runs: Promise<CronRun | null>[] = [];
    for (const project of this.repo.listProjects()) {
      if (!project.cronsEnabled) continue;
      const deploymentId = this.repo.productionDeploymentId(project.id);
      const deployment = deploymentId ? this.load(deploymentId) : null;
      if (!deploymentId || !deployment) continue;
      for (const { job, schedule } of deployment.jobs) {
        if (!matches(schedule, minute)) continue;
        runs.push(this.run(project, deploymentId, deployment, job, "schedule", minute));
      }
    }
    const settled = await Promise.all(runs);
    return settled.filter((r): r is CronRun => r !== null);
  }

  /** The production deployment's jobs with their next and last runs (for the dashboard). */
  jobs(project: Project): { deploymentId: string | null; jobs: CronJobStatus[] } {
    const deploymentId = this.repo.productionDeploymentId(project.id);
    const deployment = deploymentId ? this.load(deploymentId) : null;
    if (!deploymentId || !deployment) return { deploymentId, jobs: [] };
    const recent = this.repo.listCronRuns(project.id, 200);
    const now = this.now();
    return {
      deploymentId,
      jobs: deployment.jobs.map(({ job, schedule }) => ({
        ...job,
        nextRunAt: project.cronsEnabled ? nextRun(schedule, now) : null,
        lastRun: recent.find((r) => r.path === job.path && r.schedule === job.schedule) ?? null,
      })),
    };
  }

  /** "Run" in the dashboard: runs one of the production deployment's jobs now, even if crons are disabled. */
  async runNow(project: Project, job: CronJob): Promise<CronRun> {
    const deploymentId = this.repo.productionDeploymentId(project.id);
    const deployment = deploymentId ? this.load(deploymentId) : null;
    const match = deployment?.jobs.find((j) => j.job.path === job.path && j.job.schedule === job.schedule);
    if (!deploymentId || !deployment || !match) {
      throw new NotFoundError("That cron job isn't in the production deployment's vercel.json");
    }
    return (await this.run(project, deploymentId, deployment, match.job, "manual", this.now()))!;
  }

  private run(
    project: Project,
    deploymentId: string,
    deployment: LoadedDeployment,
    job: CronJob,
    trigger: CronRun["trigger"],
    scheduledAt: number,
  ): Promise<CronRun | null> {
    const started = this.repo.startCronRun({
      projectId: project.id,
      deploymentId,
      path: job.path,
      schedule: job.schedule,
      trigger,
      scheduledAt,
      startedAt: Date.now(),
    });
    if (!started) return Promise.resolve(null); // already ran this minute
    const promise = this.request(project, job.path, deployment.secret)
      .then(
        ({ statusCode, body }) =>
          this.repo.finishCronRun(started.id, {
            status: statusCode >= 200 && statusCode < 300 ? "success" : "error",
            statusCode,
            output: body || null,
          }),
        (err: Error) => this.repo.finishCronRun(started.id, { status: "error", statusCode: null, output: err.message }),
      )
      .then((run) => {
        if (run.status === "error")
          console.warn(`[cron] ${project.name} ${job.path}: ${run.statusCode ?? run.output ?? "failed"}`);
        return run;
      });
    this.inflight.add(promise);
    void promise.finally(() => this.inflight.delete(promise));
    return promise;
  }

  /** GET <path> on the project's production hostname, sent to the edge directly. */
  private request(project: Project, jobPath: string, secret: string | null): Promise<{ statusCode: number; body: string }> {
    const target = new URL(jobPath, `${this.config.edgeInternalUrl}/`);
    const client = target.protocol === "https:" ? https : http;
    // Longer than any function may run, so the edge reports a timeout before we give up.
    const timeoutMs = (this.config.functionMaxDurationSeconds + 15) * 1000;
    return new Promise((resolve, reject) => {
      const req = client.request(
        target,
        {
          method: "GET",
          headers: {
            host: `${project.name}.${this.config.rootDomain}`,
            "user-agent": CRON_USER_AGENT,
            "x-orbit-cron": "1",
            ...(secret ? { authorization: `Bearer ${secret}` } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            if (size < OUTPUT_LIMIT) chunks.push(chunk);
            size += chunk.length;
          });
          res.on("end", () => {
            const text = Buffer.concat(chunks).subarray(0, OUTPUT_LIMIT).toString("utf8");
            resolve({ statusCode: res.statusCode ?? 0, body: size > OUTPUT_LIMIT ? `${text}…` : text });
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`No response after ${timeoutMs / 1000}s`)));
      req.on("error", (err) => reject(new Error(`Couldn't reach the edge (${this.config.edgeInternalUrl}): ${err.message}`)));
      req.end();
    });
  }

  /** A deployment's cron jobs and secret. Artifacts never change, so this is cached by id. */
  private load(deploymentId: string): LoadedDeployment | null {
    const cached = this.loaded.get(deploymentId);
    if (cached) return cached;
    const dir = path.join(this.config.artifactsDir, deploymentId);
    let manifest: DeploymentManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8")) as DeploymentManifest;
    } catch {
      return null; // not built (yet), or removed
    }
    let secret: string | null = null;
    try {
      const env = JSON.parse(fs.readFileSync(path.join(dir, FUNCTION_ENV_FILE), "utf8")) as Record<string, string>;
      secret = env.CRON_SECRET || null;
    } catch {
      // No functions or server: nothing reads the secret anyway.
    }
    const loaded: LoadedDeployment = {
      jobs: (manifest.crons ?? []).map((job) => ({ job, schedule: parseSchedule(job.schedule) })),
      secret,
    };
    if (this.loaded.size >= 500) this.loaded.delete(this.loaded.keys().next().value!);
    this.loaded.set(deploymentId, loaded);
    return loaded;
  }
}
