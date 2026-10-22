"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import type { DeploymentStatus } from "@/lib/types";

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-white text-black hover:bg-white/90 border border-white",
  secondary: "bg-bg text-fg border border-line-strong hover:border-subtle hover:bg-raised",
  ghost: "text-muted hover:text-fg hover:bg-raised border border-transparent",
  danger: "bg-err/10 text-err border border-err/40 hover:bg-err/20",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  loading?: boolean;
}

export function Button({ variant = "secondary", size = "md", loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-9 px-4 text-sm",
        VARIANTS[variant],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = "secondary",
  external,
  children,
  className,
}: {
  href: string;
  variant?: Variant;
  external?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const classes = cx(
    "inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors",
    VARIANTS[variant],
    className,
  );
  return external ? (
    <a href={href} target="_blank" rel="noreferrer" className={classes}>
      {children}
    </a>
  ) : (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("h-3.5 w-3.5 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Card({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={cx("rounded-lg border border-line bg-surface", className)}>{children}</div>;
}

const STATUS: Record<DeploymentStatus, { label: string; dot: string; text: string }> = {
  queued: { label: "Queued", dot: "bg-subtle", text: "text-muted" },
  building: { label: "Building", dot: "bg-warn animate-orbit-pulse", text: "text-warn" },
  ready: { label: "Ready", dot: "bg-ok", text: "text-fg" },
  error: { label: "Error", dot: "bg-err", text: "text-err" },
  canceled: { label: "Canceled", dot: "bg-subtle", text: "text-muted" },
};

export function StatusDot({ status }: { status: DeploymentStatus }) {
  return <span className={cx("inline-block h-2.5 w-2.5 shrink-0 rounded-full", STATUS[status].dot)} />;
}

export function StatusBadge({ status }: { status: DeploymentStatus }) {
  return (
    <span className={cx("inline-flex items-center gap-2 text-sm", STATUS[status].text)}>
      <StatusDot status={status} />
      {STATUS[status].label}
    </span>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "info" | "ok" | "warn" }) {
  const tones = {
    neutral: "border-line-strong text-muted",
    info: "border-info/40 text-info bg-info/10",
    ok: "border-ok/40 text-ok bg-ok/10",
    warn: "border-warn/40 text-warn bg-warn/10",
  };
  return (
    <span className={cx("inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium", tones[tone])}>
      {children}
    </span>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        "h-9 w-full rounded-md border border-line-strong bg-bg px-3 text-sm text-fg placeholder:text-subtle outline-none transition-colors focus:border-muted disabled:opacity-60",
        props.className,
      )}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        "h-9 w-full rounded-md border border-line-strong bg-bg px-3 text-sm text-fg outline-none focus:border-muted",
        props.className,
      )}
    />
  );
}

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <span className="text-[13px] font-medium text-muted">{children}</span>
      {hint && <span className="text-xs text-subtle">{hint}</span>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{children}</div>;
}

export function ExternalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3h7v7M13 3 4 12" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
      <circle cx="4.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="5.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.25v5.5M11.5 7.25c0 2.5-3 2.5-6.2 4" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function CommitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1 8h4.5M10.5 8H15" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 border-b border-line py-10 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="truncate text-3xl font-semibold tracking-tight text-white">{title}</h1>
        {subtitle && <div className="mt-2 text-sm text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export { cx };
