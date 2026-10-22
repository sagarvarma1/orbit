"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useApi } from "@/lib/use-api";
import type { PlatformConfig } from "@/lib/types";
import { Logo } from "./logo";

function Slash() {
  return (
    <svg width="16" height="24" viewBox="0 0 16 24" className="text-line-strong" aria-hidden="true">
      <path d="M11 3 5 21" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function Header() {
  const params = useParams<{ project?: string; id?: string }>();
  const pathname = usePathname();
  const { data: config } = useApi<PlatformConfig>("/api/config", 3000);
  const building = config ? config.queue.running + config.queue.queued : 0;

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-6">
        <Link href="/" className="flex items-center gap-2 text-white">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">Orbit</span>
        </Link>
        {params.project && (
          <>
            <Slash />
            <Link href={`/${params.project}`} className="text-sm text-fg hover:text-white">
              {params.project}
            </Link>
          </>
        )}
        {params.id && (
          <>
            <Slash />
            <span className="font-mono text-sm text-muted">{params.id}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-4 text-xs text-muted">
          {config && (
            <span className="hidden items-center gap-2 sm:flex" title={`Builder: ${config.builder}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${building ? "bg-warn animate-orbit-pulse" : "bg-ok"}`} />
              {building ? `${config.queue.running} building · ${config.queue.queued} queued` : "Builders idle"}
            </span>
          )}
          {pathname !== "/" && pathname !== "/new" && (
            <Link href="/new" className="rounded-md bg-white px-3 py-1.5 text-[13px] font-medium text-black hover:bg-white/90">
              New Project
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
