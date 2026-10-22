#!/usr/bin/env node
/**
 * End-to-end test: boots a real control plane + edge on spare ports with a temp data dir,
 * deploys real public GitHub repos and local fixture repos, and checks everything over HTTP.
 * Nothing is mocked: real git clone, real npm install, real builds, real serving.
 *
 *   node scripts/e2e.mjs            # full run
 *   node scripts/e2e.mjs --offline  # skip the public GitHub repos
 *   node scripts/e2e.mjs --next     # also build a Next.js static-export app (~150 MB install)
 */
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT, "apps/api");
const API_PORT = 4100;
const EDGE_PORT = 8180;
const SECRET = "e2e-secret";
const OFFLINE = process.argv.includes("--offline");
const WITH_NEXT = process.argv.includes("--next");
const API = `http://127.0.0.1:${API_PORT}`;
const GITHUB_PORT = 4199;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-e2e-"));
const dataDir = path.join(tmp, "data");
const children = [];
const ADMIN = { email: "e2e@example.com", password: "e2e-password-123" };
/** API token, created after signing in; every API call uses it. */
let token = "";
let passed = 0;
let failed = 0;

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m ${detail}`);
  }
}

async function api(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** GET from the edge with an explicit Host header (fetch() can't set Host). */
function edge(host, urlPath = "/", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: EDGE_PORT, path: urlPath, headers: { host: `${host}.localhost:${EDGE_PORT}`, ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(deploymentId, statuses = ["ready", "error", "canceled"], timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { deployment } = await api("GET", `/api/deployments/${deploymentId}`);
    if (statuses.includes(deployment.status)) return deployment;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${deploymentId}`);
}

/** Collect an SSE log stream until the `end` event. */
async function streamLogs(deploymentId) {
  const res = await fetch(`${API}/api/deployments/${deploymentId}/logs/stream`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const lines = [];
  let end = null;
  let buffer = "";
  while (!end) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = /^event: (.+)$/m.exec(raw)?.[1];
      const data = /^data: (.+)$/m.exec(raw)?.[1];
      if (event === "line") lines.push({ ...JSON.parse(data), receivedAt: Date.now() });
      if (event === "end") end = JSON.parse(data);
    }
  }
  return { lines, end };
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Orbit E2E", "-c", "user.email=e2e@orbit.local", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function makeRepo(name, files) {
  const dir = path.join(tmp, "repos", name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Initial commit");
  return dir;
}

function signedWebhook(payload) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  return fetch(`${API}/api/webhooks/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": signature },
    body,
  });
}

function start(name, script) {
  const child = spawn(path.join(API_DIR, "node_modules/.bin/tsx"), [script], {
    cwd: API_DIR,
    env: {
      ...process.env,
      NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
      ORBIT_DATA_DIR: dataDir,
      API_PORT: String(API_PORT),
      EDGE_PORT: String(EDGE_PORT),
      ORBIT_ALLOW_LOCAL_REPOS: "1",
      ORBIT_ADMIN_EMAIL: ADMIN.email,
      ORBIT_ADMIN_PASSWORD: ADMIN.password,
      ORBIT_DASHBOARD_URL: "http://localhost:3000",
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_TOKEN: "e2e-token",
      GITHUB_API_URL: `http://127.0.0.1:${GITHUB_PORT}`,
      ORBIT_BUILDER: process.env.ORBIT_BUILDER ?? "auto",
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(tmp, `${name}.log`));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push(child);
}

function cleanup() {
  for (const child of children) child.kill("SIGTERM");
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

/**
 * A stand-in for api.github.com: records commit statuses, reports one open PR for every branch
 * and keeps that PR's comments, so the GitHub integration can run end to end without a token.
 */
const github = { statuses: [], comments: [] };
const fakeGitHub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, "http://github");
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const status = /^\/repos\/([^/]+\/[^/]+)\/statuses\/(\w+)$/.exec(url.pathname);
    if (req.method === "POST" && status) return send(201, github.statuses.push({ repo: status[1], sha: status[2], ...body }));
    if (url.pathname.endsWith("/pulls")) return send(200, [{ number: 1 }]);
    if (req.method === "GET" && url.pathname.endsWith("/issues/1/comments")) return send(200, github.comments);
    if (req.method === "POST" && url.pathname.endsWith("/issues/1/comments"))
      return send(201, github.comments.push({ id: github.comments.length + 1, body: body.body }));
    const patch = /\/issues\/comments\/(\d+)$/.exec(url.pathname);
    if (req.method === "PATCH" && patch) {
      github.comments.find((c) => c.id === Number(patch[1])).body = body.body;
      return send(200, {});
    }
    send(404, { message: "Not Found" });
  });
});

