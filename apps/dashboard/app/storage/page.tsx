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
        subtitle={
          <>
            Blob stores for files your apps upload and serve. They work with the{" "}
            <code className="font-mono text-fg">@vercel/blob</code> SDK unchanged.
          </>
        }
      />
      <div className="space-y-6 py-6">
        <Card className="p-6">
          <form onSubmit={create} className="flex flex-wrap items-end gap-4">
            <div className="min-w-64 flex-1">
              <label className="mb-1.5 block text-[13px] font-medium text-fg">Create a Blob store</label>
              <Input placeholder="my-uploads" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Button type="submit" variant="primary" loading={creating} disabled={!name.trim()}>
              Create
            </Button>
          </form>
          {createError && (
            <div className="mt-4">
              <ErrorNote>{createError}</ErrorNote>
            </div>
          )}
        </Card>

        {error && <ErrorNote>{error.message}</ErrorNote>}
        {loading && !data && <Card className="h-24 animate-pulse" />}
        {data && data.stores.length === 0 && (
          <Card className="p-10 text-center text-sm text-muted">
            No Blob stores yet. Create one, then connect it to a project.
          </Card>
        )}
        {data && data.stores.length > 0 && (
          <Card className="divide-y divide-line">
            {data.stores.map((store) => (
              <Link
                key={store.id}
                href={`/storage/${store.id}`}
                className="flex flex-wrap items-center gap-4 px-5 py-4 hover:bg-raised"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-white">
                    {store.name} <Badge>Blob</Badge>
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted">{store.id}</div>
                </div>
                <div className="text-xs text-muted">
                  {store.usage.count} files · {formatBytes(store.usage.bytes)}
                </div>
                <div className="text-xs text-muted">
                  {store.connections.length
                    ? `${store.connections.length} project${store.connections.length === 1 ? "" : "s"}`
                    : "Not connected"}
                </div>
                <div className="w-20 text-right text-xs text-muted">{timeAgo(store.createdAt)}</div>
              </Link>
            ))}
          </Card>
        )}
      </div>
    </>
  );
}
