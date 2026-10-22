export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="6" fill="currentColor" />
      <ellipse cx="16" cy="16" rx="14" ry="6.5" stroke="currentColor" strokeWidth="2" transform="rotate(-30 16 16)" />
    </svg>
  );
}
