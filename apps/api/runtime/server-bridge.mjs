// Runs a Next.js standalone server inside a sandbox container and exposes it on the instance's
// unix socket, the only way in: the container's network reaches the internet but nothing reaches
// the container. The server listens on the container's own loopback; connections are piped through.
//
//   node server-bridge.mjs <server.js> <socket> <heap MB>
import { spawn } from "node:child_process";
import net from "node:net";

const [entry, socketPath, heapMb] = process.argv.slice(2);
const PORT = 3000;

const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, entry], {
  env: { ...process.env, PORT: String(PORT), HOSTNAME: "127.0.0.1", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));

function canConnect() {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

while (!(await canConnect())) await new Promise((r) => setTimeout(r, 25));

net
  .createServer((client) => {
    const upstream = net.connect(PORT, "127.0.0.1");
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
  })
  .listen(socketPath);
