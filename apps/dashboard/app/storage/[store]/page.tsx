"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, ErrorNote, Input, Label, PageHeader, Select, Spinner, cx } from "@/components/ui";
import { api } from "@/lib/api";
import { BlobClient, formatBytes } from "@/lib/blob";
import { timeAgo } from "@/lib/format";
import type { BlobItem, BlobStore, EnvTarget, Project } from "@/lib/types";
import { useApi } from "@/lib/use-api";

export default function StorePage() {
  const { store: id } = useParams<{ store: string }>();
  const router = useRouter();
  const { data, error, refresh } = useApi<{ store: BlobStore }>(`/api/blob-stores/${id}`);
  const store = data?.store;
  const client = useMemo(() => (store?.token && store.apiUrl ? new BlobClient(store.apiUrl, store.token) : null), [store]);

  async function remove() {
    if (!store) return;
    if (prompt(`Type "${store.name}" to delete this store and every file in it.`) !== store.name) return;
    await api(`/api/blob-stores/${store.id}`, { method: "DELETE" });
    router.push("/storage");
  }

  if (error)
    return (
      <div className="py-10">
        <ErrorNote>{error.message}</ErrorNote>
      </div>
    );
  if (!store || !client) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted">
        <Spinner /> Loading store…
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {store.name} <Badge>Blob</Badge>
          </span>
        }
        subtitle={
          <span className="font-mono text-xs">
            {store.id} · {store.usage.count} files · {formatBytes(store.usage.bytes)}
          </span>
        }
        actions={
          <Button variant="danger" onClick={remove}>
            Delete Store
          </Button>
        }
      />
      <div className="space-y-8 py-8">
        <Browser client={client} onChange={refresh} />
        <Connections store={store} onChange={refresh} />
        <Quickstart store={store} onChange={refresh} />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ browser

