"use client";

import { useParams } from "next/navigation";
import { useDeploymentAction } from "@/components/deployment-row";
import { LogViewer } from "@/components/log-viewer";
import { canRollbackTo, useProject } from "@/components/project-context";
import {
  Badge,
  BranchIcon,
  Button,
  Card,
  CommitIcon,
  ErrorNote,
  ExternalIcon,
  LinkButton,
  Spinner,
  StatusBadge,
} from "@/components/ui";
import { commitUrl, duration, FRAMEWORK_LABELS, hostOf, shortSha, timeAgo } from "@/lib/format";
import type { Deployment, Project } from "@/lib/types";
import { useApi } from "@/lib/use-api";

const CACHE_LABELS: Record<NonNullable<Deployment["cacheStatus"]>, string> = {
  hit: "Cache hit",
  miss: "Cache miss",
  skipped: "No cache",
};

const active = (d?: Deployment) => d?.status === "queued" || d?.status === "building";

export default function DeploymentPage() {
  const { id } = useParams<{ id: string }>();
  const { project, aliases, productionHistory, refresh: refreshProject } = useProject();
  const { data, error, refresh } = useApi<{ deployment: Deployment; project: Pick<Project, "id" | "name"> }>(
    `/api/deployments/${id}`,
    (d) => (active(d?.deployment) ? 1000 : 5000),
  );
  const actions = useDeploymentAction(project, async () => {
    await Promise.all([refresh(), refreshProject()]);
  });

  if (error)
    return (
      <div className="py-10">
        <ErrorNote>{error.message}</ErrorNote>
      </div>
    );
  if (!data)
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted">
        <Spinner /> Loading deployment…
      </div>
    );

  const d = data.deployment;
  const domains = [d.url, ...aliases.filter((a) => a.deploymentId === d.id).map((a) => a.url)];
  const canRollback = canRollbackTo(d, { project, productionHistory });
  const link = commitUrl(project.repoUrl, d.commitSha);

  return (
    <>
      <div className="flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight text-white">Deployment</h1>
            {d.isCurrentProduction && <Badge tone="info">Current Production</Badge>}
          </div>
          <div className="mt-2 font-mono text-sm text-muted">{d.id}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {active(d) && (
            <Button variant="danger" onClick={() => void actions.run("cancel", d)} loading={actions.pending === `cancel:${d.id}`}>
              Cancel
            </Button>
          )}
          {!active(d) && (
            <>
              <Button
                onClick={() => void actions.run("redeploy-no-cache", d)}
                loading={actions.pending === `redeploy-no-cache:${d.id}`}
              >
                Redeploy without Cache
              </Button>
              <Button onClick={() => void actions.run("redeploy", d)} loading={actions.pending === `redeploy:${d.id}`}>
                Redeploy
              </Button>
            </>
          )}
          {d.status === "ready" && !d.isCurrentProduction && (
            <Button
              onClick={() => void actions.run(canRollback ? "rollback" : "promote", d)}
              loading={actions.pending?.endsWith(d.id) && !actions.pending.startsWith("redeploy")}
            >
              {canRollback ? "Instant Rollback" : "Promote to Production"}
            </Button>
          )}
          {d.status === "ready" && (
            <LinkButton href={d.url} external variant="primary">
              Visit <ExternalIcon />
            </LinkButton>
          )}
        </div>
      </div>

      {actions.error && (
        <div className="mb-6">
          <ErrorNote>{actions.error}</ErrorNote>
        </div>
      )}
      {d.status === "error" && d.errorMessage && (
        <div className="mb-6">
          <ErrorNote>{d.errorMessage}</ErrorNote>
        </div>
      )}

      <Card className="mb-6 grid gap-6 p-6 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Info label="Status">
          <StatusBadge status={d.status} />
          {d.status === "queued" && d.queuePosition !== null && (
            <span className="text-xs text-muted">#{d.queuePosition + 1} in queue</span>
          )}
        </Info>
        <Info label="Environment">
          <span className="text-fg">{d.target === "production" ? "Production" : "Preview"}</span>
        </Info>
        <Info label="Duration">
          <span className="text-fg">{duration(d.durationMs)}</span>
          {d.cacheStatus && <Badge tone={d.cacheStatus === "hit" ? "ok" : "neutral"}>{CACHE_LABELS[d.cacheStatus]}</Badge>}
          {!d.cacheStatus && <span className="text-muted">{timeAgo(d.createdAt)}</span>}
        </Info>
        <Info label="Framework">
          <span className="text-fg">{d.framework ? FRAMEWORK_LABELS[d.framework] : "—"}</span>
          {d.builder && <Badge>{d.builder}</Badge>}
        </Info>
        <Info label="Domains" wide>
          <div className="min-w-0 space-y-1">
            {domains.map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 truncate text-fg hover:underline"
              >
                {hostOf(url)} <ExternalIcon />
              </a>
            ))}
          </div>
        </Info>
        <Info label="Source" wide>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-1.5 text-fg">
              <BranchIcon />
              <span className="font-mono text-xs">{d.branch}</span>
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-muted">
              <CommitIcon />
              {link ? (
                <a href={link} target="_blank" rel="noreferrer" className="font-mono text-xs hover:text-fg">
                  {shortSha(d.commitSha)}
                </a>
              ) : (
                <span className="font-mono text-xs">{shortSha(d.commitSha)}</span>
              )}
              <span className="truncate">{d.commitMessage ?? ""}</span>
            </div>
          </div>
        </Info>
      </Card>

      <LogViewer
        deploymentId={d.id}
        onEnd={() => {
          void refresh();
          void refreshProject();
        }}
      />
    </>
  );
}

function Info({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "min-w-0 sm:col-span-2" : "min-w-0"}>
      <div className="mb-1.5 text-xs text-muted">{label}</div>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}
