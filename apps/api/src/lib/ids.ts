import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Lowercase base36 so ids are valid DNS labels and can be used as subdomains. */
export function randomId(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export const DEPLOYMENT_ID_RE = /^dpl-[0-9a-z]{10}$/;

export function newDeploymentId(): string {
  return `dpl-${randomId(10)}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomId(12)}`;
}

/** Project names double as subdomains, so they must be DNS labels. */
export const PROJECT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

/** Names that would collide with dashboard routes or common infrastructure hostnames. */
const RESERVED_NAMES = new Set(["new", "api", "www", "app", "dashboard", "edge", "settings", "login", "setup", "logout"]);

export function isValidProjectName(name: string): boolean {
  return PROJECT_NAME_RE.test(name) && !name.startsWith("dpl-") && !name.includes("-git-") && !RESERVED_NAMES.has(name);
}
