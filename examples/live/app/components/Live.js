"use client";

import { useEffect, useRef, useState } from "react";
import { sendPulse } from "../actions";

let nextRing = 0;

export function Live() {
  const [state, setState] = useState({ online: null, pulses: null, connected: false, full: false });
  const [rings, setRings] = useState([]);
  const me = useRef(null);

  function addRing(hue, mine) {
    const ring = { key: nextRing++, hue, mine, x: 12 + Math.random() * 76, y: 18 + Math.random() * 64 };
    setRings((all) => [...all.slice(-40), ring]);
    setTimeout(() => setRings((all) => all.filter((r) => r.key !== ring.key)), 1800);
  }

  useEffect(() => {
    me.current = { id: Math.random().toString(36).slice(2, 10), hue: Math.floor(Math.random() * 360) };
    const events = new EventSource("/api/live");
    events.onerror = () => setState((s) => ({ ...s, connected: false }));
    events.onmessage = (message) => {
      const event = JSON.parse(message.data);
      if (event.type === "full") {
        events.close();
        setState((s) => ({ ...s, full: true }));
        return;
      }
      setState({ online: event.online, pulses: event.pulses, connected: true, full: false });
      if (event.type === "pulse" && event.from !== me.current.id) addRing(event.hue, false);
    };
    return () => events.close();
  }, []);

  function pulse() {
    if (!me.current) return;
    addRing(me.current.hue, true);
    sendPulse(me.current.id, me.current.hue).catch(() => {});
  }

  const others = state.online == null ? null : Math.max(0, state.online - 1);
  return (
    <div className="live">
      <div className="live-stats">
        <div>
          <div className="stat-value tabular">{state.online ?? "–"}</div>
          <div className="stat-label">
            <span className={`dot ${state.connected ? "on" : ""}`} />
            {state.full
              ? "too busy, try again soon"
              : others == null
                ? "connecting…"
                : others === 0
                  ? "here now: just you"
                  : `here now: you + ${others}`}
          </div>
        </div>
        <div>
          <div className="stat-value tabular">{state.pulses ?? "–"}</div>
          <div className="stat-label">pulses since this server booted</div>
        </div>
      </div>
      <div className="arena" onClick={pulse} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && pulse()}>
        {rings.map((r) => (
          <span
            key={r.key}
            className={`ring-pulse ${r.mine ? "mine" : ""}`}
            style={{ left: `${r.x}%`, top: `${r.y}%`, "--h": r.hue }}
          />
        ))}
        <span className="arena-hint">Tap anywhere to send a pulse</span>
      </div>
      <p className="note">
        Open this page on your phone too, then tap. Each tap calls a <b>Server Action</b>; the server pushes it to every open tab
        over one <b>streaming response</b> through Orbit&apos;s edge. No database, no websocket service: one warm server holds the
        room.
      </p>
    </div>
  );
}
