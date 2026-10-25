"use client";

import { useState } from "react";

const COUNT = 24;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function LatencyLab() {
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    const results = [];
    setRows([]);
    try {
      for (let i = 0; i < COUNT; i++) {
        const started = performance.now();
        const res = await fetch(`/api/ping?i=${i}&t=${Date.now()}`, { cache: "no-store" });
        const body = await res.json();
        results.push({
          ms: performance.now() - started,
          instance: res.headers.get("x-orbit-instance"),
          request: body.request,
        });
        setRows([...results]);
      }
    } finally {
      setRunning(false);
    }
  }

  const max = Math.max(50, ...rows.map((r) => r.ms));
  const times = rows.map((r) => r.ms);
  return (
    <div className="lab">
      <div className="lab-head">
        <button className="button" onClick={run} disabled={running}>
          {running ? `Firing… ${rows.length}/${COUNT}` : rows.length ? "Fire again" : `Fire ${COUNT} requests`}
        </button>
        <div className="lab-stats">
          <span>
            median <b className="tabular">{rows.length ? `${median(times).toFixed(0)}ms` : "–"}</b>
          </span>
          <span>
            fastest <b className="tabular">{rows.length ? `${Math.min(...times).toFixed(0)}ms` : "–"}</b>
          </span>
          <span>
            server requests <b className="tabular">{rows.length ? `#${rows[0].request}–#${rows.at(-1).request}` : "–"}</b>
          </span>
        </div>
      </div>
      <div className="bars" aria-label="Round-trip times">
        {Array.from({ length: COUNT }, (_, i) => {
          const row = rows[i];
          return (
            <div key={i} className="bar-slot" title={row ? `${row.ms.toFixed(1)}ms · ${row.instance ?? "local"}` : ""}>
              <div
                className={`bar ${row?.instance === "cold" ? "cold" : ""}`}
                style={{ height: row ? `${Math.max(4, (row.ms / max) * 100)}%` : "0%" }}
              />
            </div>
          );
        })}
      </div>
      <p className="note">
        Every bar is a real round trip from your browser to this deployment&apos;s server and back, timed here. The server stays
        warm between requests, so after the first visit nothing boots.
        {rows.some((r) => r.instance === "cold") ? " The highlighted bar booted the server." : ""}
      </p>
    </div>
  );
}
