export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function duration(ms: number | null): string {
  if (ms === null) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : "—");

export const hostOf = (url: string) => url.replace(/^https?:\/\//, "");

/** "https://github.com/owner/repo.git" -> "owner/repo" */
export function repoName(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return m ? m[1]! : url.replace(/^file:\/\//, "");
}

export function repoWebUrl(url: string): string | null {
  const m = /^(https:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return m ? m[1]! : null;
}

export function commitUrl(repoUrl: string, sha: string | null): string | null {
  const web = repoWebUrl(repoUrl);
  return web && sha ? `${web}/commit/${sha}` : null;
}

export const FRAMEWORK_LABELS: Record<string, string> = {
  nextjs: "Next.js",
  astro: "Astro",
  "create-react-app": "Create React App",
  vite: "Vite",
  node: "Other",
  static: "Static",
};
