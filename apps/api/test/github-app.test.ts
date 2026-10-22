import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appJwt } from "../src/services/github-app.js";
import { adminHeaders, testApp, type TestApp } from "./helpers.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function verifyJwt(token: string): { iss: number; exp: number; iat: number } | null {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  const ok = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, "base64url"));
  return ok ? JSON.parse(Buffer.from(payload, "base64url").toString()) : null;
}

/** Just enough of GitHub's App API, checking that app-level calls carry a valid JWT. */
function fakeGitHub() {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    calls.push(`${req.method} ${url.pathname}`);
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const asApp = () => verifyJwt(auth)?.iss === 123;

    if (req.method === "POST" && url.pathname === "/app-manifests/good-code/conversions") {
      return send(201, {
        id: 123,
        slug: "orbit-test",
        name: "Orbit test",
        html_url: "https://github.com/apps/orbit-test",
        owner: { login: "acme" },
        client_id: "Iv1.abc",
        client_secret: "secret",
        webhook_secret: "hook-secret",
        pem: privateKey,
      });
    }
    if (url.pathname.startsWith("/app/") && !asApp()) return send(401, { message: "A JSON web token could not be decoded" });
    if (req.method === "GET" && url.pathname === "/app/installations") {
      return send(200, [
        { id: 42, account: { login: "acme" }, repository_selection: "selected", html_url: "https://github.com/x" },
      ]);
    }
    if (req.method === "POST" && url.pathname === "/app/installations/42/access_tokens") {
      return send(201, { token: "ghs_installation", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (req.method === "GET" && url.pathname === "/repos/acme/private/installation") {
      return asApp() ? send(200, { id: 42 }) : send(401, {});
    }
    if (req.method === "GET" && url.pathname === "/repos/acme/elsewhere/installation") return send(404, { message: "Not Found" });
    if (req.method === "GET" && url.pathname === "/installation/repositories") {
      if (auth !== "ghs_installation") return send(401, {});
      return send(200, {
        total_count: 2,
        repositories: [
          {
            full_name: "acme/old",
            html_url: "https://github.com/acme/old",
            private: false,
            default_branch: "main",
            pushed_at: "2024-01-01T00:00:00Z",
          },
          {
            full_name: "acme/private",
            html_url: "https://github.com/acme/private",
            private: true,
            default_branch: "main",
            pushed_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
    }
    send(404, { message: "Not Found" });
  });
  return { server, calls };
}

describe("app JWT", () => {
  it("is RS256-signed with a short expiry", () => {
    const now = 1_700_000_000;
    const claims = verifyJwt(appJwt(123, privateKey, now))!;
    expect(claims).toEqual({ iat: now - 60, exp: now + 540, iss: 123 });
  });
});

describe("GitHub App", () => {
  const gh = fakeGitHub();
  let t: TestApp;
  let headers: Record<string, string>;

  beforeAll(() => new Promise<void>((r) => gh.server.listen(0, "127.0.0.1", r)));
  afterAll(() => gh.server.close());
  beforeEach(async () => {
    const url = `http://127.0.0.1:${(gh.server.address() as AddressInfo).port}`;
    t = await testApp({ githubApiUrl: url, githubWebUrl: "https://github.example", dashboardUrl: "https://app.example.com" });
    headers = await adminHeaders(t);
    gh.calls.length = 0;
  });
  afterEach(() => t.close());

  async function connect() {
    const start = (await t.app.inject({ method: "POST", url: "/api/github/manifest", headers, payload: {} })).json();
    const done = await t.app.inject({
      method: "POST",
      url: "/api/github/manifest/complete",
      headers,
      payload: { code: "good-code", state: start.state },
    });
    expect(done.statusCode).toBe(200);
    return { start, done: done.json() };
  }

  it("builds a manifest that points GitHub back at this instance", async () => {
    const start = (await t.app.inject({ method: "POST", url: "/api/github/manifest", headers, payload: { org: "acme" } })).json();
    expect(start.action).toBe(`https://github.example/organizations/acme/settings/apps/new?state=${start.state}`);
    expect(start.manifest).toMatchObject({
      redirect_url: "https://app.example.com/settings/github/callback",
      hook_attributes: { url: "https://app.example.com/api/webhooks/github", active: true },
      default_permissions: { contents: "read", statuses: "write", pull_requests: "write" },
      default_events: ["push", "pull_request"],
    });
    expect(start.manifest.name.length).toBeLessThanOrEqual(34);
  });

  it("rejects a callback with the wrong state", async () => {
    await t.app.inject({ method: "POST", url: "/api/github/manifest", headers, payload: {} });
    const res = await t.app.inject({
      method: "POST",
      url: "/api/github/manifest/complete",
      headers,
      payload: { code: "good-code", state: "forged" },
    });
    expect(res.statusCode).toBe(400);
    expect(t.githubApp.configured).toBe(false);
  });

  it("connects, lists installations and repositories, and mints cached tokens per repository", async () => {
    const { done } = await connect();
    expect(done.installUrl).toBe("https://github.com/apps/orbit-test/installations/new");

    const status = (await t.app.inject({ url: "/api/github", headers })).json();
    expect(status.app.slug).toBe("orbit-test");
    expect(status.installations).toEqual([expect.objectContaining({ id: 42, account: "acme" })]);
    expect(JSON.stringify(status)).not.toContain("BEGIN PRIVATE KEY");

    const repos = (await t.app.inject({ url: "/api/github/repositories", headers })).json().repositories;
    expect(repos.map((r: { fullName: string }) => r.fullName)).toEqual(["acme/private", "acme/old"]);

    expect(await t.githubApp.tokenFor("https://github.com/acme/private.git")).toBe("ghs_installation");
    expect(await t.githubApp.tokenFor("https://github.com/acme/elsewhere")).toBeUndefined();
    expect(await t.githubApp.tokenFor("file:///tmp/repo")).toBeUndefined();
    expect(gh.calls.filter((c) => c.endsWith("/access_tokens"))).toHaveLength(1);
  });

  it("accepts webhooks signed with the app's secret", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main", after: "a".repeat(40), repository: { full_name: "acme/nothing" } });
    const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const post = (signature: string) =>
      t.app.inject({
        method: "POST",
        url: "/api/webhooks/github",
        headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": signature },
        payload: body,
      });
    expect((await post(sign("hook-secret"))).statusCode).toBe(503); // nothing configured yet
    await connect();
    expect((await post(sign("hook-secret"))).statusCode).toBe(200);
    expect((await post(sign("wrong"))).statusCode).toBe(401);
  });

  it("disconnects", async () => {
    await connect();
    await t.app.inject({ method: "DELETE", url: "/api/github", headers });
    expect(t.githubApp.configured).toBe(false);
    expect(await t.githubApp.tokenFor("https://github.com/acme/private")).toBeUndefined();
  });
});
