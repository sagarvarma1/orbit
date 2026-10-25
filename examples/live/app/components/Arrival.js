"use client";

import { useEffect, useState } from "react";

/**
 * When this streamed chunk reached the browser. The chunk carries a tiny inline script that stamps
 * the moment the HTML was parsed; after a client-side navigation it falls back to mount time.
 */
export function Arrival({ id }) {
  const [at, setAt] = useState(null);
  useEffect(() => {
    setAt(window.__orbitArrive?.[id] ?? performance.now());
  }, [id]);
  return <span className="tabular">{at == null ? "…" : `+${(at / 1000).toFixed(2)}s`}</span>;
}
