#!/usr/bin/env node
/**
 * End-to-end test: boots a real control plane + edge on spare ports with a temp data dir,
 * deploys real public GitHub repos and local fixture repos, and checks everything over HTTP.
 * Nothing is mocked: real git clone, real npm install, real builds, real serving.
 *
 *   node scripts/e2e.mjs            # full run
 *   node scripts/e2e.mjs --offline  # skip the public GitHub repos
 *   node scripts/e2e.mjs --next     # also build a Next.js static-export app (~150 MB install)
 *   node scripts/e2e.mjs --containers  # run deployment code in sandbox containers via sandboxd
 *                                      # (Linux, root, Docker socket; see scripts/sandbox-test.sh)
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
const CONTAINERS = process.argv.includes("--containers");
const API = `http://127.0.0.1:${API_PORT}`;
const GITHUB_PORT = 4199;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-e2e-"));
// Run as root on Linux, deployment code runs as per-project users, who must be able to reach the data dir.
fs.chmodSync(tmp, 0o755);
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

/** Any method, with a body, to the edge (or to blob.localhost when host is "blob"). */
function edgeRequest(method, host, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: EDGE_PORT,
        method,
        path: urlPath,
        headers: { host: `${host}.localhost:${EDGE_PORT}`, ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
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
      ...(CONTAINERS
        ? { ORBIT_SANDBOX: "container", ORBIT_RUNTIME_IMAGE: process.env.ORBIT_RUNTIME_IMAGE ?? "orbit-runtime:dev" }
        : {}),
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
    // Comment calls answer slowly, like the real API, so the log stream must wait for them.
    const delay = url.pathname.includes("/comments") ? 300 : 0;
    const send = (status, data) =>
      setTimeout(() => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      }, delay);
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

/** A static site with a function that a cron job calls every minute. */
const cronRepo = makeRepo("cron", {
  "index.html": "<h1>cron</h1>",
  "api/tick.js":
    "export function GET(req) { return Response.json({ auth: req.headers.get('authorization'), ua: req.headers.get('user-agent') }); }",
  "vercel.json": JSON.stringify({ crons: [{ path: "/api/tick", schedule: "* * * * *" }] }),
});
/** Python functions: a Flask app from requirements.txt, a BaseHTTPRequestHandler and a dynamic route. */
const pythonRepo = makeRepo("python", {
  "index.html": "<h1>python</h1>",
  "requirements.txt": "flask==3.1.0\n",
  "api/flask.py":
    "from flask import Flask, jsonify, request\nfrom _lib.util import shout\napp = Flask(__name__)\n\n" +
    "@app.route('/api/flask', methods=['GET', 'POST'])\ndef index():\n" +
    "    return jsonify(method=request.method, name=shout(request.args.get('name', 'nobody')))\n",
  "api/_lib/util.py": "def shout(s):\n    return s.upper()\n",
  "api/hello.py":
    "import os\nfrom http.server import BaseHTTPRequestHandler\n\nclass handler(BaseHTTPRequestHandler):\n" +
    "    def do_GET(self):\n        self.send_response(200)\n        self.send_header('content-type', 'text/plain')\n" +
    "        self.end_headers()\n        self.wfile.write(('hello from python ' + os.environ.get('ORBIT_ENV', '')).encode())\n",
  "api/items/[id].py":
    "from urllib.parse import parse_qs\n\ndef app(environ, start_response):\n" +
    "    start_response('200 OK', [('content-type', 'text/plain')])\n" +
    "    return [('item ' + parse_qs(environ['QUERY_STRING'])['id'][0]).encode()]\n",
});

/** Uses the real @vercel/blob SDK from a function: server uploads, and browser uploads via handleUpload. */
const blobRepo = makeRepo("blob", {
  "index.html": "<h1>blob</h1>",
  "package.json": JSON.stringify({ name: "blob-app", private: true, dependencies: { "@vercel/blob": "2.8.2" } }),
  "api/upload.mjs": `import { put, list } from "@vercel/blob";
export async function POST(request) {
  const blob = await put("e2e/note.txt", await request.text(), { access: "public", allowOverwrite: true });
  const listed = await list({ prefix: "e2e/" });
  return Response.json({ url: blob.url, count: listed.blobs.length });
}`,
  "api/handle-upload.mjs": `import { handleUpload } from "@vercel/blob/client";
import { put } from "@vercel/blob";
export async function POST(request) {
  const body = await request.json();
  const result = await handleUpload({
    body,
    request,
    onBeforeGenerateToken: async () => ({ allowedContentTypes: ["text/plain"], tokenPayload: JSON.stringify({ user: "e2e" }) }),
    onUploadCompleted: async ({ blob, tokenPayload }) => {
      await put("e2e/completed.json", JSON.stringify({ url: blob.url, tokenPayload }), { access: "public", allowOverwrite: true });
    },
  });
  return Response.json(result);
}`,
});

const badCronRepo = makeRepo("bad-cron", {
  "index.html": "<h1>bad cron</h1>",
  "vercel.json": JSON.stringify({ crons: [{ path: "/api/tick", schedule: "0 5 * * MON" }] }),
});

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
  if (CONTAINERS) start("sandboxd", "src/sandboxd.ts");
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
  if (CONTAINERS) {
    let connected = false;
    for (let i = 0; i < 120 && !connected; i++) {
      connected = fs.readFileSync(path.join(tmp, "edge.log"), "utf8").includes("connected to sandboxd");
      if (!connected) await sleep(500);
    }
    console.log("Sandbox containers");
    check("edge connected to sandboxd", connected, fs.readFileSync(path.join(tmp, "sandboxd.log"), "utf8").slice(-1500));
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

  console.log("\nCron jobs");
  const cronApp = await api("POST", "/api/projects", {
    repoUrl: `file://${cronRepo}`,
    name: "cron",
    env: [{ key: "CRON_SECRET", value: "e2e-cron-secret", targets: ["production"] }],
  });
  const cronDeployment = await waitFor(cronApp.deployment.id);
  check("cron app deployed", cronDeployment.status === "ready", cronDeployment.errorMessage ?? "");
  const cronLogs = (await api("GET", `/api/deployments/${cronDeployment.id}/logs`)).lines.map((l) => l.text);
  check(
    "build log lists the cron jobs",
    cronLogs.some((t) => t.includes("Cron jobs from vercel.json: /api/tick (* * * * *)")),
  );
  const cronList = await api("GET", "/api/projects/cron/crons");
  check(
    "jobs listed from the production deployment with a next run",
    cronList.deploymentId === cronDeployment.id && cronList.jobs.length === 1 && cronList.jobs[0].nextRunAt > Date.now(),
    JSON.stringify(cronList.jobs),
  );
  const { run: manualRun } = await api("POST", "/api/projects/cron/crons/run", { path: "/api/tick", schedule: "* * * * *" });
  const manualOut = JSON.parse(manualRun.output || "{}");
  check("Run calls the job's path through the edge", manualRun.status === "success" && manualRun.statusCode === 200);
  check(
    "cron requests carry Bearer $CRON_SECRET and the cron user agent",
    manualOut.auth === "Bearer e2e-cron-secret" && manualOut.ua === "vercel-cron/1.0",
    manualRun.output,
  );
  const badCron = await api("POST", "/api/projects", { repoUrl: `file://${badCronRepo}`, name: "bad-cron" });
  const badCronDeployment = await waitFor(badCron.deployment.id);
  check(
    "an invalid schedule fails the build",
    badCronDeployment.status === "error" && /crons\.0\.schedule/.test(badCronDeployment.errorMessage ?? ""),
    badCronDeployment.errorMessage ?? "",
  );

  console.log("\nPython functions");
  const pyApp = await api("POST", "/api/projects", { repoUrl: `file://${pythonRepo}`, name: "python" });
  const pyDeployment = await waitFor(pyApp.deployment.id);
  check("Python app deployed", pyDeployment.status === "ready", pyDeployment.errorMessage ?? "");
  const pyLogs = (await api("GET", `/api/deployments/${pyDeployment.id}/logs`)).lines.map((l) => l.text);
  check(
    "requirements.txt installed",
    pyLogs.some((t) => t.startsWith("Installed Python dependencies")),
  );
  const flask = await edge("python", "/api/flask?name=orbit");
  check(
    "Flask (WSGI) app from requirements.txt serves requests",
    flask.status === 200 && JSON.parse(flask.body || "{}").name === "ORBIT",
    `${flask.status} ${flask.body.slice(0, 300)}`,
  );
  const pyHandler = await edge("python", "/api/hello");
  check("BaseHTTPRequestHandler function runs with env", pyHandler.body === "hello from python production", pyHandler.body);
  check("dynamic Python route gets its segment in the query", (await edge("python", "/api/items/7")).body === "item 7");
  check("Python sources aren't served as static files", (await edge("python", "/api/flask.py")).status !== 200);
  const pyRedeploy = await api("POST", `/api/deployments/${pyDeployment.id}/redeploy`, {});
  await waitFor(pyRedeploy.deployment.id);
  const pyRedeployLogs = (await api("GET", `/api/deployments/${pyRedeploy.deployment.id}/logs`)).lines.map((l) => l.text);
  check(
    "Python dependencies restored from the build cache on redeploy",
    pyRedeployLogs.some((t) => t.startsWith("Restored Python dependencies from build cache")),
  );

  console.log("\nBlob storage (@vercel/blob SDK)");
  const { store } = await api("POST", "/api/blob-stores", { name: "e2e uploads" });
  check("blob store created with a Vercel-format token", store.token?.startsWith(`vercel_blob_rw_${store.id}_`));
  const blobApp = await api("POST", "/api/projects", { repoUrl: `file://${blobRepo}`, name: "blobapp" });
  await waitFor(blobApp.deployment.id);
  await api("PUT", `/api/blob-stores/${store.id}/connections/blobapp`, { targets: ["production", "preview"] });
  // Like Vercel, a connected store's token reaches the next deployment.
  const blobRedeploy = await api("POST", `/api/deployments/${blobApp.deployment.id}/redeploy`, {});
  const blobDeployment = await waitFor(blobRedeploy.deployment.id);
  check("blob app deployed with the store connected", blobDeployment.status === "ready", blobDeployment.errorMessage ?? "");
  // In sandbox containers, blob.localhost is the container's own loopback; on a server blob.<root>
  // is a public hostname. So functions calling Blob are only checked in process mode.
  if (!CONTAINERS) {
    const uploaded = await edgeRequest("POST", "blobapp", "/api/upload", { body: "hello from a function" });
    const uploadedJson = JSON.parse(uploaded.body || "{}");
    check(
      "a function uploads with put() and lists with list()",
      uploaded.status === 200 && uploadedJson.count === 1,
      uploaded.body.slice(0, 300),
    );
    const blobPath = uploadedJson.url ? new URL(uploadedJson.url).pathname : "/";
    const served = await edgeRequest("GET", "blob", blobPath);
    check(
      "the blob is served from blob.<root>",
      served.status === 200 && served.body === "hello from a function",
      `${served.status}`,
    );
    const tokenRes = await edgeRequest("POST", "blobapp", "/api/handle-upload", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "blob.generate-client-token",
        payload: { pathname: "e2e/client.txt", clientPayload: null, multipart: false },
      }),
    });
    const clientToken = JSON.parse(tokenRes.body || "{}").clientToken ?? "";
    check(
      "handleUpload issues a client token",
      clientToken.startsWith(`vercel_blob_client_${store.id}_`),
      tokenRes.body.slice(0, 300),
    );
    const browserPut = await edgeRequest("PUT", "blob", "/api/?pathname=e2e%2Fclient.txt", {
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-vercel-blob-access": "public",
        "x-content-type": "text/plain",
        "x-api-version": "13",
        origin: "http://blobapp.localhost",
      },
      body: "uploaded from the browser",
    });
    check("a browser upload with the client token succeeds", browserPut.status === 200, browserPut.body.slice(0, 300));
    check("blob API allows browser origins (CORS)", browserPut.headers["access-control-allow-origin"] === "*");
    let completed = null;
    for (let i = 0; i < 40 && !completed; i++) {
      const res = await edgeRequest("GET", "blob", `/${store.id}/e2e/completed.json`);
      if (res.status === 200) completed = JSON.parse(res.body);
      else await sleep(250);
    }
    check(
      "onUploadCompleted runs with the signed callback",
      completed?.tokenPayload === JSON.stringify({ user: "e2e" }) && completed?.url?.endsWith("/e2e/client.txt"),
      JSON.stringify(completed),
    );
  }

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

    console.log("\nLocal repo: Next.js with server rendering");
    const page = (version) =>
      'import { headers } from "next/headers";\nexport const dynamic = "force-dynamic";\n' +
      "export default async function Home() {\n" +
      "  const host = (await headers()).get('host');\n" +
      `  return <main><h1>SSR ${version}</h1><p id="t">{Date.now()}</p><p id="host">{host}</p><p id="env">{process.env.GREETING}</p></main>;\n}`;
    const ssrRepo = makeRepo("next-ssr", {
      "package.json": JSON.stringify({
        name: "next-ssr",
        private: true,
        scripts: { build: "next build" },
        dependencies: { next: "^16", react: "^19", "react-dom": "^19" },
      }),
      "app/layout.js": 'export default function Layout({ children }) { return <html lang="en"><body>{children}</body></html>; }',
      "app/page.js": page("v1"),
      "app/static/page.js": "export default function Static() { return <h1>Prerendered page</h1>; }",
      "app/api/time/route.js":
        'export const dynamic = "force-dynamic";\nexport function GET(req) { return Response.json({ now: Date.now(), path: new URL(req.url).pathname }); }',
      "public/hello.txt": "hello from public",
    });
    const ssr = await api("POST", "/api/projects", {
      repoUrl: `file://${ssrRepo}`,
      name: "next-ssr",
      env: [{ key: "GREETING", value: "hi from runtime env", targets: ["production", "preview"] }],
    });
    const sd1 = await waitFor(ssr.deployment.id);
    check("SSR deployment ready", sd1.status === "ready" && sd1.framework === "nextjs", sd1.errorMessage ?? "");
    const ssrLogs = (await api("GET", `/api/deployments/${sd1.id}/logs`)).lines.map((l) => l.text);
    check(
      "build log says server rendering",
      ssrLogs.some((t) => t.includes("Next.js: server rendering")),
    );
    const r1 = await edge("next-ssr");
    const r2 = await edge("next-ssr");
    const stamp = (r) => /<p id="t">(\d+)/.exec(r.body)?.[1];
    check("page rendered by the server", r1.status === 200 && r1.body.includes("SSR v1"), r1.body.slice(0, 200));
    check(
      "first request starts the server, the next one reuses it",
      r1.headers["x-orbit-instance"] === "cold" && r2.headers["x-orbit-instance"] === "warm",
    );
    check("rendered fresh on every request", stamp(r1) && stamp(r2) && stamp(r1) !== stamp(r2));
    check("server sees the request's host", r1.body.includes(`next-ssr.localhost:${EDGE_PORT}`));
    check("server sees deployment env vars", r1.body.includes("hi from runtime env"));
    check("prerendered page served", (await edge("next-ssr", "/static")).body.includes("Prerendered page"));
    const time = await edge("next-ssr", "/api/time");
    check("route handler runs", time.status === 200 && JSON.parse(time.body || "{}").path === "/api/time", time.body);
    const pub = await edge("next-ssr", "/hello.txt");
    check("public/ files served by the edge", pub.body.trim() === "hello from public" && !pub.headers["x-orbit-instance"]);
    const asset = /\/_next\/static\/[^"]+\.js/.exec(r1.body)?.[0];
    const assetRes = asset ? await edge("next-ssr", asset) : null;
    check(
      "_next/static assets served by the edge, immutable",
      assetRes?.status === 200 && assetRes.headers["cache-control"] === "public, max-age=31536000, immutable",
      asset ?? "no asset",
    );
    check("unknown routes get the app's 404", (await edge("next-ssr", "/nope")).status === 404);

    fs.writeFileSync(path.join(ssrRepo, "app/page.js"), page("v2"));
    git(ssrRepo, "commit", "-qam", "SSR v2");
    const ssrHook = await (
      await signedWebhook({
        ref: "refs/heads/main",
        after: git(ssrRepo, "rev-parse", "HEAD"),
        repository: { clone_url: `file://${ssrRepo}` },
        head_commit: { message: "SSR v2", author: { name: "Orbit E2E" } },
      })
    ).json();
    const sd2 = await waitFor(ssrHook.deployments[0].id);
    check("second SSR deployment ready", sd2.status === "ready", sd2.errorMessage ?? "");
    check("production now renders v2", (await edge("next-ssr")).body.includes("SSR v2"));
    check("the old deployment still renders v1 (immutable)", (await edge(sd1.id)).body.includes("SSR v1"));
    await api("POST", "/api/projects/next-ssr/rollback", {});
    check("rollback switches production back to v1", (await edge("next-ssr")).body.includes("SSR v1"));
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

  if (CONTAINERS) {
    const sandboxLog = fs.readFileSync(path.join(tmp, "sandboxd.log"), "utf8");
    check("Node.js functions ran in sandbox containers", /\[dpl-[a-z0-9]+ \/api\/hello\.mjs\] started/.test(sandboxLog));
    check("Python functions ran in sandbox containers", /\[dpl-[a-z0-9]+ \/api\/flask\.py\] started/.test(sandboxLog));
  }

  // The cron app was deployed minutes ago, so its every-minute job has had a chance to run.
  console.log("\nCron jobs (on schedule)");
  let scheduled = null;
  const cronDeadline = Date.now() + 75_000;
  while (!scheduled && Date.now() < cronDeadline) {
    scheduled = (await api("GET", "/api/projects/cron/crons")).runs.find(
      (r) => r.trigger === "schedule" && r.status !== "running",
    );
    if (!scheduled) await sleep(2000);
  }
  check("an every-minute job ran on schedule", scheduled?.status === "success", JSON.stringify(scheduled));
  check("scheduled runs are for a whole UTC minute", scheduled ? scheduled.scheduledAt % 60_000 === 0 : false);
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
