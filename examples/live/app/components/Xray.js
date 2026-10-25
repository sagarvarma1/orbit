"use client";

import { useEffect, useState } from "react";

const INTERESTING = /^(x-orbit|x-nextjs|x-powered-by|content-type|cache-control|server|vary)/;

/** The real response headers for this page, fetched again from the browser. */
export function Xray() {
  const [headers, setHeaders] = useState(null);
  const [took, setTook] = useState(null);

  async function load() {
    const started = performance.now();
    const res = await fetch(window.location.pathname, { method: "HEAD", cache: "no-store" });
    setTook(performance.now() - started);
    setHeaders([...res.headers.entries()].filter(([name]) => INTERESTING.test(name)).sort(([a], [b]) => a.localeCompare(b)));
  }

  useEffect(() => {
    load().catch(() => setHeaders([]));
  }, []);

  return (
    <div className="xray">
      <div className="terminal">
        <div className="terminal-bar">
          <span />
          <span />
          <span />
          <em>HEAD this page</em>
        </div>
        <pre>
          {headers == null
            ? "requesting…"
            : headers.length === 0
              ? "no headers (running locally?)"
              : headers.map(([name, value]) => (
                  <div key={name} className={name.startsWith("x-orbit") ? "hl" : ""}>
                    <span className="h-name">{name}</span>: {value}
                  </div>
                ))}
          {took != null && <div className="h-took">{`\n# round trip ${took.toFixed(0)}ms`}</div>}
        </pre>
      </div>
      <button className="button ghost" onClick={() => load().catch(() => {})}>
        Request again
      </button>
    </div>
  );
}
