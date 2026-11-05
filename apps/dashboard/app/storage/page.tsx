"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Badge, Button, Card, ErrorNote, Input, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/blob";
import { timeAgo } from "@/lib/format";
import type { BlobStore } from "@/lib/types";
import { useApi } from "@/lib/use-api";

export default function StoragePage() {
  const router = useRouter();
  const { data, error, loading } = useApi<{ stores: BlobStore[]; apiUrl: string }>("/api/blob-stores");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const { store } = await api<{ store: BlobStore }>("/api/blob-stores", { method: "POST", body: { name } });
      router.push(`/storage/${store.id}`);
    } catch (err) {
      setCreateError((err as Error).message);
      setCreating(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Storage"
        subtitle="Blob stores for the files your apps upload and serve. They work with the @vercel/blob SDK unchanged."
      />
      <div className="py-6">
        {error && <ErrorNote>Can&apos;t reach the Orbit API: {error.message}. Is the control plane running?</ErrorNote>}
        <form onSubmit={create} className="mb-6 flex max-w-md gap-2">
          <Input placeholder="New store name, e.g. uploads" value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" variant="primary" loading={creating} disabled={!name.trim()} className="shrink-0">
            Create Store
          </Button>
        </form>
        {createError && (
          <div className="mb-6">
            <ErrorNote>{createError}</ErrorNote>
          </div>
        )}
        {loading && !data && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="h-40 animate-pulse" />
            ))}
          </div>
        )}
        {data && data.stores.length === 0 && (
          <Card className="flex flex-col items-center gap-4 px-6 py-20 text-center">
            <div className="text-lg font-medium text-white">Create your first Blob store</div>
            <p className="max-w-md text-sm text-muted">
              Name a store above, then connect it to a project. Its deployments get{" "}
              <span className="font-mono text-fg">BLOB_READ_WRITE_TOKEN</span>, so{" "}
              <span className="font-mono text-fg">put()</span> and <span className="font-mono text-fg">list()</span> just work.
            </p>
          </Card>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data?.stores.map((store) => (
            <StoreCard key={store.id} store={store} />
          ))}
        </div>
      </div>
    </>
  );
}

function StoreCard({ store }: { store: BlobStore }) {
  const projects = store.connections.map((c) => c.project);
  return (
    <Link href={`/storage/${store.id}`} className="group">
      <Card className="flex h-full flex-col gap-4 p-5 transition-colors group-hover:border-line-strong group-hover:bg-raised">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line-strong bg-bg text-sm font-semibold uppercase text-white">
              {store.name[0]}
            </div>
            <div className="min-w-0">
              <div className="truncate font-medium text-white">{store.name}</div>
              <div className="truncate text-[13px] text-muted">
                {store.usage.count} {store.usage.count === 1 ? "file" : "files"} · {formatBytes(store.usage.bytes)}
              </div>
            </div>
          </div>
          <Badge>Blob</Badge>
        </div>
        <div className="truncate font-mono text-[13px] text-subtle">{store.id}</div>
        <div className="mt-auto space-y-1.5 border-t border-line pt-4 text-[13px]">
          <div className="truncate text-fg">{projects.length ? projects.join(", ") : "Not connected to a project"}</div>
          <div className="text-muted">Created {timeAgo(store.createdAt)}</div>
        </div>
      </Card>
    </Link>
  );
}
