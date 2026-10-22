"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { commitUrl, duration, shortSha, timeAgo } from "@/lib/format";
import type { Deployment, Project } from "@/lib/types";
import { Badge, BranchIcon, CommitIcon, StatusDot, cx } from "./ui";

const TRIGGER_LABEL: Record<Deployment["trigger"], string> = {
  import: "import",
  redeploy: "redeploy",
  webhook: "git push",
  poll: "git push",
  manual: "manual",
};

export type DeploymentAction = "promote" | "rollback" | "redeploy" | "redeploy-no-cache" | "cancel";

/** Runs a deployment action against the API and reports the result. */
export function useDeploymentAction(project: Project, onDone: () => Promise<void> | void) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: DeploymentAction, deployment: Deployment) {
    setPending(`${action}:${deployment.id}`);
    setError(null);
    try {
      if (action === "rollback") {
        await api(`/api/projects/${project.name}/rollback`, { method: "POST", body: { deploymentId: deployment.id } });
      } else if (action === "redeploy" || action === "redeploy-no-cache") {
        const { deployment: next } = await api<{ deployment: Deployment }>(`/api/deployments/${deployment.id}/redeploy`, {
          method: "POST",
          body: { useCache: action === "redeploy" },
        });
        router.push(`/${project.name}/deployments/${next.id}`);
      } else {
        await api(`/api/deployments/${deployment.id}/${action}`, { method: "POST" });
      }
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(null);
    }
  }

  return { run, pending, error, clearError: () => setError(null) };
}

export function DeploymentMenu({
  deployment,
  canRollback,
  onAction,
}: {
  deployment: Deployment;
  canRollback: boolean;
  onAction: (action: DeploymentAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const ready = deployment.status === "ready";
  const items: { label: string; action?: DeploymentAction; href?: string; show: boolean; danger?: boolean }[] = [
    { label: "Visit", href: deployment.url, show: ready },
    { label: "Promote to Production", action: "promote", show: ready && !deployment.isCurrentProduction && !canRollback },
    { label: "Instant Rollback", action: "rollback", show: ready && !deployment.isCurrentProduction && canRollback },
    { label: "Redeploy", action: "redeploy", show: deployment.status !== "queued" && deployment.status !== "building" },
    {
      label: "Redeploy without Cache",
      action: "redeploy-no-cache",
      show: deployment.status !== "queued" && deployment.status !== "building",
    },
    {
      label: "Cancel Build",
      action: "cancel",
      show: deployment.status === "queued" || deployment.status === "building",
      danger: true,
    },
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-fg"
        aria-label="Deployment actions"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="13" cy="8" r="1.3" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-20 w-56 overflow-hidden rounded-lg border border-line-strong bg-raised py-1 shadow-2xl">
          {items
            .filter((i) => i.show)
            .map((item) =>
              item.href ? (
                <a
                  key={item.label}
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  className="block px-3 py-2 text-sm text-fg hover:bg-white/5"
                >
                  {item.label}
                </a>
              ) : (
                <button
                  key={item.label}
                  onClick={() => {
                    setOpen(false);
                    onAction(item.action!);
                  }}
                  className={cx(
                    "block w-full px-3 py-2 text-left text-sm hover:bg-white/5",
                    item.danger ? "text-err" : "text-fg",
                  )}
                >
                  {item.label}
                </button>
              ),
            )}
        </div>
      )}
    </div>
  );
}

export function DeploymentRow({
  project,
  deployment,
  canRollback,
  onAction,
  pending,
}: {
  project: Project;
  deployment: Deployment;
  canRollback: boolean;
  onAction: (action: DeploymentAction) => void;
  pending: boolean;
}) {
  const link = commitUrl(project.repoUrl, deployment.commitSha);
  return (
    <div
      className={cx(
        "grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-4 transition-colors hover:bg-raised sm:grid-cols-[220px_150px_1fr_auto]",
        pending && "opacity-60",
      )}
    >
      <Link href={`/${project.name}/deployments/${deployment.id}`} className="min-w-0">
        <div className="truncate font-mono text-[13px] text-white hover:underline">{deployment.id}</div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted">
          {deployment.target === "production" ? "Production" : "Preview"}
          {deployment.isCurrentProduction && <Badge tone="info">Current</Badge>}
        </div>
      </Link>
      <div className="hidden text-[13px] sm:block">
        <div className="flex items-center gap-2 text-fg">
          <StatusDot status={deployment.status} />
          <span className="capitalize">{deployment.status}</span>
        </div>
        <div className="mt-1 text-xs text-muted">
          {deployment.status === "queued" && deployment.queuePosition !== null
            ? `#${deployment.queuePosition + 1} in queue`
            : duration(deployment.durationMs)}
          {deployment.cacheStatus === "hit" && <span className="text-ok"> · cached</span>}
        </div>
      </div>
      <div className="hidden min-w-0 text-[13px] sm:block">
        <div className="flex items-center gap-1.5 text-fg">
          <BranchIcon />
          <span className="truncate font-mono text-xs">{deployment.branch}</span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-muted">
          <CommitIcon />
          {link ? (
            <a href={link} target="_blank" rel="noreferrer" className="font-mono text-xs hover:text-fg">
              {shortSha(deployment.commitSha)}
            </a>
          ) : (
            <span className="font-mono text-xs">{shortSha(deployment.commitSha)}</span>
          )}
          <span className="truncate">{deployment.commitMessage}</span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="hidden text-right text-xs text-muted md:block">
          <div>{timeAgo(deployment.createdAt)}</div>
          <div className="mt-1">
            {deployment.commitAuthor ? `by ${deployment.commitAuthor}` : TRIGGER_LABEL[deployment.trigger]}
          </div>
        </div>
        <DeploymentMenu deployment={deployment} canRollback={canRollback} onAction={onAction} />
      </div>
    </div>
  );
}
