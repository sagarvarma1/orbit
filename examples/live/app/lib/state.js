// State for this one server process. Every deployment on Orbit gets its own long-running server,
// so everyone viewing a deployment shares this object until the server sleeps when idle.
// It lives on globalThis because Next bundles pages, route handlers and actions separately.
const store = (globalThis.__orbitLive ??= {
  bootedAt: Date.now() - Math.round(process.uptime() * 1000),
  requests: 0,
  pulses: 0,
  recent: [],
  listeners: new Set(),
});

const MAX_LISTENERS = 500;
const MAX_PULSES_PER_SECOND = 40;

export function countRequest() {
  store.requests += 1;
  return { request: store.requests, bootedAt: store.bootedAt };
}

export function snapshot() {
  return { online: store.listeners.size, pulses: store.pulses, requests: store.requests };
}

function broadcast(event) {
  const frame = `data: ${JSON.stringify({ ...event, ...snapshot() })}\n\n`;
  for (const send of store.listeners) send(frame);
}

/** Registers an event-stream writer; returns the unsubscribe function, or null when full. */
export function subscribe(send) {
  if (store.listeners.size >= MAX_LISTENERS) return null;
  store.listeners.add(send);
  broadcast({ type: "presence" });
  return () => {
    if (store.listeners.delete(send)) broadcast({ type: "presence" });
  };
}

export function pulse(from, hue) {
  const now = Date.now();
  store.recent = store.recent.filter((t) => now - t < 1000);
  if (store.recent.length >= MAX_PULSES_PER_SECOND) return false;
  store.recent.push(now);
  store.pulses += 1;
  broadcast({ type: "pulse", from, hue });
  return true;
}
