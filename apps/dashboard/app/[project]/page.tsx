"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DeploymentRow, useDeploymentAction } from "@/components/deployment-row";
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
  Select,
  StatusBadge,
} from "@/components/ui";
import { api } from "@/lib/api";
import { commitUrl, duration, FRAMEWORK_LABELS, hostOf, repoName, repoWebUrl, shortSha, timeAgo } from "@/lib/format";
import type { Deployment } from "@/lib/types";

export default function ProjectOverview() {
  const { project, aliases, deployments, productionHistory, refresh } = useProject();
  const actions = useDeploymentAction(project, refresh);
  const [filter, setFilter] = useState<"all" | "production" | "preview">("all");
  const production = project.production;
  const previousProduction = productionHistory.find((id) => {
    const d = deployments.find((x) => x.id === id);
    return d && d.status === "ready" && canRollbackTo(d, { project, productionHistory });
  });
  const visible = deployments.filter((d) => filter === "all" || d.target === filter);
  const repoLink = repoWebUrl(project.repoUrl);

  return (
    <>
      <div className="flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-3xl font-semibold tracking-tight text-white">{project.name}</h1>
          <div className="mt-2 text-sm text-muted">
            {repoLink ? (
              <a href={repoLink} target="_blank" rel="noreferrer" className="hover:text-fg">
                {repoName(project.repoUrl)}
              </a>
            ) : (
              repoName(project.repoUrl)
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <DeployBranchButton />
          {production && (
            <LinkButton href={project.productionUrl} external variant="primary">
              Visit <ExternalIcon />
            </LinkButton>
          )}
        </div>
      </div>

      {project.autoPromotePaused && (
        <div className="mb-6 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
          Production was rolled back, so new deployments of <span className="font-mono">{project.productionBranch}</span>{" "}
          won&apos;t be assigned the production domain automatically. Promote a deployment to resume.
        </div>
      )}
      {actions.error && (
        <div className="mb-6">
          <ErrorNote>{actions.error}</ErrorNote>
        </div>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-medium text-white">Production Deployment</h2>
          {production && previousProduction && (
            <Button
              size="sm"
              onClick={() => {
                const target = deployments.find((d) => d.id === previousProduction);
                if (target) void actions.run("rollback", target);
              }}
              loading={actions.pending?.startsWith("rollback:")}
            >
              Instant Rollback
            </Button>
          )}
        </div>
        {production ? (
          <ProductionCard
            deployment={production}
            aliases={aliases.filter((a) => a.deploymentId === production.id).map((a) => a.url)}
          />
        ) : (
          <Card className="p-8 text-center text-sm text-muted">
            {project.latestDeployment && ["queued", "building"].includes(project.latestDeployment.status)
              ? "Your first deployment is building…"
              : "No production deployment yet."}
          </Card>
        )}
      </section>

      <section className="mt-10">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="text-lg font-medium text-white">Deployments</h2>
          <div className="w-48">
            <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">All Environments</option>
              <option value="production">Production</option>
              <option value="preview">Preview</option>
            </Select>
          </div>
        </div>
        <Card className="divide-y divide-line overflow-visible">
          {visible.length === 0 && <div className="p-8 text-center text-sm text-muted">No deployments.</div>}
          {visible.map((d) => (
            <DeploymentRow
              key={d.id}
              project={project}
              deployment={d}
              canRollback={canRollbackTo(d, { project, productionHistory })}
              pending={Boolean(actions.pending?.endsWith(d.id))}
              onAction={(action) => void actions.run(action, d)}
            />
          ))}
        </Card>
      </section>
    </>
  );
}

function ProductionCard({ deployment, aliases }: { deployment: Deployment; aliases: string[] }) {
  const { project } = useProject();
  const link = commitUrl(project.repoUrl, deployment.commitSha);
  const domains = [project.productionUrl, ...aliases.filter((a) => a !== project.productionUrl)];
  return (
    <Card className="grid overflow-hidden md:grid-cols-[minmax(0,420px)_1fr]">
      <a
        href={project.productionUrl}
        target="_blank"
        rel="noreferrer"
        className="relative block aspect-[16/10] overflow-hidden border-b border-line bg-bg md:aspect-auto md:min-h-[300px] md:border-b-0 md:border-r"
      >
        {/* Live, scaled-down preview of what production is serving right now. */}
        <iframe
          key={deployment.id}
          src={deployment.url}
          title="Production preview"
          tabIndex={-1}
          className="pointer-events-none absolute left-0 top-0 h-[250%] w-[250%] origin-top-left scale-40 border-0"
        />
      </a>
      <div className="grid content-start gap-5 p-6 text-sm sm:grid-cols-2">
        <Field label="Deployment">
          <Link
            href={`/${project.name}/deployments/${deployment.id}`}
            className="font-mono text-[13px] text-white hover:underline"
          >
            {deployment.id}
          </Link>
        </Field>
        <Field label="Status">
          <div className="flex items-center gap-3">
            <StatusBadge status={deployment.status} />
            <span className="text-muted">{timeAgo(deployment.createdAt)}</span>
          </div>
        </Field>
        <Field label="Domains" wide>
          <div className="space-y-1">
            {domains.map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 text-fg hover:underline"
              >
                {hostOf(url)} <ExternalIcon />
              </a>
            ))}
          </div>
        </Field>
        <Field label="Source" wide>
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-fg">
              <BranchIcon />
              <span className="font-mono text-xs">{deployment.branch}</span>
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-muted">
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
        </Field>
        <Field label="Framework">
          <span className="text-fg">{deployment.framework ? FRAMEWORK_LABELS[deployment.framework] : "—"}</span>
        </Field>
        <Field label="Build Duration">
          <span className="text-fg">{duration(deployment.durationMs)}</span>
          {deployment.builder && <Badge>{deployment.builder}</Badge>}
        </Field>
      </div>
    </Card>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <div className="mb-1 text-xs text-muted">{label}</div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

/** Deploy the latest commit of any branch. */
function DeployBranchButton() {
  const { project, refresh } = useProject();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState(project.productionBranch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openDialog() {
    setOpen(true);
    setError(null);
    try {
      const remote = await api<{ branches: { name: string }[] }>(`/api/projects/${project.name}/branches`);
      setBranches(remote.branches.map((b) => b.name));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deploy() {
    setBusy(true);
    try {
      const { deployment } = await api<{ deployment: Deployment }>(`/api/projects/${project.name}/deployments`, {
        method: "POST",
        body: { branch },
      });
      await refresh();
      router.push(`/${project.name}/deployments/${deployment.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={openDialog}>Deploy</Button>
      {open && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/70 p-4" onClick={() => setOpen(false)}>
          <div
            className="w-full max-w-md rounded-lg border border-line-strong bg-surface p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="text-lg font-medium text-white">Create Deployment</h3>
              <p className="mt-1 text-sm text-muted">
                Deploys the latest commit. <span className="font-mono">{project.productionBranch}</span> goes to production, any
                other branch is a preview.
              </p>
              <div className="mt-5">
                <Select value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!branches}>
                  {(branches ?? [project.productionBranch]).map((b) => (
                    <option key={b} value={b}>
                      {b}
                      {b === project.productionBranch ? " (production)" : ""}
                    </option>
                  ))}
                </Select>
              </div>
              {error && (
                <div className="mt-4">
                  <ErrorNote>{error}</ErrorNote>
                </div>
              )}
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={deploy} loading={busy}>
                  Deploy
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
