"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useProject } from "@/components/project-context";
import { Button, Card, ErrorNote, Input, Label, Select } from "@/components/ui";
import { API_URL, api } from "@/lib/api";
import type { FrameworkId, PlatformConfig } from "@/lib/types";
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

  const webhookUrl = `${API_URL}/api/webhooks/github`;

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
