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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-white">Storage</h1>
          <p className="mt-2 text-sm text-muted">
            Blob stores connected to this project. Each one adds{" "}
            <code className="font-mono text-fg">{"<PREFIX>"}_READ_WRITE_TOKEN</code> to the chosen environments, which the{" "}
            <code className="font-mono text-fg">@vercel/blob</code> SDK reads. Redeploy after connecting a store.
          </p>
        </div>
        <LinkButton href="/storage" variant="primary">
          Connect Store
        </LinkButton>
      </div>
      <Card className="divide-y divide-line">
        {data?.connections.length === 0 && (
          <div className="p-8 text-center text-sm text-muted">
            No stores connected. Create one under{" "}
            <Link href="/storage" className="text-fg hover:underline">
              Storage
            </Link>{" "}
            and connect it to {project.name}.
          </div>
        )}
        {data?.connections.map((c) => (
          <Link
            key={c.store.id}
            href={`/storage/${c.store.id}`}
            className="flex flex-wrap items-center gap-4 px-5 py-4 hover:bg-raised"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm text-white">
                {c.store.name} <Badge>Blob</Badge>
              </div>
              <div className="mt-1 text-xs text-muted">
                {c.store.usage.count} files · {formatBytes(c.store.usage.bytes)}
              </div>
            </div>
            <code className="font-mono text-xs text-fg">{c.envPrefix}_READ_WRITE_TOKEN</code>
            <span className="text-xs capitalize text-muted">{c.targets.join(", ")}</span>
          </Link>
        ))}
      </Card>
    </div>
  );
}
