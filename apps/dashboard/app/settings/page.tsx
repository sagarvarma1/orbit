"use client";

import { type FormEvent, useState } from "react";
import { useAuth } from "@/components/auth";
import { Badge, Button, Card, ErrorNote, ExternalIcon, Input, Label, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import type { ApiToken, GitHubStatus } from "@/lib/types";
import { useApi } from "@/lib/use-api";

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Your account, API tokens and the GitHub connection for this Orbit instance." />
      <div className="mx-auto max-w-3xl space-y-8 py-8">
        <GitHubSection />
        <TokensSection />
        <AccountSection />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ GitHub

/** Posts the app manifest to GitHub, which shows a pre-filled "Create GitHub App" page. */
function submitManifest(action: string, manifest: unknown) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = action;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(manifest);
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

function GitHubSection() {
  const { data, error, refresh } = useApi<GitHubStatus>("/api/github");
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const justInstalled = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("github");

  async function create() {
    setBusy(true);
    setActionError(null);
    try {
      const res = await api<{ action: string; manifest: unknown }>("/api/github/manifest", {
        method: "POST",
        body: org.trim() ? { org: org.trim() } : {},
      });
      submitManifest(res.action, res.manifest);
    } catch (err) {
      setActionError((err as Error).message);
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect the GitHub App? Private repositories will stop deploying until you connect it again.")) return;
    await api("/api/github", { method: "DELETE" });
    await refresh();
  }

  return (
    <Card>
      <div className="space-y-4 p-6">
        <div>
          <h2 className="font-medium text-white">GitHub</h2>
          <p className="mt-1 text-sm text-muted">
            A GitHub App lets Orbit deploy private repositories, receive pushes instantly, and post commit statuses and preview
            comments on pull requests.
          </p>
        </div>
        {error && <ErrorNote>{error.message}</ErrorNote>}
        {data?.error && <ErrorNote>{data.error}</ErrorNote>}
        {data && !data.app && (
          <div className="space-y-3">
            <div>
              <Label hint="Leave empty to create it on your personal account">GitHub Organization (optional)</Label>
              <Input placeholder="my-org" value={org} onChange={(e) => setOrg(e.target.value)} />
            </div>
            {actionError && <ErrorNote>{actionError}</ErrorNote>}
            <Button variant="primary" onClick={create} loading={busy}>
              Create GitHub App
            </Button>
            <p className="text-xs text-subtle">
              You&apos;ll confirm on GitHub, then choose which repositories Orbit can access.
              {data.personalAccessToken && " The GITHUB_TOKEN personal access token keeps working as a fallback."}
            </p>
          </div>
        )}
        {data?.app && (
          <div className="space-y-4">
            {justInstalled && (
              <div className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">GitHub App installed.</div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={data.app.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-white hover:underline"
              >
                {data.app.name} <ExternalIcon />
              </a>
              <Badge tone="ok">Connected</Badge>
            </div>
            <div className="rounded-md border border-line">
              {data.installations.length === 0 && (
                <p className="px-4 py-3 text-sm text-muted">Not installed anywhere yet. Install it to choose repositories.</p>
              )}
              {data.installations.map((i) => (
                <div key={i.id} className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-b-0">
                  {i.avatarUrl && <img src={i.avatarUrl} alt="" className="h-5 w-5 rounded-full" />}
                  <span className="text-fg">{i.account}</span>
                  <span className="text-muted">
                    {i.repositorySelection === "all" ? "All repositories" : "Selected repositories"}
                  </span>
                  <a href={i.settingsUrl} target="_blank" rel="noreferrer" className="ml-auto text-muted hover:text-fg">
                    Configure
                  </a>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <a
                href={data.app.installUrl}
                className="inline-flex h-8 items-center rounded-md bg-white px-3 text-[13px] font-medium text-black hover:bg-white/90"
              >
                Install on another account
              </a>
              <Button size="sm" variant="ghost" onClick={disconnect}>
                Disconnect
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// -------------------------------------------------------------- API tokens

function TokensSection() {
  const { data, refresh } = useApi<{ tokens: ApiToken[] }>("/api/tokens");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ token: string }>("/api/tokens", { method: "POST", body: { name } });
      setCreated(res.token);
      setName("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(token: ApiToken) {
    if (!confirm(`Revoke "${token.name}"? Anything using it stops working immediately.`)) return;
    await api(`/api/tokens/${token.id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <Card>
      <div className="space-y-4 p-6">
        <div>
          <h2 className="font-medium text-white">API Tokens</h2>
          <p className="mt-1 text-sm text-muted">
            For scripts and CI: send <span className="font-mono text-fg">Authorization: Bearer &lt;token&gt;</span> to the Orbit
            API.
          </p>
        </div>
        <form onSubmit={create} className="flex gap-2">
          <Input placeholder="Token name, e.g. GitHub Actions" value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" loading={busy}>
            Create
          </Button>
        </form>
        {created && (
          <div className="space-y-2 rounded-md border border-warn/40 bg-warn/10 p-3">
            <p className="text-[13px] text-warn">Copy this token now. It won&apos;t be shown again.</p>
            <Input readOnly value={created} onFocus={(e) => e.target.select()} className="font-mono text-[13px]" />
          </div>
        )}
        {data && data.tokens.length > 0 && (
          <div className="rounded-md border border-line">
            {data.tokens.map((t) => (
              <div key={t.id} className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-b-0">
                <span className="text-fg">{t.name}</span>
                <span className="font-mono text-xs text-subtle">{t.prefix}…</span>
                <span className="ml-auto text-xs text-muted">
                  {t.lastUsedAt ? `Used ${timeAgo(t.lastUsedAt)}` : `Created ${timeAgo(t.createdAt)}`}
                </span>
                <Button size="sm" variant="ghost" onClick={() => revoke(t)}>
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------- account

function AccountSection() {
  const { user } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function change(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/auth/password", { method: "POST", body: { current, next } });
      setCurrent("");
      setNext("");
      setMessage({ ok: true, text: "Password changed. Other sessions were signed out." });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={change} className="space-y-4 p-6">
        <div>
          <h2 className="font-medium text-white">Account</h2>
          <p className="mt-1 text-sm text-muted">
            Signed in as <span className="text-fg">{user?.email}</span>.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label>Current Password</Label>
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div>
            <Label hint="At least 10 characters">New Password</Label>
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </div>
        </div>
        {message && (message.ok ? <p className="text-[13px] text-ok">{message.text}</p> : <ErrorNote>{message.text}</ErrorNote>)}
        <Button type="submit" size="sm" loading={busy}>
          Change Password
        </Button>
      </form>
    </Card>
  );
}
