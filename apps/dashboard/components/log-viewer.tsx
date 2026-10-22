"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "@/lib/api";
import type { DeploymentStatus, LogLine } from "@/lib/types";
import { Input, Spinner, cx } from "./ui";

/**
 * Streams build logs over SSE. The server replays everything first, then tails the live
 * build; EventSource reconnects resume from Last-Event-ID, so lines are never duplicated.
 */
function useLogStream(deploymentId: string, onEnd: (status: DeploymentStatus) => void) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [state, setState] = useState<"connecting" | "streaming" | "done">("connecting");
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    setLines([]);
    setState("connecting");
    const source = new EventSource(`${API_URL}/api/deployments/${deploymentId}/logs/stream`);
    let buffer: LogLine[] = [];
    let frame = 0;
    // Batch lines per animation frame: npm installs can emit hundreds of lines per second.
    const flush = () => {
      frame = 0;
      const batch = buffer;
      buffer = [];
      setLines((prev) => {
        const lastSeq = prev.length ? prev[prev.length - 1]!.seq : -1;
        return [...prev, ...batch.filter((l) => l.seq > lastSeq)];
      });
    };
    source.addEventListener("open", () => setState("streaming"));
    source.addEventListener("line", (e) => {
      buffer.push(JSON.parse((e as MessageEvent<string>).data) as LogLine);
      if (!frame) frame = requestAnimationFrame(flush);
    });
    source.addEventListener("end", (e) => {
      source.close();
      flush();
      setState("done");
      onEndRef.current((JSON.parse((e as MessageEvent<string>).data) as { status: DeploymentStatus }).status);
    });
    return () => {
      source.close();
      cancelAnimationFrame(frame);
    };
  }, [deploymentId]);

  return { lines, state };
}

const fmtElapsed = (ms: number) => {
  const s = Math.max(0, ms / 1000);
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
};

export function LogViewer({ deploymentId, onEnd }: { deploymentId: string; onEnd: (status: DeploymentStatus) => void }) {
  const { lines, state } = useLogStream(deploymentId, onEnd);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const [stderrOnly, setStderrOnly] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const start = lines[0]?.t ?? 0;
  const visible = useMemo(() => {
    const q = query.toLowerCase();
    return lines.filter((l) => (!stderrOnly || l.stream === "stderr") && (!q || l.text.toLowerCase().includes(q)));
  }, [lines, query, stderrOnly]);
  const errorCount = useMemo(() => lines.filter((l) => l.stream === "stderr").length, [lines]);

  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [visible, follow]);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="text-sm font-medium text-white">Build Logs</span>
        <span className="text-xs text-muted">{lines.length} lines</span>
        {state !== "done" && (
          <span className="flex items-center gap-1.5 text-xs text-warn">
            <Spinner className="h-3 w-3" /> {state === "connecting" ? "Connecting" : "Live"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setStderrOnly((v) => !v)}
            className={cx(
              "h-8 whitespace-nowrap rounded-md border px-2.5 text-xs",
              stderrOnly ? "border-warn/50 text-warn" : "border-line-strong text-muted hover:text-fg",
            )}
          >
            stderr {errorCount}
          </button>
          <Input
            placeholder="Find in logs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-44 text-xs"
          />
          <button
            onClick={() => setFollow((v) => !v)}
            className={cx(
              "h-8 whitespace-nowrap rounded-md border px-2.5 text-xs",
              follow ? "border-line-strong text-fg" : "border-line text-subtle",
            )}
            title="Auto-scroll"
          >
            Follow {follow ? "on" : "off"}
          </button>
        </div>
      </div>
      <div
        ref={scroller}
        onWheel={(e) => e.deltaY < 0 && setFollow(false)}
        className="h-[520px] overflow-auto py-2 font-mono text-[12.5px] leading-[1.6]"
      >
        {visible.length === 0 && state !== "done" && <div className="px-4 py-2 text-muted">Waiting for build output…</div>}
        {visible.map((line) => (
          <div key={line.seq} className="group flex gap-4 px-4 hover:bg-white/[0.03]">
            <span className="w-14 shrink-0 select-none text-right text-subtle">{fmtElapsed(line.t - start)}</span>
            <span
              className={cx(
                "min-w-0 whitespace-pre-wrap break-words",
                line.stream === "stderr" && "text-warn",
                line.stream === "system" && "font-medium text-white",
                line.stream === "system" && /^Error/.test(line.text) && "text-err",
                line.stream === "stdout" && "text-[#c7c7c7]",
              )}
            >
              {line.stream === "system" ? `› ${line.text}` : line.text || " "}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
