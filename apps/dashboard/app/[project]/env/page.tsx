"use client";

import { type FormEvent, useState } from "react";
import { useProject } from "@/components/project-context";
import { Button, Card, ErrorNote, Input, Label, cx } from "@/components/ui";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import type { EnvTarget, EnvVar } from "@/lib/types";
import { useApi } from "@/lib/use-api";

const TARGETS: EnvTarget[] = ["production", "preview"];

function TargetToggles({ value, onChange }: { value: EnvTarget[]; onChange: (v: EnvTarget[]) => void }) {
  return (
    <div className="flex gap-4">
      {TARGETS.map((t) => (
        <label key={t} className="flex cursor-pointer items-center gap-2 text-sm capitalize text-fg">
          <input
            type="checkbox"
            checked={value.includes(t)}
            onChange={(e) => onChange(e.target.checked ? [...value, t] : value.filter((x) => x !== t))}
            className="h-4 w-4 accent-white"
          />
          {t}
        </label>
      ))}
    </div>
  );
}

export default function EnvPage() {
  const { project } = useProject();
  const path = `/api/projects/${project.name}/env`;
  const { data, refresh } = useApi<{ env: EnvVar[] }>(path);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [targets, setTargets] = useState<EnvTarget[]>(["production", "preview"]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api(`${path}/${encodeURIComponent(key.trim())}`, { method: "PUT", body: { value, targets } });
      setKey("");
      setValue("");
      setSaved(true);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Environment Variables</h1>
        <p className="mt-2 text-sm text-muted">
          Injected into the build (and functions) of new deployments. Existing deployments are immutable, so redeploy to apply
          changes. Orbit also sets <code className="font-mono text-fg">ORBIT_ENV</code>,{" "}
          <code className="font-mono text-fg">ORBIT_URL</code>, <code className="font-mono text-fg">ORBIT_GIT_COMMIT_SHA</code>{" "}
          and <code className="font-mono text-fg">ORBIT_GIT_COMMIT_REF</code>.
        </p>
      </div>

      <Card className="p-6">
        <form onSubmit={add} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Key</Label>
              <Input
                placeholder="VITE_MESSAGE"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                className="font-mono text-[13px]"
              />
            </div>
            <div>
              <Label>Value</Label>
              <Input
                placeholder="Hello from Orbit"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="font-mono text-[13px]"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <Label>Environments</Label>
              <TargetToggles value={targets} onChange={setTargets} />
            </div>
            <Button type="submit" variant="primary" loading={saving} disabled={!key.trim() || targets.length === 0}>
              Save
            </Button>
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
          {saved && !error && <p className="text-[13px] text-ok">Saved. Redeploy to use the new value.</p>}
        </form>
      </Card>

      <Card className="divide-y divide-line">
        {data?.env.length === 0 && <div className="p-8 text-center text-sm text-muted">No environment variables yet.</div>}
        {data?.env.map((v) => (
          <EnvRow key={v.key} env={v} path={path} onChange={refresh} />
        ))}
      </Card>
    </div>
  );
}

function EnvRow({ env, path, onChange }: { env: EnvVar; path: string; onChange: () => Promise<void> }) {
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(env.value);
  const [targets, setTargets] = useState(env.targets);
  const [busy, setBusy] = useState(false);
  const url = `${path}/${encodeURIComponent(env.key)}`;

  async function save() {
    setBusy(true);
    await api(url, { method: "PUT", body: { value, targets } });
    await onChange();
    setBusy(false);
    setEditing(false);
  }

  async function remove() {
    if (!confirm(`Delete ${env.key}?`)) return;
    setBusy(true);
    await api(url, { method: "DELETE" });
    await onChange();
  }

  return (
    <div className={cx("px-5 py-4", busy && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[13px] text-white">{env.key}</div>
          <div className="mt-1 text-xs text-muted">
            {env.targets.map((t) => t[0]!.toUpperCase() + t.slice(1)).join(", ")} · updated {timeAgo(env.updatedAt)}
          </div>
        </div>
        {!editing && (
          <button
            onClick={() => setRevealed((r) => !r)}
            className="max-w-xs truncate font-mono text-[13px] text-muted hover:text-fg"
            title="Click to reveal"
          >
            {revealed ? env.value || '""' : "••••••••••••"}
          </button>
        )}
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)}>
            {editing ? "Close" : "Edit"}
          </Button>
          <Button size="sm" variant="ghost" onClick={remove}>
            Delete
          </Button>
        </div>
      </div>
      {editing && (
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <div className="min-w-64 flex-1">
            <Label>Value</Label>
            <Input value={value} onChange={(e) => setValue(e.target.value)} className="font-mono text-[13px]" />
          </div>
          <TargetToggles value={targets} onChange={setTargets} />
          <Button size="sm" variant="primary" onClick={save} loading={busy} disabled={targets.length === 0}>
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