function Browser({ client, onChange }: { client: BlobClient; onChange: () => Promise<void> }) {
  const [prefix, setPrefix] = useState("");
  const [items, setItems] = useState<{ blobs: BlobItem[]; folders: string[]; cursor?: string; hasMore: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [access, setAccess] = useState<"public" | "private">("public");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setError(null);
      try {
        const page = await client.list(prefix, cursor);
        setItems((prev) =>
          cursor && prev ? { ...page, blobs: [...prev.blobs, ...page.blobs], folders: [...prev.folders, ...page.folders] } : page,
        );
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [client, prefix],
  );

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) await client.upload(prefix + file.name, file, access, true);
      await Promise.all([load(), onChange()]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function remove(blob: BlobItem) {
    if (!confirm(`Delete ${blob.pathname}?`)) return;
    setBusy(true);
    try {
      await client.delete([blob.url]);
      await Promise.all([load(), onChange()]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const crumbs = prefix.split("/").filter(Boolean);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <button className={cx("hover:text-white", prefix ? "text-muted" : "text-white")} onClick={() => setPrefix("")}>
            Files
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-subtle">/</span>
              <button
                className={cx("font-mono hover:text-white", i === crumbs.length - 1 ? "text-white" : "text-muted")}
                onClick={() => setPrefix(`${crumbs.slice(0, i + 1).join("/")}/`)}
              >
                {c}
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={access}
            onChange={(e) => setAccess(e.target.value as "public" | "private")}
            className="h-8 w-28 text-[13px]"
          >
            <option value="public">Public</option>
            <option value="private">Private</option>
          </Select>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
          <Button size="sm" variant="primary" loading={busy} onClick={() => fileInput.current?.click()}>
            Upload
          </Button>
        </div>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Card className="divide-y divide-line">
        {!items && (
          <div className="flex items-center gap-2 p-6 text-sm text-muted">
            <Spinner /> Loading…
          </div>
        )}
        {items && items.folders.length === 0 && items.blobs.length === 0 && (
          <div className="p-8 text-center text-sm text-muted">
            {prefix ? "This folder is empty." : "No files yet. Upload one here, or from your app with put()."}
          </div>
        )}
        {items?.folders.map((folder) => (
          <button
            key={folder}
            onClick={() => setPrefix(folder)}
            className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-raised"
          >
            <span className="text-muted">▸</span>
            <span className="font-mono text-[13px] text-fg">{folder.slice(prefix.length)}</span>
          </button>
        ))}
        {items?.blobs.map((blob) => (
          <div key={blob.pathname} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
            <button
              onClick={() => void client.open(blob.url).catch((err: Error) => setError(err.message))}
              className="min-w-0 flex-1 truncate text-left font-mono text-[13px] text-white hover:underline"
              title={blob.url}
            >
              {blob.pathname.slice(prefix.length)}
            </button>
            <span className="text-xs text-muted">{formatBytes(blob.size)}</span>
            <span className="w-16 text-right text-xs text-muted">{timeAgo(Date.parse(blob.uploadedAt))}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(blob.url)}>
                Copy URL
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void remove(blob)}>
                Delete
              </Button>
            </div>
          </div>
        ))}
        {items?.hasMore && (
          <div className="p-3 text-center">
            <Button size="sm" variant="ghost" onClick={() => void load(items.cursor)}>
              Load more
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}

// -------------------------------------------------------------- connections

const TARGETS: EnvTarget[] = ["production", "preview"];

function Connections({ store, onChange }: { store: BlobStore; onChange: () => Promise<void> }) {
  const { data } = useApi<{ projects: Project[] }>("/api/projects");
  const [project, setProject] = useState("");
  const [targets, setTargets] = useState<EnvTarget[]>(["production", "preview"]);
  const [prefix, setPrefix] = useState("BLOB");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = new Set(store.connections.map((c) => c.project));
  const available = (data?.projects ?? []).filter((p) => !connected.has(p.name));

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/blob-stores/${store.id}/connections/${project}`, { method: "PUT", body: { targets, envPrefix: prefix } });
      setProject("");
      await onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(name: string) {
    if (!confirm(`Disconnect ${name}? Its next deployment won't have the token.`)) return;
    await api(`/api/blob-stores/${store.id}/connections/${name}`, { method: "DELETE" });
    await onChange();
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium text-white">Projects</h2>
        <p className="mt-1 text-[13px] text-muted">
          Connected projects get <code className="font-mono text-fg">{"<PREFIX>"}_READ_WRITE_TOKEN</code> in the environments you
          pick. Redeploy to pick it up, like any environment variable.
        </p>
      </div>
      <Card className="divide-y divide-line">
        {store.connections.map((c) => (
          <div key={c.project} className="flex flex-wrap items-center gap-4 px-5 py-3">
            <Link href={`/${c.project}`} className="min-w-0 flex-1 text-sm text-white hover:underline">
              {c.project}
            </Link>
            <code className="font-mono text-xs text-fg">{c.envPrefix}_READ_WRITE_TOKEN</code>
            <span className="text-xs capitalize text-muted">{c.targets.join(", ")}</span>
            <Button size="sm" variant="ghost" onClick={() => void disconnect(c.project)}>
              Disconnect
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-4 px-5 py-4">
          <div className="min-w-48 flex-1">
            <Label>Connect a project</Label>
            <Select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">Choose a project…</option>
              {available.map((p) => (
                <option key={p.id} value={p.name}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-36">
            <Label>Prefix</Label>
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} className="font-mono text-[13px]" />
          </div>
          <div className="flex gap-4 pb-2">
            {TARGETS.map((t) => (
              <label key={t} className="flex cursor-pointer items-center gap-2 text-sm capitalize text-fg">
                <input
                  type="checkbox"
                  checked={targets.includes(t)}
                  onChange={(e) => setTargets(e.target.checked ? [...targets, t] : targets.filter((x) => x !== t))}
                  className="h-4 w-4 accent-white"
                />
                {t}
              </label>
            ))}
          </div>
          <Button variant="primary" onClick={connect} loading={busy} disabled={!project || targets.length === 0}>
            Connect
          </Button>
        </div>
      </Card>
      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}

// --------------------------------------------------------------- quickstart

function Quickstart({ store, onChange }: { store: BlobStore; onChange: () => Promise<void> }) {
  const [revealed, setRevealed] = useState(false);
  const [rotating, setRotating] = useState(false);

  async function rotate() {
    if (!confirm("Create a new token? The current one stops working now; connected projects need a redeploy.")) return;
    setRotating(true);
    await api(`/api/blob-stores/${store.id}/rotate-token`, { method: "POST" });
    await onChange();
    setRotating(false);
    setRevealed(true);
  }

  const env = `BLOB_READ_WRITE_TOKEN="${revealed ? store.token : "••••••••••••••••"}"\nVERCEL_BLOB_API_URL="${store.apiUrl}"`;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-white">Quickstart</h2>
      <Card className="space-y-4 p-5">
        <pre className="overflow-x-auto rounded-md border border-line bg-bg p-4 font-mono text-[12px] text-fg">
          {`import { put } from "@vercel/blob";

const blob = await put("avatars/me.png", file, { access: "public" });
// blob.url -> ${store.baseUrl}/avatars/me.png`}
        </pre>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] text-muted">
              Deployments get these automatically. For local development, put them in{" "}
              <code className="font-mono text-fg">.env.local</code>:
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setRevealed((r) => !r)}>
                {revealed ? "Hide" : "Reveal"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    `BLOB_READ_WRITE_TOKEN="${store.token}"\nVERCEL_BLOB_API_URL="${store.apiUrl}"`,
                  )
                }
              >
                Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={rotate} loading={rotating}>
                Rotate token
              </Button>
            </div>
          </div>
          <pre className="overflow-x-auto rounded-md border border-line bg-bg p-4 font-mono text-[12px] text-fg">{env}</pre>
        </div>
      </Card>
    </section>
  );
}
