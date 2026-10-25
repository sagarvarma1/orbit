import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../src/db/repo.js";
import { normalizeDomain } from "../src/routes/domains.js";
import { adminHeaders, testApp, type TestApp } from "./helpers.js";

const cfg = { rootDomain: "example.app", dashboardUrl: "https://app.example.app" };

describe("normalizeDomain", () => {
  it("accepts domains in the forms people paste them", () => {
    expect(normalizeDomain("Shop.Example.com", cfg)).toBe("shop.example.com");
    expect(normalizeDomain("https://www.example.com/path?q=1", cfg)).toBe("www.example.com");
    expect(normalizeDomain("example.com.", cfg)).toBe("example.com");
    expect(normalizeDomain("example.com:443", cfg)).toBe("example.com");
  });
  it("rejects invalid names, IPs, names under the platform domain and the dashboard", () => {
    for (const bad of ["localhost", "1.2.3.4", "-bad.com", "no_underscores.com", "a..b.com", "example", ""]) {
      expect(() => normalizeDomain(bad, cfg), bad).toThrow();
    }
    expect(() => normalizeDomain("my-app.example.app", cfg)).toThrow(/assigned automatically/);
    // The bare root domain can host a project, e.g. a landing page.
    expect(normalizeDomain("example.app", cfg)).toBe("example.app");
    expect(() => normalizeDomain("app.example.app", cfg)).toThrow();
  });
});

describe("domain routes", () => {
  let t: TestApp;
  let headers: Record<string, string>;
  const project: Project = {
    id: "prj_1",
    name: "site",
    repoUrl: "https://github.com/acme/site.git",
    productionBranch: "main",
    framework: null,
    installCommand: null,
    buildCommand: null,
    outputDirectory: null,
    rootDirectory: ".",
    autoPromotePaused: false,
    createdAt: 1,
    updatedAt: 1,
  };

  beforeEach(async () => {
    t = await testApp({ rootDomain: "localhost" });
    headers = await adminHeaders(t);
    t.repo.insertProject(project);
    t.repo.insertProject({ ...project, id: "prj_2", name: "other" });
  });
  afterEach(() => t.close());

  const add = (projectName: string, hostname: string, branch?: string) =>
    t.app.inject({ method: "POST", url: `/api/projects/${projectName}/domains`, headers, payload: { hostname, branch } });

  it("adds, lists and removes domains, one project per domain", async () => {
    const res = await add("site", "WWW.Example.com");
    expect(res.statusCode).toBe(201);
    expect(res.json().domain).toMatchObject({ hostname: "www.example.com", branch: null, dns: { configured: null } });
    expect((await add("other", "www.example.com")).json().error).toMatch(/already assigned to project "site"/);
    expect((await add("site", "staging.example.com", "develop")).statusCode).toBe(201);

    const list = (await t.app.inject({ url: "/api/projects/site/domains", headers })).json().domains;
    expect(list.map((d: { hostname: string }) => d.hostname)).toEqual(["www.example.com", "staging.example.com"]);
    const projectRes = (await t.app.inject({ url: "/api/projects/site", headers })).json();
    expect(projectRes.project.customDomains).toHaveLength(2);

    const del = await t.app.inject({ method: "DELETE", url: "/api/projects/site/domains/www.example.com", headers });
    expect(del.statusCode).toBe(200);
    expect(t.repo.getDomain("www.example.com")).toBeUndefined();
  });

  it("only approves TLS certificates for hostnames Orbit serves", async () => {
    await add("site", "www.example.com");
    t.repo.insertDeployment({
      id: "dpl-abcdefghij",
      projectId: "prj_1",
      target: "production",
      branch: "main",
      ref: "main",
      commitSha: null,
      commitMessage: null,
      commitAuthor: null,
      status: "ready",
      trigger: "manual",
      framework: null,
      errorMessage: null,
      builder: null,
      useCache: true,
      cacheStatus: null,
      createdAt: 1,
      startedAt: 1,
      finishedAt: 1,
    });
    t.repo.setAlias({ hostname: "site", projectId: "prj_1", deploymentId: "dpl-abcdefghij", kind: "production" });

    // No auth: Caddy calls this.
    const allowed = (domain: string) => t.app.inject({ url: `/api/tls/allowed?domain=${domain}` }).then((r) => r.statusCode);
    expect(await allowed("www.example.com")).toBe(200);
    expect(await allowed("site.localhost")).toBe(200);
    expect(await allowed("dpl-abcdefghij.localhost")).toBe(200);
    expect(await allowed("localhost")).toBe(200); // the dashboard's own host
    expect(await allowed("nope.localhost")).toBe(404);
    expect(await allowed("evil.com")).toBe(404);
    expect(await allowed("")).toBe(404);
  });
});

describe("edge routing for custom domains", () => {
  it("serves custom domains through resolveDomain and everything else by label", async () => {
    const { createEdgeHandler } = await import("../src/edge/server.js");
    const { default: http } = await import("node:http");
    const handler = createEdgeHandler({
      rootDomain: "localhost",
      artifactsDir: "/nonexistent",
      functionTimeoutMs: 1000,
      functionMemoryMb: 64,
      lookup: {
        resolve: () => null,
        resolveDomain: (host) => (host === "www.example.com" ? { deploymentId: "dpl-abcdefghij", status: "building" } : null),
      },
    });
    const server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const get = (host: string) =>
      new Promise<number>((resolve) =>
        http.get({ port, host: "127.0.0.1", headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        }),
      );
    expect(await get("WWW.example.com:443")).toBe(503); // found, still building
    expect(await get("unknown.example.com")).toBe(404);
    server.close();
  });
});