// ----------------------------------------------------------------- fixtures

const demoRepo = path.join(tmp, "repos", "demo");
fs.cpSync(path.join(ROOT, "examples/orbit-demo-app"), demoRepo, {
  recursive: true,
  filter: (src) => !/[\\/](node_modules|dist)([\\/]|$)/.test(src),
});
git(demoRepo, "init", "-q", "-b", "main");
git(demoRepo, "add", "-A");
git(demoRepo, "commit", "-qm", "Initial commit");

const failingRepo = makeRepo("broken", {
  "package.json": JSON.stringify({ name: "broken", scripts: { build: "node build.js" } }),
  "build.js": "console.log('compiling...'); console.error('SyntaxError: Unexpected token in src/App.jsx'); process.exit(1);",
});

/** npm workspaces: apps/web depends on packages/greet, with one lockfile at the root. */
const monoRepo = makeRepo("mono", {
  "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*", "packages/*"] }),
  "packages/greet/package.json": JSON.stringify({ name: "@mono/greet", version: "1.0.0", main: "index.js" }),
  "packages/greet/index.js": "module.exports = (name) => `Hello from the greet package, ${name}`;",
  "apps/web/package.json": JSON.stringify({
    name: "@mono/web",
    version: "1.0.0",
    scripts: { build: "node build.js" },
    dependencies: { "@mono/greet": "*" },
  }),
  "apps/web/build.js":
    "const fs = require('fs'); const greet = require('@mono/greet');\n" +
    "fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.html', `<h1>${greet('web')}</h1>`);",
});
execFileSync("npm", ["install", "--offline", "--no-audit", "--no-fund", "--silent"], { cwd: monoRepo });
fs.rmSync(path.join(monoRepo, "node_modules"), { recursive: true, force: true });
git(monoRepo, "add", "-A");
git(monoRepo, "commit", "-qm", "Add lockfile");

const slowRepo = makeRepo("slow", {
  "package.json": JSON.stringify({
    name: "slow",
    scripts: { build: "node -e \"console.log('working'); setTimeout(() => {}, 120000)\"" },
  }),
});

// --------------------------------------------------------------------- run

