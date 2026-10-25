"use client";

import { useEffect, useState } from "react";

/** Seconds since the browser started loading this page, ticking every frame. */
export function Since() {
  const [ms, setMs] = useState(null);
  useEffect(() => {
    let frame;
    const tick = () => {
      setMs(performance.now());
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, []);
  return <span className="tabular">{ms == null ? "0.00" : (ms / 1000).toFixed(2)}s</span>;
}
