"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import Link from "next/link";
import {
  Badge,
  BranchIcon,
  Button,
  Card,
  CommitIcon,
  ErrorNote,
  Input,
  Label,
  PageHeader,
  Select,
  Spinner,
} from "@/components/ui";
import { api } from "@/lib/api";
import { shortSha } from "@/lib/format";
import type { Deployment, FrameworkId, GitHubRepository, InspectResult, PlatformConfig, Project } from "@/lib/types";
import { useApi } from "@/lib/use-api";

const EXAMPLES = [
  { label: "Vite + React", url: "https://github.com/SafdarJamal/vite-template-react" },
  { label: "Static HTML", url: "https://github.com/mdn/beginner-html-site-styled" },
];

interface EnvRow {
  key: string;
  value: string;
}

/** Parses pasted .env content ("A=1\nB=2") into rows. */
function parseDotenv(text: string): EnvRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const [key, ...rest] = line.replace(/^export\s+/, "").split("=");
      return {
        key: key!.trim(),
        value: rest
          .join("=")
          .trim()
          .replace(/^(['"])(.*)\1$/, "$2"),
      };
    });
}

export default function NewProjectPage() {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<InspectResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function inspect(url: string, branch?: string, rootDirectory?: string) {
    setInspecting(true);
    setError(null);
    try {
      setInspection(await api<InspectResult>("/api/inspect", { method: "POST", body: { repoUrl: url, branch, rootDirectory } }));
    } catch (err) {
      setError((err as Error).message);
      setInspection(null);
    } finally {
      setInspecting(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (repoUrl.trim()) void inspect(repoUrl.trim());
  }

  return (
    <>
      <PageHeader title="Import a Git repository" subtitle="Pick a repository from GitHub, or paste the URL of a public one." />
      <div className="mx-auto max-w-3xl space-y-6 py-8">
        <RepositoryPicker
          onPick={(url) => {
            setRepoUrl(url);
            void inspect(url);
          }}
        />
        <Card className="p-6">
          <form onSubmit={onSubmit} className="flex gap-2">
            <Input
              autoFocus
              placeholder="https://github.com/owner/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
            <Button type="submit" variant="primary" loading={inspecting} disabled={!repoUrl.trim()}>
              Continue
            </Button>
          </form>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px] text-muted">
            Try an example:
            {EXAMPLES.map((ex) => (
              <button
                key={ex.url}
                type="button"
                onClick={() => {
                  setRepoUrl(ex.url);
                  void inspect(ex.url);
                }}
                className="rounded-full border border-line-strong px-3 py-1 text-fg hover:border-subtle"
              >
                {ex.label}
              </button>
            ))}
          </div>
          {error && (
            <div className="mt-4">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}
        </Card>

        {inspection && (
          <Configure
            key={`${inspection.repoUrl}@${inspection.branch}:${inspection.rootDirectory}`}
            inspection={inspection}
            onBranchChange={(branch) => void inspect(inspection.repoUrl, branch, inspection.rootDirectory)}
            onRootDirectoryChange={(dir) => void inspect(inspection.repoUrl, inspection.branch, dir)}
            onDeployed={(project, deployment) => router.push(`/${project.name}/deployments/${deployment.id}`)}
          />
        )}
      </div>
    </>
  );
}

function Configure({
  inspection,
  onBranchChange,
  onRootDirectoryChange,
  onDeployed,
}: {
  inspection: InspectResult;
  onBranchChange: (branch: string) => void;
  onRootDirectoryChange: (dir: string) => void;
  onDeployed: (project: Project, deployment: Deployment) => void;
}) {
  const s = inspection.settings;
  const [name, setName] = useState(inspection.suggestedName);
  const [framework, setFramework] = useState<FrameworkId>(s.framework);
  const [rootDirectory, setRootDirectory] = useState(inspection.rootDirectory === "." ? "" : inspection.rootDirectory);
  const [showBuild, setShowBuild] = useState(false);
  const [installCommand, setInstallCommand] = useState("");
  const [buildCommand, setBuildCommand] = useState("");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [env, setEnv] = useState<EnvRow[]>([{ key: "", value: "" }]);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = inspection.presets.find((p) => p.id === framework);
  const { data: config } = useApi<PlatformConfig>("/api/config");

  async function deploy() {
    setDeploying(true);
    setError(null);
    try {
      const result = await api<{ project: Project; deployment: Deployment }>("/api/projects", {
        method: "POST",
        body: {
          repoUrl: inspection.repoUrl,
          name,
          branch: inspection.branch,
          framework: framework === s.framework ? null : framework,
          rootDirectory: rootDirectory || ".",
          installCommand: installCommand || null,
          buildCommand: buildCommand || null,
          outputDirectory: outputDirectory || null,
          env: env
            .filter((r) => r.key.trim())
            .map((r) => ({ key: r.key.trim(), value: r.value, targets: ["production", "preview"] })),
        },
      });
      onDeployed(result.project, result.deployment);
    } catch (err) {
      setError((err as Error).message);
      setDeploying(false);
    }
  }

  function updateEnv(index: number, patch: Partial<EnvRow>) {
    setEnv((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  /** Pasting `KEY=value` lines (a whole .env file) into a key field fills in rows. */
  function pasteEnv(index: number, text: string): boolean {
    const parsed = parseDotenv(text);
    if (parsed.length === 0) return false;
    setEnv((rows) => [...rows.slice(0, index), ...parsed, ...rows.slice(index + 1)].filter((r) => r.key));
    return true;
  }

  return (
    <Card>
      <div className="border-b border-line p-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-lg font-medium text-white">{inspection.fullName ?? inspection.repoUrl}</span>
          <Badge tone="info">Detected: {s.frameworkName}</Badge>
          {s.packageManager && <Badge>{s.packageManager}</Badge>}
          {inspection.hasFunctions && <Badge tone="ok">api/ functions</Badge>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-[13px] text-muted">
          <span className="flex items-center gap-1.5">
            <BranchIcon />
            <select
              value={inspection.branch}
              onChange={(e) => onBranchChange(e.target.value)}
              className="bg-transparent font-mono text-xs text-fg outline-none"
            >
              {inspection.branches.map((b) => (
                <option key={b} value={b} className="bg-bg">
                  {b}
                </option>
              ))}
            </select>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <CommitIcon />
            <span className="font-mono text-xs">{shortSha(inspection.commit.sha)}</span>
            <span className="truncate">{inspection.commit.message}</span>
          </span>
        </div>
        {inspection.branch !== inspection.defaultBranch && (
          <p className="mt-3 text-[13px] text-warn">
            Production branch will be <span className="font-mono">{inspection.branch}</span>. Pushes to other branches create
            previews.
          </p>
        )}
      </div>

      <div className="space-y-5 p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label hint={`${name || "name"}.${config?.rootDomain ?? "localhost"}`}>Project Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
          </div>
          <div>
            <Label>Framework Preset</Label>
            <Select value={framework} onChange={(e) => setFramework(e.target.value as FrameworkId)}>
              {inspection.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <Label hint="For monorepos, e.g. apps/web. Leave empty for the repository root">Root Directory</Label>
          <Input
            placeholder="./"
            value={rootDirectory}
            onChange={(e) => setRootDirectory(e.target.value)}
            onBlur={() => {
              if ((rootDirectory || ".") !== inspection.rootDirectory) onRootDirectoryChange(rootDirectory || ".");
            }}
          />
          {s.workspaceRoot && (
            <p className="mt-2 text-xs text-muted">
              Monorepo detected: dependencies install from{" "}
              <span className="font-mono text-fg">{s.workspaceRoot === "." ? "the repository root" : s.workspaceRoot}</span>.
            </p>
          )}
        </div>

        <div className="rounded-md border border-line">
          <button
            type="button"
            onClick={() => setShowBuild((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-fg"
          >
            Build and Output Settings
            <span className="text-muted">{showBuild ? "−" : "+"}</span>
          </button>
          {showBuild && (
            <div className="space-y-4 border-t border-line p-4">
              <div>
                <Label hint="Override">Install Command</Label>
                <Input
                  placeholder={s.installCommand ?? "None"}
                  value={installCommand}
                  onChange={(e) => setInstallCommand(e.target.value)}
                  className="font-mono text-[13px]"
                />
              </div>
              <div>
                <Label hint="Override">Build Command</Label>
                <Input
                  placeholder={s.buildCommand ?? "None"}
                  value={buildCommand}
                  onChange={(e) => setBuildCommand(e.target.value)}
                  className="font-mono text-[13px]"
                />
              </div>
              <div>
                <Label hint="Override">Output Directory</Label>
                <Input
                  placeholder={framework === s.framework ? s.outputDirectory : (preset?.outputDirectory ?? "dist")}
                  value={outputDirectory}
                  onChange={(e) => setOutputDirectory(e.target.value)}
                  className="font-mono text-[13px]"
                />
              </div>
            </div>
          )}
        </div>

        <div className="rounded-md border border-line p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-medium text-fg">Environment Variables</span>
            <span className="text-xs text-subtle">Tip: paste a .env file into a key field</span>
          </div>
          <div className="space-y-2">
            {env.map((row, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  placeholder="EXAMPLE_KEY"
                  value={row.key}
                  onChange={(e) => updateEnv(i, { key: e.target.value })}
                  onPaste={(e) => pasteEnv(i, e.clipboardData.getData("text")) && e.preventDefault()}
                  className="w-2/5 font-mono text-[13px]"
                />
                <Input
                  placeholder="value"
                  value={row.value}
                  onChange={(e) => updateEnv(i, { value: e.target.value })}
                  className="font-mono text-[13px]"
                />
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => setEnv((rows) => (rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ key: "", value: "" }]))}
                  aria-label="Remove"
                >
                  ×
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => setEnv((rows) => [...rows, { key: "", value: "" }])}
          >
            Add Another
          </Button>
        </div>

        {s.warnings.map((w) => (
          <div key={w} className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] text-warn">
            {w}
          </div>
        ))}
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button variant="primary" className="h-11 w-full" loading={deploying} onClick={deploy} disabled={!name}>
          Deploy
        </Button>
      </div>
    </Card>
  );
}

/** Repositories the Orbit GitHub App can access, including private ones. */
function RepositoryPicker({ onPick }: { onPick: (url: string) => void }) {
  const { data: config } = useApi<PlatformConfig>("/api/config");
  const { data, error, loading } = useApi<{ repositories: GitHubRepository[] }>(
    config?.githubApp ? "/api/github/repositories" : null,
  );
  const [query, setQuery] = useState("");

  if (!config) return null;
  if (!config.githubApp) {
    return (
      <p className="rounded-md border border-line px-4 py-3 text-[13px] text-muted">
        To deploy private repositories and pick from a list,{" "}
        <Link href="/settings" className="text-fg underline underline-offset-2">
          connect GitHub
        </Link>
        .
      </p>
    );
  }
  const repos = (data?.repositories ?? []).filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  return (
    <Card>
      <div className="border-b border-line p-4">
        <Input placeholder="Search your repositories…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {error && (
        <div className="p-4">
          <ErrorNote>{error.message}</ErrorNote>
        </div>
      )}
      {loading && !data && (
        <p className="flex items-center gap-2 p-4 text-sm text-muted">
          <Spinner /> Loading repositories…
        </p>
      )}
      {data && repos.length === 0 && (
        <p className="p-4 text-sm text-muted">
          No repositories found. Install the GitHub App on more repositories in{" "}
          <Link href="/settings" className="text-fg underline underline-offset-2">
            Settings
          </Link>
          .
        </p>
      )}
      {repos.map((r) => (
        <div key={r.fullName} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
          <span className="truncate text-sm text-fg">{r.fullName}</span>
          {r.private && <Badge>Private</Badge>}
          <Button size="sm" variant="primary" className="ml-auto" onClick={() => onPick(r.url)}>
            Import
          </Button>
        </div>
      ))}
    </Card>
  );
}
