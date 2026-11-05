"use client";

import Link from "next/link";
import { useProject } from "@/components/project-context";
import { Badge, Card, LinkButton } from "@/components/ui";
import { formatBytes } from "@/lib/blob";
import type { EnvTarget } from "@/lib/types";
import { useApi } from "@/lib/use-api";

interface Connection {
  store: { id: string; name: string; usage: { count: number; bytes: number } };
  targets: EnvTarget[];
  envPrefix: string;
}

export default function ProjectStoragePage() {
  const { project } = useProject();
  const { data } = useApi<{ connections: Connection[] }>(`/api/projects/${project.name}/blob-stores`);

  return (
    <div className="space-y-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Storage</h1>
        <p className="mt-2 text-sm text-muted">
          Blob stores connected to this project. Each one adds{" "}
          <code className="font-mono text-fg">{"<PREFIX>"}_READ_WRITE_TOKEN</code> to the environments you choose, which the{" "}
          <code className="font-mono text-fg">@vercel/blob</code> SDK reads. Redeploy after connecting a store.
        </p>
      </div>

      {data?.connections.length === 0 && (
        <Card className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <div className="text-lg font-medium text-white">No stores connected</div>
          <p className="max-w-md text-sm text-muted">
            Create a Blob store under Storage, then connect it to {project.name} to give its deployments a token.
          </p>
          <LinkButton href="/storage" variant="primary">
            Connect a Store
          </LinkButton>
        </Card>
      )}

      {data && data.connections.length > 0 && (
        <Card className="divide-y divide-line">
          {data.connections.map((c) => (
            <Link
              key={c.store.id}
              href={`/storage/${c.store.id}`}
              className="flex flex-wrap items-center gap-4 px-5 py-4 hover:bg-raised"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  {c.store.name} <Badge>Blob</Badge>
                </div>
                <div className="mt-1 text-xs text-muted">
                  {c.targets.map((t) => t[0]!.toUpperCase() + t.slice(1)).join(", ")} · {c.store.usage.count}{" "}
                  {c.store.usage.count === 1 ? "file" : "files"} · {formatBytes(c.store.usage.bytes)}
                </div>
              </div>
              <span className="font-mono text-[13px] text-muted">{c.envPrefix}_READ_WRITE_TOKEN</span>
            </Link>
          ))}
        </Card>
      )}
      {data && data.connections.length > 0 && (
        <p className="text-[13px] text-muted">
          Manage stores and their connections under{" "}
          <Link href="/storage" className="text-fg hover:underline">
            Storage
          </Link>
          .
        </p>
      )}
    </div>
  );
}
