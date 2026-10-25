import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/services/auth.js";
import { sessionFrom, testApp, type TestApp } from "./helpers.js";

describe("password hashing", () => {
  it("verifies the right password and rejects others", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong horse battery", hash)).toBe(false);
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
  });
});

describe("auth", () => {
  let t: TestApp;
  const DASHBOARD = { origin: "http://localhost:3000" };
  beforeEach(async () => {
    t = await testApp();
  });
  afterEach(() => t.close());

  async function setUp() {
    const code = (await t.auth.init())!;
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: DASHBOARD,
      payload: { code, email: "Admin@Example.com", password: "a-long-password" },
    });
    expect(res.statusCode).toBe(200);
    return sessionFrom(res);
  }

  it("locks the API until an admin exists and is signed in", async () => {
    expect((await t.app.inject({ url: "/api/health" })).statusCode).toBe(200);
    expect((await t.app.inject({ url: "/api/projects" })).statusCode).toBe(401);
    const status = await t.app.inject({ url: "/api/auth/status" });
    expect(status.json()).toMatchObject({ setupRequired: true, user: null, github: false });
  });

  it("creates the admin with the setup code, then only once", async () => {
    const code = (await t.auth.init())!;
    const setup = (c: string, password = "a-long-password") =>
      t.app.inject({ method: "POST", url: "/api/auth/setup", payload: { code: c, email: "a@b.co", password } });

    expect((await setup("NOPE-NOPE")).statusCode).toBe(400);
    expect((await setup(code, "short")).statusCode).toBe(400);
    expect(t.repo.countUsers()).toBe(0);
    expect((await setup(code.toLowerCase())).statusCode).toBe(200);
    expect((await setup(code)).statusCode).toBe(409);
    expect(t.repo.countUsers()).toBe(1);
  });

  it("signs in with a session cookie, and protects writes against cross-origin requests", async () => {
    const session = await setUp();
    expect(session).not.toBe("");
    const cookie = `orbit_session=${session}`;

    const me = await t.app.inject({ url: "/api/auth/status", headers: { cookie } });
    expect(me.json().user.email).toBe("admin@example.com");
    expect((await t.app.inject({ url: "/api/projects", headers: { cookie } })).statusCode).toBe(200);

    // A page on another origin (e.g. a deployment) can't use the cookie to change anything.
    const forged = await t.app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie, origin: "http://evil.localhost:8080" },
      payload: {},
    });
    expect(forged.statusCode).toBe(403);
    const noOrigin = await t.app.inject({ method: "POST", url: "/api/tokens", headers: { cookie }, payload: {} });
    expect(noOrigin.statusCode).toBe(403);
    const fromDashboard = await t.app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie, ...DASHBOARD },
      payload: { name: "ci" },
    });
    expect(fromDashboard.statusCode).toBe(201);

    const logout = await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
    expect((await t.app.inject({ url: "/api/projects", headers: { cookie } })).statusCode).toBe(401);
  });

  it("rejects wrong passwords and rate-limits repeated failures", async () => {
    await setUp();
    const attempt = (password: string) =>
      t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password } });
    expect((await attempt("wrong-password")).statusCode).toBe(401);
    for (let i = 0; i < 4; i++) await attempt("wrong-password");
    expect((await attempt("a-long-password")).statusCode).toBe(429);
  });

  it("issues API tokens that work as Bearer tokens until revoked", async () => {
    const cookie = `orbit_session=${await setUp()}`;
    const created = (
      await t.app.inject({ method: "POST", url: "/api/tokens", headers: { cookie, ...DASHBOARD }, payload: { name: "laptop" } })
    ).json();
    expect(created.token).toMatch(/^orbit_/);
    const bearer = { authorization: `Bearer ${created.token}` };

    // Tokens don't need an Origin: they aren't sent automatically by browsers.
    expect((await t.app.inject({ method: "POST", url: "/api/tokens", headers: bearer, payload: {} })).statusCode).toBe(201);
    const list = (await t.app.inject({ url: "/api/tokens", headers: bearer })).json();
    expect(list.tokens).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain(created.token);

    await t.app.inject({ method: "DELETE", url: `/api/tokens/${created.apiToken.id}`, headers: { cookie, ...DASHBOARD } });
    expect((await t.app.inject({ url: "/api/projects", headers: bearer })).statusCode).toBe(401);
  });

  it("seeds the admin from the environment instead of printing a setup code", async () => {
    expect(await t.auth.init({ email: "ops@example.com", password: "a-long-password" })).toBeNull();
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ops@example.com", password: "a-long-password" },
    });
    expect(res.statusCode).toBe(200);
    expect(sessionFrom(res)).not.toBe("");
  });
});

describe("password reset", () => {
  it("resets the admin password from the environment and signs out existing sessions", async () => {
    const t = await testApp();
    await t.auth.init({ email: "admin@example.com", password: "a-long-password" });
    const login = (password: string) =>
      t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password } });
    const cookie = `orbit_session=${sessionFrom(await login("a-long-password"))}`;
    await t.auth.init({ resetPassword: "another-long-password" });
    expect((await t.app.inject({ url: "/api/projects", headers: { cookie } })).statusCode).toBe(401);
    expect((await login("another-long-password")).statusCode).toBe(200);
    await t.close();
  });
});
