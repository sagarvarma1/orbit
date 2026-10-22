const LOGO = `<svg width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden="true"><circle cx="16" cy="16" r="6" fill="currentColor"/><ellipse cx="16" cy="16" rx="14" ry="6.5" stroke="currentColor" stroke-width="2" transform="rotate(-30 16 16)"/></svg>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

interface PageOptions {
  status: number;
  code: string;
  title: string;
  detail?: string;
  /** Auto-refresh (seconds), used while a deployment is building. */
  refresh?: number;
}

/** Platform-level pages served by the edge (not by a deployment). */
export function platformPage({ status, code, title, detail, refresh }: PageOptions): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}
<title>${status}: ${escapeHtml(code)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #ededed;
         font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { text-align: center; padding: 24px; }
  .logo { color: #fff; margin-bottom: 28px; display: inline-flex; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  h1 span { color: #888; font-weight: 400; margin-right: 12px; padding-right: 12px; border-right: 1px solid #333; }
  p { color: #888; margin: 12px 0 0; }
  code { display: inline-block; margin-top: 20px; padding: 4px 10px; border: 1px solid #222; border-radius: 6px;
         color: #aaa; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
</style></head>
<body><main>
  <div class="logo">${LOGO}</div>
  <h1><span>${status}</span>${escapeHtml(title)}</h1>
  ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
  <code>${escapeHtml(code)}</code>
</main></body></html>`;
}
