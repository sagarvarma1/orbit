import { execFileSync } from "node:child_process";
import { BLOCKED_V4 } from "../lib/sandbox.js";

/** The Linux bridge sandbox containers attach to (fixed, so firewall rules can name it). */
export const SANDBOX_BRIDGE = "orbit-sbx0";
export const SANDBOX_NETWORK = "orbit-sandbox";

const FORWARD_CHAIN = "ORBIT-SANDBOX";
const INPUT_CHAIN = "ORBIT-SANDBOX-IN";

/**
 * Host firewall for sandbox containers, as iptables argument lists (exported for tests). Like a
 * Vercel function, sandboxed code reaches the public internet and nothing else:
 *
 * - Forwarded traffic from the sandbox bridge to private ranges (other containers, Orbit's API,
 *   the LAN, the cloud metadata endpoint) is rejected. Docker's DOCKER-USER chain runs before its
 *   own rules, so this also covers published ports, except 80/443: traffic Docker translated to a
 *   published HTTP(S) port is Caddy, the platform's public entry, which deployments may call like
 *   any website (a function fetching another deployment, or the Blob API).
 * - Traffic to the host itself (sshd, the Docker API, anything listening) is rejected.
 * - Containers can't reach each other: the network is created with inter-container traffic off.
 */
export function sandboxFirewallRules(): string[][] {
  const rules: string[][] = [
    ["-N", FORWARD_CHAIN],
    ["-F", FORWARD_CHAIN],
    ["-A", FORWARD_CHAIN, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "RETURN"],
    ["-A", FORWARD_CHAIN, "-p", "tcp", "-m", "conntrack", "--ctstate", "DNAT", "--ctorigdstport", "443", "-j", "ACCEPT"],
    ["-A", FORWARD_CHAIN, "-p", "tcp", "-m", "conntrack", "--ctstate", "DNAT", "--ctorigdstport", "80", "-j", "ACCEPT"],
  ];
  for (const net of BLOCKED_V4) rules.push(["-A", FORWARD_CHAIN, "-d", net, "-j", "REJECT"]);
  rules.push(
    ["-D", "DOCKER-USER", "-i", SANDBOX_BRIDGE, "-j", FORWARD_CHAIN],
    ["-I", "DOCKER-USER", "-i", SANDBOX_BRIDGE, "-j", FORWARD_CHAIN],
    ["-N", INPUT_CHAIN],
    ["-F", INPUT_CHAIN],
    ["-A", INPUT_CHAIN, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
    ["-A", INPUT_CHAIN, "-j", "REJECT"],
    ["-D", "INPUT", "-i", SANDBOX_BRIDGE, "-j", INPUT_CHAIN],
    ["-I", "INPUT", "-i", SANDBOX_BRIDGE, "-j", INPUT_CHAIN],
  );
  return rules;
}

function run(binary: string, args: string[]): void {
  execFileSync(binary, ["-w", ...args], { stdio: "pipe" });
}

/**
 * Docker's rules may live in the legacy or the nftables backend; ours must go in the same one,
 * where DOCKER-USER exists.
 */
function findBackend(): string | null {
  for (const binary of ["iptables", "iptables-nft", "iptables-legacy"]) {
    try {
      run(binary, ["-n", "-L", "DOCKER-USER"]);
      return binary;
    } catch {
      // not this one
    }
  }
  return null;
}

/** Installs the rules. Needs the host's network namespace and NET_ADMIN. */
export function installSandboxFirewall(): { ok: boolean; detail: string } {
  const binary = findBackend();
  if (!binary) return { ok: false, detail: "Docker's DOCKER-USER chain wasn't found (needs network_mode: host and NET_ADMIN)" };
  try {
    for (const args of sandboxFirewallRules()) {
      try {
        run(binary, args);
      } catch (err) {
        // "-N" on an existing chain and "-D" of a missing rule are expected to fail.
        if (args[0] !== "-N" && args[0] !== "-D") throw err;
      }
    }
    return { ok: true, detail: `private networks and the host blocked for sandboxes (${binary})` };
  } catch (err) {
    const message = String((err as { stderr?: Buffer }).stderr ?? (err as Error).message)
      .trim()
      .split("\n")[0];
    return { ok: false, detail: message || "iptables failed" };
  }
}
