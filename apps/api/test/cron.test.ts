import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../src/db/repo.js";
import { matches, nextRun, parseCronsConfig, parseSchedule } from "../src/lib/cron.js";
import { FUNCTION_ENV_FILE, MANIFEST_FILE } from "../src/lib/manifest.js";
import { CRON_USER_AGENT, CronService } from "../src/services/crons.js";
import { adminHeaders, type TestApp, testApp } from "./helpers.js";

const at = (iso: string) => Date.parse(iso);

describe("cron schedules", () => {
  it("matches minutes, hours, steps, ranges and lists in UTC", () => {
    const daily = parseSchedule("0 5 * * *");
    expect(matches(daily, at("2026-03-10T05:00:30Z"))).toBe(true);
    expect(matches(daily, at("2026-03-10T05:01:00Z"))).toBe(false);
    expect(matches(daily, at("2026-03-10T06:00:00Z"))).toBe(false);

    const quarter = parseSchedule("*/15 9-17 * * 1-5");
    expect(matches(quarter, at("2026-03-10T09:45:00Z"))).toBe(true); // Tuesday
    expect(matches(quarter, at("2026-03-10T09:50:00Z"))).toBe(false);
    expect(matches(quarter, at("2026-03-14T09:45:00Z"))).toBe(false); // Saturday

    const list = parseSchedule("5,10-20/5 * 1,15 * *");
    expect([5, 10, 15, 20].every((m) => matches(list, Date.UTC(2026, 0, 15, 3, m)))).toBe(true);
    expect(matches(list, Date.UTC(2026, 0, 15, 3, 25))).toBe(false);
    expect(matches(list, Date.UTC(2026, 0, 2, 3, 5))).toBe(false);
  });

  it("rejects what Vercel rejects", () => {
    expect(() => parseSchedule("0 5 * *")).toThrow(/5 fields/);
    expect(() => parseSchedule("0 5 * * MON")).toThrow(/names/);
    expect(() => parseSchedule("60 * * * *")).toThrow(/between 0 and 59/);
    expect(() => parseSchedule("0 0 1 * 1")).toThrow(/can't both be set/);
    expect(() => parseSchedule("0 0 L * *")).toThrow();
    expect(() => parseSchedule("*/0 * * * *")).toThrow(/step/);
    expect(() => parseSchedule("10-5 * * * *")).toThrow(/range/);
  });

  it("finds the next run", () => {
    expect(nextRun(parseSchedule("0 5 * * *"), at("2026-03-10T05:00:00Z"))).toBe(at("2026-03-11T05:00:00Z"));
    expect(nextRun(parseSchedule("*/10 * * * *"), at("2026-03-10T05:01:00Z"))).toBe(at("2026-03-10T05:10:00Z"));
    expect(nextRun(parseSchedule("0 0 29 2 *"), at("2026-03-01T00:00:00Z"))).toBe(at("2028-02-29T00:00:00Z"));
    expect(nextRun(parseSchedule("30 12 * * 0"), at("2026-03-10T00:00:00Z"))).toBe(at("2026-03-15T12:30:00Z"));
    expect(nextRun(parseSchedule("0 0 31 2 *"), at("2026-03-01T00:00:00Z"))).toBeNull();
  });

  it("validates vercel.json crons", () => {
    expect(parseCronsConfig({})).toBeUndefined();
    expect(parseCronsConfig({ crons: [{ path: "/api/a", schedule: " 0  5 * * * " }] })).toEqual([
      { path: "/api/a", schedule: "0 5 * * *" },
    ]);
    expect(() => parseCronsConfig({ crons: [{ path: "api/a", schedule: "* * * * *" }] })).toThrow(/crons.0.path/);
    expect(() => parseCronsConfig({ crons: [{ path: "/api/a", schedule: "0 5 * * SUN" }] })).toThrow(/crons.0.schedule/);
    expect(() => parseCronsConfig({ crons: [{ path: "/a", schedule: "0 0 31 2 *" }] })).toThrow(/never runs/);
    expect(() =>
      parseCronsConfig({
        crons: [
          { path: "/a", schedule: "* * * * *" },
          { path: "/a", schedule: "* * * * *" },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() => parseCronsConfig({ crons: "nope" })).toThrow(/crons/);
  });
});

// ------------------------------------------------------------------ scheduler

describe("cron scheduler", () => {
  let t: TestApp;
  let edge: http.Server;
  let headers: Record<string, string>;
  const requests: { url: string; headers: http.IncomingHttpHeaders }[] = [];
  let respond: (res: http.ServerResponse) => void = (res) => res.end("ok");
  let crons: CronService;
  let project: Project;

  const minute = at("2026-03-10T05:00:00Z");

  beforeAll(async () => {
    edge = http.createServer((req, res) => {
      requests.push({ url: req.url!, headers: req.headers });
      respond(res);
    });
    await new Promise<void>((r) => edge.listen(0, "127.0.0.1", r));
    const edgeUrl = `http://127.0.0.1:${(edge.address() as AddressInfo).port}`;
    t = await testApp({ edgeInternalUrl: edgeUrl });
    headers = await adminHeaders(t);
    crons = new CronService(t.repo, t.config, () => minute + 1000);

    const owner = t.repo.getUserByEmail("admin@example.com")!;
    t.repo.insertProject({
      id: "prj_cron",
      name: "cron-app",
      repoUrl: "https://github.com/example/cron-app",
      productionBranch: "main",
      framework: null,
      installCommand: null,
      buildCommand: null,
      outputDirectory: null,
      rootDirectory: ".",
      autoPromotePaused: false,
      cronsEnabled: true,
      ownerId: owner.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    project = t.repo.getProject("prj_cron")!;
    for (const id of ["dpl-cronold001", "dpl-cronnew001"]) {
      t.repo.insertDeployment({
        id,
        projectId: project.id,
        target: "production",
        branch: "main",
        ref: "main",
        commitSha: null,
        commitMessage: null,
        commitAuthor: null,
        status: "ready",
        trigger: "manual",
        framework: "static",
        errorMessage: null,
        builder: null,
        useCache: true,
        cacheStatus: null,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      });
    }
    const write = (id: string, jobs: { path: string; schedule: string }[], env: Record<string, string>) => {
      const dir = path.join(t.config.artifactsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ deploymentId: id, functions: [], crons: jobs }));
      fs.writeFileSync(path.join(dir, FUNCTION_ENV_FILE), JSON.stringify(env));
    };
    write("dpl-cronold001", [{ path: "/api/old", schedule: "* * * * *" }], {});
    write(
      "dpl-cronnew001",
      [
        { path: "/api/daily?full=1", schedule: "0 5 * * *" },
        { path: "/api/hourly", schedule: "0 * * * *" },
        { path: "/api/never-now", schedule: "30 * * * *" },
      ],
      { CRON_SECRET: "s3cret" },
    );
    t.repo.switchProduction(project, "dpl-cronnew001", "auto");
  });

  afterAll(async () => {
    await t.close();
    edge.close();
  });

  it("runs due jobs of the production deployment through the edge, with the secret", async () => {
    const runs = await crons.tick(minute);
    expect(runs.map((r) => r.path).sort()).toEqual(["/api/daily?full=1", "/api/hourly"]);
    expect(runs.every((r) => r.status === "success" && r.statusCode === 200 && r.output === "ok")).toBe(true);
    expect(runs.every((r) => r.deploymentId === "dpl-cronnew001" && r.trigger === "schedule")).toBe(true);

    const daily = requests.find((r) => r.url === "/api/daily?full=1")!;
    expect(daily.headers.host).toBe("cron-app.localhost");
    expect(daily.headers.authorization).toBe("Bearer s3cret");
    expect(daily.headers["user-agent"]).toBe(CRON_USER_AGENT);
    expect(requests.some((r) => r.url === "/api/old")).toBe(false);
  });

  it("never runs a job twice for the same minute", async () => {
    const before = requests.length;
    expect(await crons.tick(minute)).toEqual([]);
    // Another scheduler (a restarted control plane) is deduplicated by the database.
    expect(await new CronService(t.repo, t.config).tick(minute)).toEqual([]);
    expect(requests.length).toBe(before);
  });

  it("records non-2xx responses and unreachable edges as errors", async () => {
    respond = (res) => {
      res.statusCode = 500;
      res.end("boom");
    };
    const [run] = await crons.tick(minute + 3_600_000);
    expect(run).toMatchObject({ path: "/api/hourly", status: "error", statusCode: 500, output: "boom" });
    respond = (res) => res.end("ok");

    const offline = new CronService(t.repo, { ...t.config, edgeInternalUrl: "http://127.0.0.1:1" });
    const [failed] = await offline.tick(minute + 2 * 3_600_000);
    expect(failed).toMatchObject({ status: "error", statusCode: null });
    expect(failed!.output).toMatch(/Couldn't reach the edge/);
  });

  it("skips projects with crons disabled", async () => {
    t.repo.updateProject(project.id, { cronsEnabled: false });
    expect(await crons.tick(minute + 3 * 3_600_000)).toEqual([]);
    t.repo.updateProject(project.id, { cronsEnabled: true });
  });

  it("lists jobs and runs, and runs a job on demand over the API", async () => {
    const list = await t.app.inject({ method: "GET", url: "/api/projects/cron-app/crons", headers });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.enabled).toBe(true);
    expect(body.deploymentId).toBe("dpl-cronnew001");
    expect(body.jobs).toHaveLength(3);
    expect(body.runs.length).toBeGreaterThan(0);

    const run = await t.app.inject({
      method: "POST",
      url: "/api/projects/cron-app/crons/run",
      headers,
      payload: { path: "/api/never-now", schedule: "30 * * * *" },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().run).toMatchObject({ trigger: "manual", status: "success", path: "/api/never-now" });

    const missing = await t.app.inject({
      method: "POST",
      url: "/api/projects/cron-app/crons/run",
      headers,
      payload: { path: "/api/old", schedule: "* * * * *" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("toggles crons from project settings", async () => {
    const res = await t.app.inject({
      method: "PATCH",
      url: "/api/projects/cron-app",
      headers,
      payload: { cronsEnabled: false },
    });
    expect(res.json().project.cronsEnabled).toBe(false);
    const list = await t.app.inject({ method: "GET", url: "/api/projects/cron-app/crons", headers });
    expect(list.json().jobs.every((j: { nextRunAt: number | null }) => j.nextRunAt === null)).toBe(true);
  });
});
