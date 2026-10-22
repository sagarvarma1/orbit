import { z } from "zod";

/**
 * The routing subset of `vercel.json`: redirects, rewrites and headers. Rules are validated at
 * build time, stored in the deployment manifest and applied by the edge on every request.
 *
 * Sources use Vercel's path syntax: `/blog/:slug`, `/docs/:path*` (zero or more segments),
 * `/:path+` (one or more) and raw regex groups like `/(.*)`. Destinations can use `:name`
 * and `$1`-style references to what the source captured.
 */

const MAX_RULES = 1024;

const source = z.string().min(1).max(4096).startsWith("/", "must start with /");

const redirectRule = z.object({
  source,
  destination: z.string().min(1).max(4096),
  /** 308 when true (the default, like Vercel), 307 when false. */
  permanent: z.boolean().optional(),
  statusCode: z.union([z.literal(301), z.literal(302), z.literal(303), z.literal(307), z.literal(308)]).optional(),
});

const rewriteRule = z.object({
  source,
  destination: z
    .string()
    .min(1)
    .max(4096)
    .startsWith("/", "must be a path on this deployment (external rewrites are not supported)"),
});

const headerRule = z.object({
  source,
  headers: z
    .array(
      z.object({
        key: z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "is not a valid header name"),
        value: z.string().max(8192),
      }),
    )
    .min(1),
});

export const routingConfigSchema = z.object({
  redirects: z.array(redirectRule).max(MAX_RULES).default([]),
  rewrites: z.array(rewriteRule).max(MAX_RULES).default([]),
  headers: z.array(headerRule).max(MAX_RULES).default([]),
});

export type RoutingConfig = z.infer<typeof routingConfigSchema>;

export const ROUTING_CONFIG_FILE = "vercel.json";

/** Validate the routing part of a parsed vercel.json. Other keys are ignored. Throws a readable Error. */
export function parseRoutingConfig(json: unknown): RoutingConfig {
  const result = routingConfigSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`${issue.path.join(".")}: ${issue.message}`);
  }
  for (const rule of [...result.data.redirects, ...result.data.rewrites, ...result.data.headers]) {
    try {
      compileSource(rule.source);
    } catch (err) {
      throw new Error(`Invalid source "${rule.source}": ${(err as Error).message}`);
    }
  }
  return result.data;
}

export function hasRoutingRules(config: RoutingConfig | undefined): config is RoutingConfig {
  return Boolean(config && (config.redirects.length || config.rewrites.length || config.headers.length));
}

// ---------------------------------------------------------------- matching

interface CompiledSource {
  re: RegExp;
  /** Capture names in group order; null for anonymous `(...)` groups. */
  names: (string | null)[];
}

const escapeRegex = (s: string) => s.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");

/** Compile a Vercel-style source pattern into an anchored, case-insensitive RegExp. */
export function compileSource(pattern: string): CompiledSource {
  const names: (string | null)[] = [];
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === ":" && /[A-Za-z_]/.test(pattern[i + 1] ?? "")) {
      const name = /^[A-Za-z_]\w*/.exec(pattern.slice(i + 1))![0];
      i += 1 + name.length;
      let group = "[^/]+";
      if (pattern[i] === "(") {
        const end = closingParen(pattern, i);
        group = pattern.slice(i + 1, end);
        i = end + 1;
      }
      const modifier = /[*+?]/.test(pattern[i] ?? "") ? pattern[i++]! : "";
      // `/:path*` and `/:path?` also match when the segment (and its slash) is absent.
      const optionalSlash = re.endsWith("/") && (modifier === "*" || modifier === "?");
      if (optionalSlash) re = re.slice(0, -1);
      const body = modifier === "*" || modifier === "+" ? `${group}(?:/${group})*` : group;
      re += optionalSlash ? `(?:/(${body}))?` : modifier === "?" ? `(${body})?` : `(${body})`;
      names.push(name, ...Array<null>(groupCount(body)).fill(null));
    } else if (ch === "(") {
      const end = closingParen(pattern, i);
      const inner = pattern.slice(i + 1, end);
      if (inner.startsWith("?") && !inner.startsWith("?:")) throw new Error("named or lookaround groups are not supported");
      re += `(${inner})`;
      names.push(null, ...Array<null>(groupCount(inner)).fill(null));
      i = end + 1;
    } else if (ch === "\\" && i + 1 < pattern.length) {
      re += escapeRegex(pattern[i + 1]!);
      i += 2;
    } else {
      re += escapeRegex(ch);
      i += 1;
    }
  }
  if (!re.endsWith("/")) re += "/?";
  return { re: new RegExp(`^${re}$`, "i"), names };
}

