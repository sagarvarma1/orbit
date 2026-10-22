"use client";

import Link from "next/link";
import { useState } from "react";
import { BranchIcon, Card, ErrorNote, Input, LinkButton, PageHeader, StatusDot } from "@/components/ui";
import { FRAMEWORK_LABELS, hostOf, repoName, timeAgo } from "@/lib/format";
import type { Project } from "@/lib/types";
import { useApi } from "@/lib/use-api";

const isBusy = (p: Project) => p.latestDeployment?.status === "building" || p.latestDeployment?.status === "queued";

export default function ProjectsPage() {
  const { data, error, loading } = useApi<{ projects: Project[] }>("/api/projects", (d) =>
    d?.projects.some(isBusy) ? 1500 : 5000,
  );
  const [query, setQuery] = useState("");
  const projects = (data?.projects ?? []).filter((p) => p.name.includes(query.toLowerCase()) || p.repoUrl.includes(query));

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Every push gets a preview URL. Production is one click away, and so is rolling it back."
        actions={
          <LinkButton href="/new" variant="primary">
            Import Project
          </LinkButton>
        }
      />
      <div className="py-6">
        {error && <ErrorNote>Can&apos;t reach the Orbit API: {error.message}. Is the control plane running?</ErrorNote>}
        {data && data.projects.length > 0 && (
          <Input
            placeholder="Search projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mb-6 max-w-sm"
          />
        )}
        {loading && !data && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="h-40 animate-pulse" />
            ))}
          </div>
        )}
        {data && data.projects.length === 0 && <EmptyState />}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      </div>
    </>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const latest = project.latestDeployment;
  const framework = latest?.framework ?? project.framework;
  return (
    <Link href={`/${project.name}`} className="group">
      <Card className="flex h-full flex-col gap-4 p-5 transition-colors group-hover:border-line-strong group-hover:bg-raised">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line-strong bg-bg text-sm font-semibold uppercase text-white">
              {project.name[0]}
            </div>
            <div className="min-w-0">
              <div className="truncate font-medium text-white">{project.name}</div>
              <div className="truncate text-[13px] text-muted">
                {project.production ? hostOf(project.productionUrl) : "No production deployment"}
              </div>
            </div>
          </div>
          {framework && (
            <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">
              {FRAMEWORK_LABELS[framework]}
            </span>
          )}
        </div>
        <div className="truncate text-[13px] text-subtle">{repoName(project.repoUrl)}</div>
        {latest && (
          <div className="mt-auto space-y-1.5 border-t border-line pt-4 text-[13px]">
            <div className="flex items-center gap-2 text-fg">
              <StatusDot status={latest.status} />
              <span className="truncate">{latest.commitMessage ?? "Deployment"}</span>
            </div>
            <div className="flex items-center gap-1.5 text-muted">
              {timeAgo(latest.createdAt)} on <BranchIcon /> <span className="truncate font-mono text-xs">{latest.branch}</span>
            </div>
          </div>
        )}
      </Card>
    </Link>
  );
}

function EmptyState() {
  return (
    <Card className="flex flex-col items-center gap-4 px-6 py-20 text-center">
      <div className="text-lg font-medium text-white">Deploy your first project</div>
      <p className="max-w-md text-sm text-muted">
        Import a public GitHub repository. Orbit detects the framework, builds it, and gives you a preview URL in seconds.
      </p>
      <LinkButton href="/new" variant="primary">
        Import a repository
      </LinkButton>
    </Card>
  );
}
