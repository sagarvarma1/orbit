import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseRepoUrl } from "../src/build/git.js";
import { branchAliasLabel } from "../src/lib/urls.js";
import { verifyGithubSignature } from "../src/services/git-sync.js";

describe("GitHub webhook signatures", () => {
  const body = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }));
  const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts a valid signature", () => {
    expect(verifyGithubSignature("s3cret", body, sign("s3cret"))).toBe(true);
  });
  it("rejects wrong secrets, tampered bodies, missing headers and an empty secret", () => {
    expect(verifyGithubSignature("s3cret", body, sign("other"))).toBe(false);
    expect(verifyGithubSignature("s3cret", Buffer.from("{}"), sign("s3cret"))).toBe(false);
    expect(verifyGithubSignature("s3cret", body, undefined)).toBe(false);
    expect(verifyGithubSignature("s3cret", body, "sha1=abc")).toBe(false);
    expect(verifyGithubSignature("", body, sign(""))).toBe(false);
  });
});

describe("repo URLs and aliases", () => {
  it("normalizes GitHub URLs", () => {
    for (const input of [
      "https://github.com/Owner/Repo",
      "github.com/Owner/Repo.git",
      "Owner/Repo",
      "https://github.com/Owner/Repo/tree/main",
    ]) {
      expect(parseRepoUrl(input, false).fullName).toBe("owner/repo");
    }
    expect(() => parseRepoUrl("https://gitlab.com/a/b", false)).toThrow();
    expect(() => parseRepoUrl("file:///tmp/repo", false)).toThrow();
    expect(parseRepoUrl("file:///tmp/repo", true).url).toBe("file:///tmp/repo");
  });
  it("builds DNS-safe branch aliases", () => {
    expect(branchAliasLabel("my-app", "feature/New_Login")).toBe("my-app-git-feature-new-login");
    expect(branchAliasLabel("my-app", "x".repeat(100)).length).toBeLessThanOrEqual(63);
  });
});
