import { snapshot, subscribe } from "../../lib/state";

export const dynamic = "force-dynamic";

// A server-sent event stream: presence and pulses, pushed through Orbit's edge as they happen.
export function GET(request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (text) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      send(`retry: 2000\ndata: ${JSON.stringify({ type: "hello", ...snapshot() })}\n\n`);
      const unsubscribe = subscribe(send);
      if (!unsubscribe) {
        send(`data: ${JSON.stringify({ type: "full" })}\n\n`);
        controller.close();
        return;
      }
      const heartbeat = setInterval(() => send(": keep-alive\n\n"), 15_000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
