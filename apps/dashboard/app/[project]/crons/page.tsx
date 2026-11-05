"use client";

import Link from "next/link";
import { useState } from "react";
import { useProject } from "@/components/project-context";
import { Badge, Button, Card, ErrorNote, cx } from "@/components/ui";
import { api } from "@/lib/api";
import { duration, timeAgo } from "@/lib/format";
import type { CronJob, CronRun, CronStatus } from "@/lib/types";
import { useApi } from "@/lib/use-api";

/** "in 5m" / "in 3h" / "in 2d" */
function timeUntil(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function RunStatus({ run }: { run: CronRun }) {
  const tone = run.status === "success" ? "text-ok" : run.status === "error" ? "text-err" : "text-warn";
  const dot = run.status === "success" ? "bg-ok" : run.status === "error" ? "bg-err" : "bg-warn animate-orbit-pulse";
  const label = run.status === "running" ? "Running" : run.statusCode ? String(run.statusCode) : "Failed";
  return (
    <span className={cx("inline-flex items-center gap-2 text-[13px]", tone)}>
      <span className={cx("inline-block h-2 w-2 rounded-full", dot)} />
      {label}
    </span>
  );
}

export default function CronsPage() {
  const { project, refresh: refreshProject } = useProject();
  const path = `/api/projects/${project.name}/crons`;
  const { data, error, refresh } = useApi<CronStatus>(path, 10_000);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  async function toggle() {
    if (!data) return;
    if (data.enabled && !confirm("Disable cron jobs? Scheduled runs stop until you enable them again.")) return;
    setToggling(true);
    setToggleError(null);
    try {
      await api(`/api/projects/${project.name}`, { method: "PATCH", body: { cronsEnabled: !data.enabled } });
      await Promise.all([refresh(), refreshProject()]);
    } catch (err) {
      setToggleError((err as Error).message);
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="space-y-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-white">Cron Jobs</h1>
          <p className="mt-2 text-sm text-muted">
            Add <code className="font-mono text-fg">crons</code> to <code className="font-mono text-fg">vercel.json</code> and
            Orbit sends a <code className="font-mono text-fg">GET</code> to each path on schedule (UTC), on the production
            deployment only. Set a <code className="font-mono text-fg">CRON_SECRET</code> environment variable and requests carry{" "}
            <code className="font-mono text-fg">Authorization: Bearer $CRON_SECRET</code>.
          </p>
        </div>
        {data && (
          <Button variant={data.enabled ? "secondary" : "primary"} onClick={toggle} loading={toggling}>
            {data.enabled ? "Disable Cron Jobs" : "Enable Cron Jobs"}
          </Button>
        )}
      </div>

      {error && <ErrorNote>{error.message}</ErrorNote>}
      {toggleError && <ErrorNote>{toggleError}</ErrorNote>}
      {data && !data.enabled && (
        <div className="rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
          Cron jobs are disabled for this project. You can still run a job by hand.
        </div>
      )}

      {data && <Jobs data={data} project={project.name} onRun={refresh} />}
      {data && data.runs.length > 0 && <Runs runs={data.runs} project={project.name} />}
    </div>
  );
}

function Jobs({ data, project, onRun }: { data: CronStatus; project: string; onRun: () => Promise<void> }) {
  if (!data.deploymentId) {
    return <Card className="p-8 text-center text-sm text-muted">No production deployment yet. Cron jobs run on production.</Card>;
  }
  if (data.jobs.length === 0) {
    return (
      <Card className="p-8 text-sm text-muted">
        <p className="text-center">
          The{" "}
          <Link href={`/${project}/deployments/${data.deploymentId}`} className="font-mono text-fg hover:underline">
            production deployment
          </Link>{" "}
          has no cron jobs. Add them to <code className="font-mono text-fg">vercel.json</code>:
        </p>
        <pre className="mx-auto mt-4 max-w-md overflow-x-auto rounded-md border border-line bg-bg p-4 font-mono text-[12px] text-fg">
          {`{
  "crons": [
    { "path": "/api/cleanup", "schedule": "0 5 * * *" }
  ]
}`}
        </pre>
      </Card>
    );
  }
  return (
    <Card className="divide-y divide-line">
      {data.jobs.map((job) => (
        <JobRow key={`${job.path} ${job.schedule}`} job={job} project={project} enabled={data.enabled} onRun={onRun} />
      ))}
    </Card>
  );
}

function JobRow({
  job,
  project,
  enabled,
  onRun,
}: {
  job: CronJob;
  project: string;
  enabled: boolean;
  onRun: () => Promise<void>;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CronRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const { run } = await api<{ run: CronRun }>(`/api/projects/${project}/crons/run`, {
        method: "POST",
        body: { path: job.path, schedule: job.schedule },
      });
      setResult(run);
      await onRun();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const last = result ?? job.lastRun;
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[13px] text-white">{job.path}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <code className="font-mono text-fg">{job.schedule}</code>
            {enabled && job.nextRunAt && <span title={utc(job.nextRunAt)}>next {timeUntil(job.nextRunAt)}</span>}
            {last && (
              <span className="inline-flex items-center gap-2">
                last <RunStatus run={last} /> {timeAgo(last.startedAt)}
              </span>
            )}
          </div>
        </div>
        <Button size="sm" onClick={run} loading={running}>
          Run
        </Button>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {result?.output && (
        <pre className="mt-3 max-h-40 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[12px] text-muted">
          {result.output}
        </pre>
      )}
    </div>
  );
}

function Runs({ runs, project }: { runs: CronRun[]; project: string }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-white">Recent runs</h2>
      <Card className="divide-y divide-line">
        {runs.map((run) => (
          <div key={run.id}>
            <button
              onClick={() => setOpen(open === run.id ? null : run.id)}
              className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-left hover:bg-raised"
            >
              <span className="w-16 shrink-0">
                <RunStatus run={run} />
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{run.path}</span>
              {run.trigger === "manual" && <Badge>manual</Badge>}
              <span className="text-xs text-muted">{duration(run.durationMs)}</span>
              <span className="w-20 text-right text-xs text-muted" title={utc(run.startedAt)}>
                {timeAgo(run.startedAt)}
              </span>
            </button>
            {open === run.id && (
              <div className="space-y-2 px-5 pb-4 text-xs text-muted">
                <div>
                  {utc(run.scheduledAt)} · <code className="font-mono">{run.schedule}</code> ·{" "}
                  <Link href={`/${project}/deployments/${run.deploymentId}`} className="font-mono hover:text-fg">
                    {run.deploymentId}
                  </Link>
                </div>
                <pre className="max-h-48 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[12px]">
                  {run.output || "(empty response)"}
                </pre>
              </div>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