async function main() {
  console.log(`Orbit e2e · data: ${dataDir}`);
  await new Promise((resolve) => fakeGitHub.listen(GITHUB_PORT, "127.0.0.1", resolve));
  start("api", "src/index.ts");
  start("edge", "src/edge.ts");
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${API}/api/health`);
      await edge("x");
      break;
    } catch {
      await sleep(500);
    }
  }
  console.log("Authentication");
  check("API requires sign-in", (await fetch(`${API}/api/projects`)).status === 401);
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  check("admin seeded from env can sign in", login.ok && cookie.startsWith("orbit_session="));
  const forged = await fetch(`${API}/api/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://evil.localhost:8180" },
    body: "{}",
  });
  check("cookie writes from other origins are blocked", forged.status === 403);
  const issued = await fetch(`${API}/api/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://localhost:3000" },
    body: JSON.stringify({ name: "e2e" }),
  }).then((r) => r.json());
  token = issued.token;
  check("API token issued", token?.startsWith("orbit_"));

  const config = await api("GET", "/api/config");
  console.log(`\nbuilder: ${config.builder}\n`);

  if (!OFFLINE) {
    console.log("Public GitHub repo: plain static HTML (mdn/beginner-html-site-styled)");
    const s = await api("POST", "/api/projects", {
      repoUrl: "https://github.com/mdn/beginner-html-site-styled",
      name: "mdn-static",
    });
    const sd = await waitFor(s.deployment.id);
    check("deployment ready", sd.status === "ready", sd.errorMessage ?? "");
    check("detected static framework", sd.framework === "static");
    const preview = await edge(sd.id);
    check("preview URL serves index.html", preview.status === 200 && /<title>/i.test(preview.body));
    check("production alias serves same deployment", (await edge("mdn-static")).headers["x-orbit-deployment"] === sd.id);
    check("css served with text/css", (await edge(sd.id, "/styles/style.css")).headers["content-type"]?.startsWith("text/css"));
    check(".git is never served", (await edge(sd.id, "/.git/config")).status === 404);

    console.log("\nGitHub integration (fake api.github.com)");
    await streamLogs(sd.id); // the log closes only after GitHub has been told the final state
    const statuses = github.statuses.filter((s) => s.repo === "mdn/beginner-html-site-styled");
    check(
      "commit status went pending -> success on the deployed commit",
      statuses.map((s) => s.state).join(",") === "pending,success" && statuses.every((s) => s.sha === sd.commitSha),
      JSON.stringify(statuses),
    );
    check("status is named after the project", statuses[0]?.context === "Orbit – mdn-static");
    check("success status links to the preview URL", statuses[1]?.target_url === `http://${sd.id}.localhost:${EDGE_PORT}`);
    check(
      "one PR comment, edited in place to Ready",
      github.comments.length === 1 && github.comments[0].body.includes("✅ Ready"),
    );
    check(
      "PR comment links the preview",
      github.comments[0]?.body.includes(`[Visit Preview](http://${sd.id}.localhost:${EDGE_PORT})`),
    );
    const ghLogs = (await api("GET", `/api/deployments/${sd.id}/logs`)).lines.map((l) => l.text);
    check(
      "GitHub activity shows in the build log",
      ghLogs.some((t) => t.includes("GitHub: updated preview comment")),
    );

    console.log("\nPublic GitHub repo: Vite + React (SafdarJamal/vite-template-react)");
    const v = await api("POST", "/api/projects", {
      repoUrl: "https://github.com/SafdarJamal/vite-template-react",
      name: "vite-react",
    });
    const vd = await waitFor(v.deployment.id);
    check("deployment ready", vd.status === "ready", vd.errorMessage ?? "");
    check("detected vite", vd.framework === "vite");
    const html = (await edge(vd.id)).body;
    const asset = /\/assets\/[^"]+\.js/.exec(html)?.[0];
    check("index.html references built assets", Boolean(asset));
    const js = await edge(vd.id, asset);
    check("hashed asset is immutable", js.headers["cache-control"] === "public, max-age=31536000, immutable");
    check("hashed asset has JS content type", js.headers["content-type"]?.startsWith("text/javascript"));
    check("SPA fallback for client routes", (await edge(vd.id, "/some/client/route", { accept: "text/html" })).body === html);
    check("missing asset is a real 404", (await edge(vd.id, "/assets/nope-AbC12345.js")).status === 404);
  }

  console.log("\nLocal repo: demo app (Vite + function) with live logs + env vars");
  const created = await api("POST", "/api/projects", {
    repoUrl: `file://${demoRepo}`,
    name: "demo",
    env: [
      { key: "VITE_MESSAGE", value: "Hello from env v1", targets: ["production", "preview"] },
      { key: "API_SECRET", value: "prod-only", targets: ["production"] },
    ],
  });
  const logs = await streamLogs(created.deployment.id);
  const first = await waitFor(created.deployment.id);
  check("SSE stream ends with status ready", logs.end?.status === "ready", JSON.stringify(logs.end));
  check("SSE delivered build output lines", logs.lines.some((l) => l.text.includes("vite")) && logs.lines.length > 10);
  check("SSE lines arrived live (before the build finished)", logs.lines[0].receivedAt < first.finishedAt);
  check(
    "SSE sequence numbers are contiguous",
    logs.lines.every((l, i) => l.seq === i),
  );
  const persisted = await api("GET", `/api/deployments/${first.id}/logs`);
  check("logs persisted for later viewing", persisted.lines.length === logs.lines.length);
  const replay = await streamLogs(first.id);
  check("SSE replays a finished build", replay.lines.length === logs.lines.length && replay.end.status === "ready");

  const demoHtml = (await edge("demo")).body;
  const demoJs = (await edge("demo", /\/assets\/[^"]+\.js/.exec(demoHtml)[0])).body;
  check("env var injected at build time", demoJs.includes("Hello from env v1"));
  check("system env (ORBIT_DEPLOYMENT_ID) injected", demoJs.includes(first.id));
  const fn = await edge("demo", "/api/hello?name=E2E");
  const fnJson = JSON.parse(fn.body || "{}");
  check("function /api/hello runs", fn.status === 200 && fnJson.message === "Hello, E2E!", fn.body);
  check("function sees production-only env", fnJson.secretConfigured === true && fnJson.environment === "production");
  check("SPA fallback for /about", (await edge("demo", "/about", { accept: "text/html" })).body === demoHtml);
  check("first build is a build-cache miss", first.cacheStatus === "miss", first.cacheStatus);

  console.log("\nvercel.json routing");
  const redirect = await edge("demo", "/old-about");
  check("redirect: /old-about -> 308 /about", redirect.status === 308 && redirect.headers.location === "/about");
  const rewritten = await edge("demo", "/hello/sagar");
  check(
    "rewrite: /hello/:name runs the function",
    JSON.parse(rewritten.body || "{}").message === "Hello, sagar!",
    rewritten.body,
  );
  const headered = await edge("demo", "/");
  check(
    "custom headers on every response",
    headered.headers["x-content-type-options"] === "nosniff" && headered.headers["x-powered-by"] === "Orbit",
  );
  check("vercel.json itself is not served", (await edge("demo", "/vercel.json", { accept: "application/json" })).status !== 200);

  console.log("\nPush-to-deploy: webhook push to a feature branch creates a preview");
  git(demoRepo, "checkout", "-qb", "feature/v2");
  const appFile = path.join(demoRepo, "src/App.jsx");
  fs.writeFileSync(appFile, fs.readFileSync(appFile, "utf8").replace('const VERSION = "v1"', 'const VERSION = "v2-preview"'));
  git(demoRepo, "commit", "-qam", "Ship v2");
  const sha = git(demoRepo, "rev-parse", "HEAD");
  git(demoRepo, "checkout", "-q", "main");
  const payload = {
    ref: "refs/heads/feature/v2",
    after: sha,
    repository: { clone_url: `file://${demoRepo}` },
    head_commit: { message: "Ship v2", author: { name: "Orbit E2E" } },
  };

  const bad = await fetch(`${API}/api/webhooks/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": "sha256=00" },
    body: JSON.stringify(payload),
  });
  check("webhook rejects a bad signature (401)", bad.status === 401);
  const hook = await (await signedWebhook(payload)).json();
  check("webhook creates one preview deployment", hook.deployments?.length === 1 && hook.deployments[0].target === "preview");
  const dupe = await (await signedWebhook(payload)).json();
  check("webhook redelivery is idempotent", dupe.deployments?.length === 0);
  const previewDeployment = await waitFor(hook.deployments[0].id);
  check("preview ready, pinned to pushed commit", previewDeployment.status === "ready" && previewDeployment.commitSha === sha);
  const previewJs = async (label) => {
    const page = await edge(label);
    const src = /\/assets\/[^"]+\.js/.exec(page.body)?.[0];
    return src ? (await edge(label, src)).body : "";
  };
  check("preview URL serves v2", (await previewJs(previewDeployment.id)).includes("v2-preview"));
  check("branch alias serves v2", (await previewJs("demo-git-feature-v2")).includes("v2-preview"));
  check("production still serves v1", !(await previewJs("demo")).includes("v2-preview"));
  const previewFn = JSON.parse((await edge(previewDeployment.id, "/api/hello")).body);
  check(
    "preview function does not get production-only env",
    previewFn.secretConfigured === false && previewFn.environment === "preview",
  );

  console.log("\nPromote and instant rollback");
  await api("POST", `/api/deployments/${previewDeployment.id}/promote`);
  check("promote: production now serves v2", (await edge("demo")).headers["x-orbit-deployment"] === previewDeployment.id);
  const t0 = performance.now();
  const rb = await api("POST", "/api/projects/demo/rollback", {});
  const rollbackMs = performance.now() - t0;
  const after = await edge("demo");
  check(
    `rollback: production back on v1 in ${rollbackMs.toFixed(0)}ms (no rebuild)`,
    rb.deployment.id === first.id && after.headers["x-orbit-deployment"] === first.id,
  );
  check("old preview URL still works after rollback (immutable)", (await edge(previewDeployment.id)).status === 200);
  const project = (await api("GET", "/api/projects/demo")).project;
  check("auto-promotion paused after rollback", project.autoPromotePaused === true);

  console.log("\nEnv var change + redeploy");
  await api("PUT", "/api/projects/demo/env/VITE_MESSAGE", { value: "Hello from env v2", targets: ["production", "preview"] });
  check("existing deployment is unchanged (immutable)", (await previewJs(first.id)).includes("Hello from env v1"));
  const redeploy = await api("POST", `/api/deployments/${first.id}/redeploy`);
  const redeployed = await waitFor(redeploy.deployment.id);
  check("redeploy builds the same commit", redeployed.status === "ready" && redeployed.commitSha === first.commitSha);
  check("redeploy picks up the new env value", (await previewJs(redeployed.id)).includes("Hello from env v2"));
  const redeployLogs = (await api("GET", `/api/deployments/${redeployed.id}/logs`)).lines.map((l) => l.text);
  check(
    "build cache hit: install skipped",
    redeployed.cacheStatus === "hit" && redeployLogs.some((t) => t.startsWith("Skipping install")),
    redeployed.cacheStatus,
  );
  console.log(
    `  build times: first ${(first.durationMs / 1000).toFixed(1)}s (cache miss) · redeploy ${(redeployed.durationMs / 1000).toFixed(1)}s (cache hit)`,
  );
  check("production not auto-assigned while paused", (await edge("demo")).headers["x-orbit-deployment"] === first.id);
  await api("POST", `/api/deployments/${redeployed.id}/promote`);
  check("manual promote resumes auto-promotion", (await api("GET", "/api/projects/demo")).project.autoPromotePaused === false);
  const fresh = await waitFor(
    (await api("POST", `/api/deployments/${redeployed.id}/redeploy`, { useCache: false })).deployment.id,
  );
  const freshLogs = (await api("GET", `/api/deployments/${fresh.id}/logs`)).lines.map((l) => l.text);
  check(
    "redeploy without cache runs a full install",
    fresh.status === "ready" && fresh.cacheStatus === "skipped" && freshLogs.some((t) => t.startsWith("Running install")),
  );

  console.log("\nFailing build");
  const broken = await api("POST", "/api/projects", { repoUrl: `file://${failingRepo}`, name: "broken" });
  const brokenDeployment = await waitFor(broken.deployment.id);
  check("status is error", brokenDeployment.status === "error");
  check(
    "error message names the failing command",
    /npm run build.*exited with 1/.test(brokenDeployment.errorMessage ?? ""),
    brokenDeployment.errorMessage,
  );
  const brokenLogs = await api("GET", `/api/deployments/${brokenDeployment.id}/logs`);
  check(
    "stderr captured in logs",
    brokenLogs.lines.some((l) => l.stream === "stderr" && l.text.includes("SyntaxError")),
  );
  check("edge shows failure page (502)", (await edge(brokenDeployment.id)).status === 502);
  check("no production alias for a failed first deploy", (await edge("broken")).status === 404);

  if (WITH_NEXT) {
    console.log("\nLocal repo: Next.js static export");
    const nextRepo = makeRepo("next-app", {
      "package.json": JSON.stringify({
        name: "next-app",
        private: true,
        scripts: { build: "next build" },
        dependencies: { next: "^16", react: "^19", "react-dom": "^19" },
      }),
      "next.config.mjs": 'export default { output: "export" };',
      "app/layout.js": 'export default function Layout({ children }) { return <html lang="en"><body>{children}</body></html>; }',
      "app/page.js": "export default function Home() { return <h1>Next on Orbit</h1>; }",
      "app/about/page.js": "export default function About() { return <h1>About page</h1>; }",
    });
    const next = await api("POST", "/api/projects", { repoUrl: `file://${nextRepo}`, name: "next-app" });
    const nd = await waitFor(next.deployment.id);
    check("Next.js deployment ready", nd.status === "ready" && nd.framework === "nextjs", nd.errorMessage ?? "");
    check("clean URL /about serves about.html", (await edge(nd.id, "/about")).body.includes("About page"));
    check("Next.js 404.html used for unknown routes", (await edge(nd.id, "/missing")).status === 404);
  }

  console.log("\nMonorepo (npm workspaces)");
  const mono = await api("POST", "/api/projects", { repoUrl: `file://${monoRepo}`, name: "mono-web", rootDirectory: "apps/web" });
  const md = await waitFor(mono.deployment.id);
  const monoLogs = (await api("GET", `/api/deployments/${md.id}/logs`)).lines.map((l) => l.text);
  check("monorepo app deployed", md.status === "ready", md.errorMessage ?? "");
  check(
    "installed from the workspace root",
    monoLogs.some((t) => t.startsWith("Monorepo: installing from the repository root")),
  );
  check("workspace dependency resolved at build time", (await edge(md.id)).body.includes("Hello from the greet package, web"));

  console.log("\nCancel a running build");
  const slow = await api("POST", "/api/projects", { repoUrl: `file://${slowRepo}`, name: "slow", installCommand: "" });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const lines = (await api("GET", `/api/deployments/${slow.deployment.id}/logs`)).lines;
    if (lines.some((l) => l.text.includes("working"))) break;
    await sleep(300);
  }
  await api("POST", `/api/deployments/${slow.deployment.id}/cancel`);
  const canceled = await waitFor(slow.deployment.id, ["canceled", "error", "ready"], 20_000);
  check("build canceled", canceled.status === "canceled");
  await sleep(500);
  let orphan = "";
  try {
    orphan = execFileSync("pgrep", ["-f", "setTimeout\\(\\(\\) => \\{\\}, 120000\\)"], { encoding: "utf8" });
  } catch {
    /* pgrep exits 1 when nothing matches */
  }
  check("build process tree was killed", orphan.trim() === "", orphan);
}

main()
  .catch((err) => {
    failed += 1;
    console.error("\n\x1b[31mE2E crashed:\x1b[0m", err);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed · logs in ${tmp}`);
    cleanup();
    fakeGitHub.close();
    process.exit(failed ? 1 : 0);
  });
