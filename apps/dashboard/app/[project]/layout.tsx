"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useCallback } from "react";
import { ProjectContext } from "@/components/project-context";
import { cx, ErrorNote, Spinner } from "@/components/ui";
import type { Alias, Deployment, Project } from "@/lib/types";
import { useApi } from "@/lib/use-api";

const busy = (deployments: Deployment[] | undefined) =>
  deployments?.some((d) => d.status === "queued" || d.status === "building");

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const { project: name } = useParams<{ project: string }>();
  const pathname = usePathname();

  const deployments = useApi<{ deployments: Deployment[] }>(`/api/projects/${name}/deployments`, (d) =>
    busy(d?.deployments) ? 1500 : 5000,
  );
  const project = useApi<{ project: Project; aliases: Alias[]; productionHistory: string[] }>(`/api/projects/${name}`, (d) =>
    busy(d?.project.latestDeployment ? [d.project.latestDeployment] : undefined) ? 1500 : 5000,
  );

  const refreshProject = project.refresh;
  const refreshDeployments = deployments.refresh;
  const refresh = useCallback(async () => {
    await Promise.all([refreshProject(), refreshDeployments()]);
  }, [refreshProject, refreshDeployments]);

  if (project.error) {
    return (
      <div className="py-10">
        <ErrorNote>{project.error.message}</ErrorNote>
      </div>
    );
  }
  if (!project.data || !deployments.data) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted">
        <Spinner /> Loading project…
      </div>
    );
  }

  const tabs = [
    { href: `/${name}`, label: "Overview", active: pathname === `/${name}` || pathname.startsWith(`/${name}/deployments`) },
    { href: `/${name}/env`, label: "Environment Variables", active: pathname === `/${name}/env` },
    { href: `/${name}/settings`, label: "Settings", active: pathname === `/${name}/settings` },
  ];

  return (
    <ProjectContext.Provider
      value={{
        project: project.data.project,
        aliases: project.data.aliases,
        productionHistory: project.data.productionHistory,
        deployments: deployments.data.deployments,
        refresh,
      }}
    >
      <nav className="-mx-6 flex gap-1 overflow-x-auto border-b border-line px-4">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={cx(
              "relative whitespace-nowrap px-3 py-3 text-sm transition-colors",
              tab.active
                ? "text-white after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:bg-white"
                : "text-muted hover:text-fg",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </ProjectContext.Provider>
  );
}
