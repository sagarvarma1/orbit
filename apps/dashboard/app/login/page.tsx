"use client";

import { useEffect, useState } from "react";
import { AuthForm } from "@/components/auth-form";
import { useAuth } from "@/components/auth";
import { Logo } from "@/components/logo";
import { ErrorNote } from "@/components/ui";
import { API_URL } from "@/lib/api";

function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default function LoginPage() {
  const { github, signups } = useAuth();
  const [params, setParams] = useState<URLSearchParams | null>(null);
  useEffect(() => setParams(new URLSearchParams(window.location.search)), []);
  if (!params) return null;

  // The original admin's password sign-in stays reachable for recovery, and for instances
  // that haven't connected a GitHub App yet.
  if (!github || params.get("method") === "password") {
    return (
      <AuthForm
        title="Sign in to Orbit"
        subtitle="Use the admin account created when this instance was set up."
        endpoint="/api/auth/login"
        submitLabel="Sign In"
        footer="Forgot the password? Restart the API with ORBIT_RESET_ADMIN_PASSWORD set to a new one."
      />
    );
  }

  const next = params.get("next") ?? "/";
  const error = params.get("error");
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center py-16">
      <div className="mb-10 flex flex-col items-center text-center">
        <span className="text-white">
          <Logo size={36} />
        </span>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white">
          {signups ? "Deploy with Orbit" : "Sign in to Orbit"}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          {signups
            ? "Push to GitHub, get a live URL. Every branch gets a preview; rolling back takes a click."
            : "Sign-ups are closed on this instance. Existing accounts can sign in."}
        </p>
      </div>
      {error && (
        <div className="mb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <a
        href={`${API_URL}/api/auth/github?next=${encodeURIComponent(next)}`}
        className="flex h-12 items-center justify-center gap-3 rounded-lg bg-white text-[15px] font-medium text-black transition-colors hover:bg-white/90"
      >
        <GitHubMark />
        Continue with GitHub
      </a>
      <p className="mt-6 text-center text-xs leading-relaxed text-subtle">
        {signups ? "New here? Continuing creates your account. " : ""}Orbit only sees the repositories you choose to install it
        on.
      </p>
    </div>
  );
}
