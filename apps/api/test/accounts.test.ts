import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { Project } from "../src/db/repo.js";
import { safeNext } from "../src/routes/auth.js";
import { Access } from "../src/services/access.js";
import { testApp, type TestApp } from "./helpers.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const PEOPLE: Record<string, { id: number; login: string; email: string | null }> = {
  ghu_owner: { id: 1, login: "Owner", email: "owner@example.com" },
  ghu_alice: { id: 2, login: "alice", email: null },
  ghu_bob: { id: 3, login: "bob", email: "bob@example.com" },
};

/** GitHub's OAuth endpoints and the user-scoped API, keyed by the code/token each person gets. */
function fakeGitHub() {
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    calls.push(`${req.method} ${url.pathname}`);
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");

    if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
      const params = JSON.parse(body) as { client_id: string; client_secret: string; code?: string; refresh_token?: string };
      if (params.client_id !== "Iv1.client" || params.client_secret !== "client-secret")
        return send(200, { error: "bad_client" });
      if (params.refresh_token === "refresh-alice") {
        return send(200, { access_token: "ghu_alice", expires_in: 28800, refresh_token: "refresh-alice-2" });
      }
      const access = `ghu_${params.code}`;
      if (!PEOPLE[access]) return send(200, { error: "bad_verification_code", error_description: "The code is incorrect." });
      return send(200, { access_token: access, expires_in: 28800, refresh_token: `refresh-${params.code}` });
    }
    const me = PEOPLE[token];
    if (url.pathname === "/user") {
      return me ? send(200, { ...me, name: me.login, avatar_url: `https://avatars.example/${me.id}` }) : send(401, {});
    }
    if (url.pathname === "/repos/alice/site") {
      if (!me) return send(401, {});
      return send(200, { permissions: { admin: me.login === "alice", push: me.login === "alice", pull: true } });
    }
    // The app is installed on alice's account.
    if (url.pathname === "/repos/alice/site/installation") return send(200, { id: 7 });
    if (url.pathname === "/app/installations/7/access_tokens") {
      return send(201, { token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (url.pathname === "/user/installations") {
      return send(200, {
        installations:
          me?.login === "alice"
            ? [{ id: 7, account: { login: "alice" }, repository_selection: "all", html_url: "https://github.com/i/7" }]
            : [],
      });
    }
    if (url.pathname === "/user/installations/7/repositories") {
      return send(200, {
        repositories: [
          {
            full_name: "alice/site",
            html_url: "https://github.com/alice/site",
            private: true,
            default_branch: "main",
            pushed_at: null,
          },
        ],
      });
    }
    send(404, { message: "Not Found" });
  });
  return { server, calls };
}

const project = (id: string, ownerId: string | null): Project => ({
  id,
  name: id.replace("prj_", ""),
  repoUrl: `https://github.com/acme/${id}.git`,
  productionBranch: "main",
  framework: null,
  installCommand: null,
  buildCommand: null,
  outputDirectory: null,
  rootDirectory: ".",
  autoPromotePaused: false,
  ownerId,
  createdAt: 1,
  updatedAt: 1,
});

describe("safeNext", () => {
  it("keeps same-site paths only", () => {
    expect(safeNext("/my-app?tab=1")).toBe("/my-app?tab=1");
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "", undefined, 3]) expect(safeNext(bad)).toBe("/");
  });
});

