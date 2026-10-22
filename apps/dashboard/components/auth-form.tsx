"use client";

import { type FormEvent, type ReactNode, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "./auth";
import { Logo } from "./logo";
import { Button, Card, ErrorNote, Input, Label } from "./ui";

/** Shared shell for the sign-in and first-run setup pages. */
export function AuthForm({
  title,
  subtitle,
  endpoint,
  withCode,
  submitLabel,
  footer,
}: {
  title: string;
  subtitle: ReactNode;
  endpoint: string;
  withCode?: boolean;
  submitLabel: string;
  footer?: ReactNode;
}) {
  const { refresh } = useAuth();
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(endpoint, { method: "POST", body: withCode ? { code, email, password } : { email, password } });
      // AuthProvider then sends us on to ?next=.
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm py-20">
      <div className="mb-8 flex flex-col items-center text-center">
        <span className="text-white">
          <Logo />
        </span>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-white">{title}</h1>
        <p className="mt-2 text-sm text-muted">{subtitle}</p>
      </div>
      <Card className="p-6">
        <form onSubmit={submit} className="space-y-4">
          {withCode && (
            <div>
              <Label hint="Printed in the API logs">Setup Code</Label>
              <Input
                autoFocus
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XXXX-XXXX"
                className="font-mono uppercase"
              />
            </div>
          )}
          <div>
            <Label>Email</Label>
            <Input
              type="email"
              autoComplete="email"
              autoFocus={!withCode}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <Label hint={withCode ? "At least 10 characters" : undefined}>Password</Label>
            <Input
              type="password"
              autoComplete={withCode ? "new-password" : "current-password"}
              required
              minLength={withCode ? 10 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            {submitLabel}
          </Button>
        </form>
      </Card>
      {footer && <p className="mt-6 text-center text-xs text-subtle">{footer}</p>}
    </div>
  );
}
