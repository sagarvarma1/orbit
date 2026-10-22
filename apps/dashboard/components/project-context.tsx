"use client";

import { createContext, useContext } from "react";
import type { Alias, Deployment, Project } from "@/lib/types";

export interface ProjectContextValue {
  project: Project;
  aliases: Alias[];
  /** Deployments that have served production, newest first. */
  productionHistory: string[];
  deployments: Deployment[];
  refresh: () => Promise<void>;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be used inside a project page");
  return ctx;
}

/**
 * "Instant Rollback" applies to an older deployment that has served production before.
 * Moving production to anything else (newer, or never-production) is a promotion.
 */
export function canRollbackTo(deployment: Deployment, ctx: Pick<ProjectContextValue, "project" | "productionHistory">): boolean {
  const current = ctx.project.production;
  return Boolean(current && ctx.productionHistory.includes(deployment.id) && deployment.createdAt < current.createdAt);
}
