"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useProject } from "@/components/project-context";
import { Button, Card, ErrorNote, Input, Label, Select } from "@/components/ui";
import { api, apiOrigin } from "@/lib/api";
import type { DomainStatus, FrameworkId, PlatformConfig } from "@/lib/types";
import { useApi } from "@/lib/use-api";

export default function SettingsPage() {
  const { project, refresh } = useProject();
  const router = useRouter();
  const { data: config } = useApi<PlatformConfig>("/api/config");
  const [form, setForm] = useState({
    framework: project.framework ?? "",
    rootDirectory: project.rootDirectory === "." ? "" : project.rootDirectory,
    installCommand: project.installCommand ?? "",
    buildCommand: project.buildCommand ?? "",
    outputDirectory: project.outputDirectory ?? "",
    productionBranch: project.productionBranch,
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      await api(`/api/projects/${project.name}`, {
        method: "PATCH",
        body: {
          framework: (form.framework || null) as FrameworkId | null,
          rootDirectory: form.rootDirectory || ".",
          installCommand: form.installCommand || null,
          buildCommand: form.buildCommand || null,
          outputDirectory: form.outputDirectory || null,
          productionBranch: form.productionBranch,
        },
      });
      await refresh();
      setMessage({ ok: true, text: "Saved. Changes apply to the next deployment." });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (prompt(`Type "${project.name}" to delete this project and all of its deployments.`) !== project.name) return;
    await api(`/api/projects/${project.name}`, { method: "DELETE" });
    router.push("/");
  }

  const webhookUrl = `${apiOrigin()}/api/webhooks/github`;

  return (
    <div className="space-y-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight text-white">Settings</h1>

      <Card>
        <div className="space-y-5 p-6">
          <div>
            <h2 className="font-medium text-white">Build &amp; Development Settings</h2>
            <p className="mt-1 text-sm text-muted">
              Leave a field empty to use the framework default. Detection runs on every build.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Framework Preset</Label>
              <Select value={form.framework} onChange={set("framework")}>
                <option value="">Auto-detect</option>
                {config?.presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Root Directory</Label>
              <Input placeholder="./" value={form.rootDirectory} onChange={set("rootDirectory")} />
            </div>
            <div>
              <Label>Install Command</Label>
              <Input
                placeholder="Auto (from lockfile)"
                value={form.installCommand}
                onChange={set("installCommand")}
                className="font-mono text-[13px]"
              />
            </div>
            <div>
              <Label>Build Command</Label>
              <Input
                placeholder="Auto (npm run build)"
                value={form.buildCommand}
                onChange={set("buildCommand")}
                className="font-mono text-[13px]"
              />
            </div>
            <div>
              <Label>Output Directory</Label>
              <Input
                placeholder="Framework default"
                value={form.outputDirectory}
                onChange={set("outputDirectory")}
                className="font-mono text-[13px]"
              />
            </div>
            <div>
              <Label>Production Branch</Label>
              <Input value={form.productionBranch} onChange={set("productionBranch")} className="font-mono text-[13px]" />
            </div>
          </div>
          {message &&
            (message.ok ? <p className="text-[13px] text-ok">{message.text}</p> : <ErrorNote>{message.text}</ErrorNote>)}
        </div>
        <div className="flex justify-end border-t border-line px-6 py-3">
          <Button variant="primary" size="sm" onClick={save} loading={saving}>
            Save
          </Button>
        </div>
      </Card>

      <DomainsSection projectName={project.name} productionBranch={project.productionBranch} />

      <Card className="space-y-4 p-6">
        <div>
          <h2 className="font-medium text-white">Git</h2>
          <p className="mt-1 text-sm text-muted">
            Pushes to <span className="font-mono text-fg">{project.productionBranch}</span> deploy to production; every other
            branch gets a preview.
          </p>
        </div>
        <div>
          <Label hint={config?.webhookConfigured ? "Secret configured" : "Set GITHUB_WEBHOOK_SECRET on the control plane"}>
            GitHub Webhook
          </Label>
          <Input readOnly value={webhookUrl} onFocus={(e) => e.target.select()} className="font-mono text-[13px]" />
          <p className="mt-2 text-xs text-muted">
            In the repo: Settings → Webhooks → Add webhook. Content type <span className="font-mono">application/json</span>, the
            same secret, &quot;Just the push event&quot;. GitHub must be able to reach this URL (use a tunnel such as smee.io or
            cloudflared when running locally).
          </p>
        </div>
        <div className="rounded-md border border-line px-4 py-3 text-[13px] text-muted">
          Git polling:{" "}
          {config?.gitPollIntervalSeconds ? (
            <span className="text-ok">on, every {config.gitPollIntervalSeconds}s</span>
          ) : (
            <span>off (set GIT_POLL_INTERVAL_SECONDS to deploy pushes without a webhook)</span>
          )}
        </div>
      </Card>

      <Card className="border-err/30 p-6">
        <h2 className="font-medium text-white">Delete Project</h2>
        <p className="mt-1 text-sm text-muted">
          Removes the project, every deployment artifact, and all logs. This can&apos;t be undone.
        </p>
        <Button variant="danger" size="sm" className="mt-4" onClick={remove}>
          Delete Project
        </Button>
      </Card>
    </div>
  );
}

function DomainsSection({ projectName, productionBranch }: { projectName: string; productionBranch: string }) {
  const path = `/api/projects/${projectName}/domains`;
  const { data, refresh } = useApi<{ domains: DomainStatus[] }>(path);
  const [hostname, setHostname] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "POST", body: { hostname, branch: branch.trim() || null } });
      setHostname("");
      setBranch("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(domain: string) {
    if (!confirm(`Remove ${domain}? It stops serving this project immediately.`)) return;
    await api(`${path}/${encodeURIComponent(domain)}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <Card>
      <div className="space-y-4 p-6">
        <div>
          <h2 className="font-medium text-white">Domains</h2>
          <p className="mt-1 text-sm text-muted">
            Serve this project on your own domain. HTTPS certificates are issued automatically once DNS points at Orbit.
          </p>
        </div>
        <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row">
          <Input placeholder="www.example.com" value={hostname} onChange={(e) => setHostname(e.target.value)} required />
          <Input
            placeholder={`Branch (default: production, ${productionBranch})`}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="sm:w-72"
          />
          <Button type="submit" loading={busy}>
            Add
          </Button>
        </form>
        {error && <ErrorNote>{error}</ErrorNote>}
        {data && data.domains.length > 0 && (
          <div className="rounded-md border border-line">
            {data.domains.map((d) => (
              <div key={d.hostname} className="space-y-3 border-b border-line px-4 py-4 last:border-b-0">
                <div className="flex flex-wrap items-center gap-3">
                  <a href={d.url} target="_blank" rel="noreferrer" className="text-sm text-white hover:underline">
                    {d.hostname}
                  </a>
                  {d.branch && <span className="font-mono text-xs text-muted">{d.branch}</span>}
                  <span
                    className={
                      d.dns.configured === true
                        ? "text-xs text-ok"
                        : d.dns.configured === false
                          ? "text-xs text-warn"
                          : "text-xs text-muted"
                    }
                  >
                    {d.dns.configured === true
                      ? "Valid configuration"
                      : d.dns.configured === false
                        ? "DNS not configured"
                        : "DNS not checked"}
                  </span>
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => remove(d.hostname)}>
                    Remove
                  </Button>
                </div>
                {d.dns.configured !== true && (
                  <div className="space-y-2 text-[13px] text-muted">
                    <p>{d.dns.detail}</p>
                    {d.dns.record && (
                      <div className="grid grid-cols-3 gap-2 rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs">
                        <span className="text-subtle">Type</span>
                        <span className="text-subtle">Name</span>
                        <span className="text-subtle">Value</span>
                        <span className="text-fg">{d.dns.record.type}</span>
                        <span className="text-fg">{d.dns.record.name}</span>
                        <span className="break-all text-fg">{d.dns.record.value}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
