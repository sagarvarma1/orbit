"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { Spinner } from "./ui";

export interface User {
  id: string;
  email: string;
  role: "admin" | "member";
  githubLogin: string | null;
  name: string | null;
  avatarUrl: string | null;
  hasPassword: boolean;
}

interface AuthStatus {
  user: User | null;
  setupRequired: boolean;
  /** "Sign in with GitHub" is available (a GitHub App is connected). */
  github: boolean;
  /** Anyone may create an account. */
  signups: boolean;
}

interface AuthState extends AuthStatus {
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const PUBLIC_PAGES = new Set(["/login", "/setup"]);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** Loads the signed-in user and keeps signed-out visitors on the login and setup pages. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<AuthStatus & { loaded: boolean }>({
    loaded: false,
    user: null,
    setupRequired: false,
    github: false,
    signups: false,
  });

  const refresh = useCallback(async () => {
    try {
      const status = await api<AuthStatus>("/api/auth/status");
      setState({ loaded: true, ...status });
    } catch {
      setState({ loaded: true, user: null, setupRequired: false, github: false, signups: false });
    }
  }, []);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    setState((s) => ({ ...s, user: null }));
    router.replace("/login");
  }, [router]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isPublic = PUBLIC_PAGES.has(pathname);
  useEffect(() => {
    if (!state.loaded) return;
    if (state.setupRequired && pathname !== "/setup") router.replace("/setup");
    else if (!state.setupRequired && !state.user && !isPublic) {
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    } else if (state.user && isPublic) {
      const next = new URLSearchParams(window.location.search).get("next");
      // Only same-site paths, so ?next= can't bounce people to another website.
      // Browsers treat "/\evil.com" like "//evil.com", hence the backslash check.
      router.replace(next && /^\/(?![/\\])/.test(next) ? next : "/");
    }
  }, [state, pathname, isPublic, router]);

  const ready = state.loaded && (isPublic ? !state.user : Boolean(state.user));
  return (
    <AuthContext.Provider
      value={{
        user: state.user,
        setupRequired: state.setupRequired,
        github: state.github,
        signups: state.signups,
        refresh,
        logout,
      }}
    >
      {ready ? (
        children
      ) : (
        <div className="flex items-center gap-2 py-16 text-sm text-muted">
          <Spinner /> Loading…
        </div>
      )}
    </AuthContext.Provider>
  );
}