/** Number of capturing groups in a regex source, so `$n` lines up even with nested groups. */
function groupCount(source: string): number {
  return new RegExp(`${source}|`).exec("")!.length - 1;
}

function closingParen(pattern: string, start: number): number {
  let depth = 0;
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === "\\") i++;
    else if (pattern[i] === "(") depth++;
    else if (pattern[i] === ")" && --depth === 0) return i;
  }
  throw new Error("unbalanced parentheses");
}

type Captures = { values: string[]; named: Record<string, string> };

function match(compiled: CompiledSource, urlPath: string): Captures | null {
  const m = compiled.re.exec(urlPath);
  if (!m) return null;
  const values = m.slice(1).map((v) => v ?? "");
  const named: Record<string, string> = {};
  compiled.names.forEach((name, i) => {
    if (name) named[name] = values[i] ?? "";
  });
  return { values, named };
}

/** Fill `:name`, `:name*` and `$1` references in a destination or header value. */
function substitute(template: string, captures: Captures): string {
  return template
    .replace(/\$(\d+)/g, (_, n: string) => captures.values[Number(n) - 1] ?? "")
    .replace(/:([A-Za-z_]\w*)[*+?]?/g, (whole, name: string) => (name in captures.named ? captures.named[name]! : whole));
}

/** Join a destination onto the request: internal paths get tidied slashes, original query params carry over. */
function resolveDestination(destination: string, requestUrl: URL): URL {
  const external = /^https?:\/\//i.test(destination);
  const target = new URL(external ? destination : destination.replace(/\/{2,}/g, "/"), requestUrl);
  for (const [key, value] of requestUrl.searchParams) if (!target.searchParams.has(key)) target.searchParams.append(key, value);
  return target;
}

export interface CompiledRouting {
  redirect(url: URL): { status: number; location: string } | null;
  /** The internal URL to serve instead, or null if no rewrite matches. */
  rewrite(url: URL): URL | null;
  headers(urlPath: string): Record<string, string>;
}

export function compileRouting(config: RoutingConfig): CompiledRouting {
  const redirects = config.redirects.map((r) => ({ ...r, compiled: compileSource(r.source) }));
  const rewrites = config.rewrites.map((r) => ({ ...r, compiled: compileSource(r.source) }));
  const headerRules = config.headers.map((r) => ({ ...r, compiled: compileSource(r.source) }));

  return {
    redirect(url) {
      for (const rule of redirects) {
        const captures = match(rule.compiled, url.pathname);
        if (!captures) continue;
        const target = resolveDestination(substitute(rule.destination, captures), url);
        const status = rule.statusCode ?? (rule.permanent === false ? 307 : 308);
        // Same-origin destinations stay relative so they work on every alias of the deployment.
        const location = target.origin === url.origin ? `${target.pathname}${target.search}` : target.toString();
        return { status, location };
      }
      return null;
    },
    rewrite(url) {
      for (const rule of rewrites) {
        const captures = match(rule.compiled, url.pathname);
        if (captures) return resolveDestination(substitute(rule.destination, captures), url);
      }
      return null;
    },
    headers(urlPath) {
      const out: Record<string, string> = {};
      for (const rule of headerRules) {
        const captures = match(rule.compiled, urlPath);
        if (!captures) continue;
        for (const { key, value } of rule.headers) out[key.toLowerCase()] = substitute(value, captures);
      }
      return out;
    },
  };
}