describe("accounts", () => {
  const gh = fakeGitHub();
  let t: TestApp;
  let base: string;

  beforeAll(() => new Promise<void>((r) => gh.server.listen(0, "127.0.0.1", r)));
  afterAll(() => gh.server.close());
  afterEach(() => t.close());

  async function start(overrides: Partial<Config> = {}) {
    base = `http://127.0.0.1:${(gh.server.address() as AddressInfo).port}`;
    t = await testApp({
      githubApiUrl: base,
      githubWebUrl: base,
      dashboardUrl: "https://app.example.com",
      signups: true,
      adminGithubLogin: "",
      ...overrides,
    });
    t.repo.setSetting("github_app", {
      id: 99,
      slug: "orbit-test",
      name: "Orbit test",
      htmlUrl: "https://github.com/apps/orbit-test",
      owner: "owner",
      clientId: "Iv1.client",
      clientSecret: "client-secret",
      webhookSecret: "hook",
      privateKey,
    });
    gh.calls.length = 0;
  }

  /** The full browser round trip: Orbit -> GitHub's authorize page -> callback with a code. */
  async function signIn(code: string, next = "/") {
    const begin = await t.app.inject({ url: `/api/auth/github?next=${encodeURIComponent(next)}` });
    expect(begin.statusCode).toBe(302);
    const authorize = new URL(String(begin.headers.location));
    expect(authorize.pathname).toBe("/login/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("Iv1.client");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/auth/github/callback");
    const state = authorize.searchParams.get("state")!;
    const oauthCookie = /orbit_oauth=[^;]*/.exec(String(begin.headers["set-cookie"]))![0];
    const back = await t.app.inject({
      url: `/api/auth/github/callback?code=${code}&state=${state}`,
      headers: { cookie: oauthCookie },
    });
    expect(back.statusCode).toBe(302);
    const session = /orbit_session=([^;]+)/.exec([back.headers["set-cookie"]].flat().join("\n"))?.[1];
    return { location: String(back.headers.location), cookie: session ? `orbit_session=${session}` : null };
  }

  it("signs people up with GitHub and sends new accounts to import a project", async () => {
    await start();
    const { location, cookie } = await signIn("alice");
    expect(location).toBe("https://app.example.com/new?welcome=1");
    const status = (await t.app.inject({ url: "/api/auth/status", headers: { cookie: cookie! } })).json();
    expect(status.user).toMatchObject({
      githubLogin: "alice",
      role: "member",
      hasPassword: false,
      email: "2+alice@users.noreply.github.com",
    });
    // Signing in again reuses the account and honors ?next=.
    expect((await signIn("alice", "/my-app")).location).toBe("https://app.example.com/my-app");
    expect(t.repo.countUsers()).toBe(1);
  });

  it("rejects a callback whose state doesn't match the cookie", async () => {
    await start();
    const res = await t.app.inject({
      url: "/api/auth/github/callback?code=alice&state=forged",
      headers: { cookie: "orbit_oauth=real-state%3A%2F" },
    });
    expect(String(res.headers.location)).toMatch(/\/login\?error=.*expired/);
    expect(t.repo.countUsers()).toBe(0);
  });

  it("with sign-ups closed, only the admin's GitHub account gets in, and it takes over the original admin", async () => {
    await start({ signups: false });
    await t.auth.init({ email: "admin@example.com", password: "a-long-password" });
    const admin = t.repo.getUserByEmail("admin@example.com")!;
    t.repo.insertProject(project("prj_old", admin.id));

    const stranger = await signIn("bob");
    expect(stranger.cookie).toBeNull();
    expect(decodeURIComponent(stranger.location)).toMatch(/Sign-ups are closed/);

    // The app's owner is "owner"; GitHub logins are case-insensitive.
    const owner = await signIn("owner");
    const me = (await t.app.inject({ url: "/api/auth/status", headers: { cookie: owner.cookie! } })).json().user;
    expect(me).toMatchObject({ id: admin.id, role: "admin", githubLogin: "Owner", hasPassword: true });
    const projects = (await t.app.inject({ url: "/api/projects", headers: { cookie: owner.cookie! } })).json().projects;
    expect(projects.map((p: Project) => p.name)).toEqual(["old"]);
  });

  it("keeps each account's projects and deployments private", async () => {
    await start();
    const alice = (await signIn("alice")).cookie!;
    const bob = (await signIn("bob")).cookie!;
    const aliceId = t.repo.getUserByGithubId(2)!.id;
    t.repo.insertProject(project("prj_alices", aliceId));
    t.repo.insertDeployment({
      id: "dpl-alices1",
      projectId: "prj_alices",
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
      startedAt: null,
      finishedAt: null,
    });

    const get = (url: string, cookie: string) => t.app.inject({ url, headers: { cookie } });
    expect((await get("/api/projects", alice)).json().projects).toHaveLength(1);
    expect((await get("/api/projects", bob)).json().projects).toHaveLength(0);
    expect((await get("/api/projects/alices", alice)).statusCode).toBe(200);
    expect((await get("/api/deployments/dpl-alices1", alice)).statusCode).toBe(200);
    for (const path of [
      "/api/projects/alices",
      "/api/projects/alices/env",
      "/api/projects/alices/deployments",
      "/api/deployments/dpl-alices1",
      "/api/deployments/dpl-alices1/logs",
    ]) {
      expect((await get(path, bob)).statusCode, path).toBe(404);
    }
    const write = await t.app.inject({
      method: "PUT",
      url: "/api/projects/alices/env/SECRET",
      headers: { cookie: bob, origin: "https://app.example.com" },
      payload: { value: "x" },
    });
    expect(write.statusCode).toBe(404);
    const promote = await t.app.inject({
      method: "POST",
      url: "/api/deployments/dpl-alices1/promote",
      headers: { cookie: bob, origin: "https://app.example.com" },
    });
    expect(promote.statusCode).toBe(404);
  });

  it("only lets the admin manage the GitHub App", async () => {
    await start();
    const alice = (await signIn("alice")).cookie!;
    const headers = { cookie: alice, origin: "https://app.example.com" };
    expect((await t.app.inject({ method: "DELETE", url: "/api/github", headers })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "POST", url: "/api/github/manifest", headers, payload: {} })).statusCode).toBe(403);
    const status = (await t.app.inject({ url: "/api/github", headers })).json();
    expect(status.canManage).toBe(false);
    expect(status.installations.map((i: { account: string }) => i.account)).toEqual(["alice"]);
    const repos = (await t.app.inject({ url: "/api/github/repositories", headers })).json().repositories;
    expect(repos.map((r: { fullName: string }) => r.fullName)).toEqual(["alice/site"]);
  });

  it("lets members import repositories they can push to, not other people's", async () => {
    await start();
    await signIn("alice");
    await signIn("bob");
    const access = new Access(t.repo, t.githubApp, t.config);
    const user = (login: string) => {
      const u = t.repo.getUserByGithubId(PEOPLE[`ghu_${login}`]!.id)!;
      return { id: u.id, role: u.role, email: u.email, githubLogin: login, name: null, avatarUrl: null, hasPassword: false };
    };
    await expect(access.assertCanImport(user("alice"), "https://github.com/alice/site")).resolves.toBeUndefined();
    // Bob can read alice/site (say it's public) but Orbit is installed there, so it's hers to deploy.
    await expect(access.assertCanImport(user("bob"), "https://github.com/alice/site")).rejects.toThrow(/push access/);
  });

  it("refreshes an expired GitHub token once, even for concurrent requests", async () => {
    await start();
    await signIn("alice");
    const alice = t.repo.getUserByGithubId(2)!;
    t.repo.updateUserGithubToken(alice.id, { accessToken: "stale", expiresAt: Date.now() - 1000, refreshToken: "refresh-alice" });
    const access = new Access(t.repo, t.githubApp, t.config);
    gh.calls.length = 0;
    const tokens = await Promise.all([access.githubToken(alice.id), access.githubToken(alice.id)]);
    expect(tokens).toEqual(["ghu_alice", "ghu_alice"]);
    expect(gh.calls.filter((c) => c.endsWith("/login/oauth/access_token"))).toHaveLength(1);
    expect(t.repo.getUser(alice.id)!.githubToken?.refreshToken).toBe("refresh-alice-2");
  });

  it("caps projects and running builds for members", async () => {
    await start({ maxProjectsPerUser: 1 });
    const alice = (await signIn("alice")).cookie!;
    t.repo.insertProject(project("prj_one", t.repo.getUserByGithubId(2)!.id));
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: alice, origin: "https://app.example.com" },
      payload: { repoUrl: "https://github.com/alice/site" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/up to 1 project/);
  });
});
