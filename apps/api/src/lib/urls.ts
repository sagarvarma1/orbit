import type { Config } from "../config.js";
import { slugify } from "./ids.js";

const MAX_LABEL = 63;

/** `<project>-git-<branch>`: a stable hostname that follows the latest deployment of a branch. */
export function branchAliasLabel(projectName: string, branch: string): string {
  const label = `${projectName}-git-${slugify(branch) || "branch"}`;
  return label.length <= MAX_LABEL ? label : label.slice(0, MAX_LABEL).replace(/-+$/, "");
}

export function publicUrl(config: Pick<Config, "publicProtocol" | "rootDomain" | "publicEdgePort">, label: string): string {
  const defaultPort =
    (config.publicProtocol === "https" && config.publicEdgePort === "443") ||
    (config.publicProtocol === "http" && config.publicEdgePort === "80");
  const port = config.publicEdgePort && !defaultPort ? `:${config.publicEdgePort}` : "";
  return `${config.publicProtocol}://${label}.${config.rootDomain}${port}`;
}
