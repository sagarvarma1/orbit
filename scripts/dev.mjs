#!/usr/bin/env node
/**
 * `pnpm dev`: runs the control plane, edge and dashboard together without Docker.
 * Reads ./.env if present (see .env.example). Builds run as child processes unless Docker
 * is available and ORBIT_BUILDER allows it.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDotenv(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

const env = {
  ORBIT_DATA_DIR: path.join(ROOT, "data"),
  NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
  NEXT_TELEMETRY_DISABLED: "1",
  // The dashboard and API run on separate ports here, so GitHub sign-in returns to the API directly.
  ORBIT_API_PUBLIC_URL: "http://localhost:4000",
  ...loadDotenv(path.join(ROOT, ".env")),
  ...process.env,
};

const services = [
  { name: "api", color: 36, args: ["--filter", "@orbit/api", "dev"] },
  { name: "edge", color: 35, args: ["--filter", "@orbit/api", "dev:edge"] },
  { name: "web", color: 33, args: ["--filter", "@orbit/dashboard", "dev"] },
];

const children = services.map(({ name, color, args }) => {
  const child = spawn("pnpm", ["--silent", ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `\x1b[${color}m${name.padEnd(4)}\x1b[0m │ `;
  for (const stream of [child.stdout, child.stderr]) {
    let partial = "";
    stream.setEncoding("utf8").on("data", (chunk) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop();
      for (const line of lines) process.stdout.write(prefix + line + "\n");
    });
  }
  child.on("exit", (code) => {
    process.stdout.write(`${prefix}exited with ${code}\n`);
    shutdown(code ?? 1);
  });
  return child;
});

const port = env.EDGE_PORT ?? "8080";
console.log(`
  \x1b[1mOrbit\x1b[0m  dev
  Dashboard   http://localhost:3000
  API         http://localhost:${env.API_PORT ?? "4000"}
  Edge        http://<deployment>.localhost:${port}  ·  http://<project>.localhost:${port}
  Data        ${env.ORBIT_DATA_DIR}
`);

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
