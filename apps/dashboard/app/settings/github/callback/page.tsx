"use client";

import { useEffect, useRef, useState } from "react";
import { ErrorNote, LinkButton, Spinner } from "@/components/ui";
import { api } from "@/lib/api";

/** GitHub redirects here after the app is created. Finish setup, then go install the app. */
export default function GitHubCallbackPage() {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setError("GitHub didn't send back a code. Start again from Settings.");
      return;
    }
    api<{ installUrl: string }>("/api/github/manifest/complete", { method: "POST", body: { code, state } })
      .then((res) => window.location.assign(res.installUrl))
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div className="mx-auto max-w-md space-y-4 py-20 text-center">
      {error ? (
        <>
          <ErrorNote>{error}</ErrorNote>
          <LinkButton href="/settings">Back to Settings</LinkButton>
        </>
      ) : (
        <p className="flex items-center justify-center gap-2 text-sm text-muted">
          <Spinner /> Connecting your GitHub App…
        </p>
      )}
    </div>
  );
}
