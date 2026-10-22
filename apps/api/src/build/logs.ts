import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

export type LogStream = "stdout" | "stderr" | "system";

export interface LogLine {
  /** Sequence number within the deployment, used by SSE `Last-Event-ID` resumption. */
  seq: number;
  /** Unix ms. */
  t: number;
  stream: LogStream;
  text: string;
}

export type LogEvent = { type: "line"; line: LogLine } | { type: "end"; status: string };

interface ActiveLog {
  lines: LogLine[];
  file: fs.WriteStream;
  /** Partial (newline-less) output per stream, flushed when a newline arrives. */
  partial: Record<LogStream, string>;
}

const MAX_LINE_LENGTH = 4000;

/**
 * Build logs: persisted as NDJSON (one file per deployment) and fanned out live.
 *
 * While a build runs its lines are also kept in memory, so a subscriber can replay the
 * buffer and attach to the live stream in the same tick with no gap and no duplicates.
 */
export class LogStore {
  private readonly active = new Map<string, ActiveLog>();
  private readonly emitter = new EventEmitter();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.emitter.setMaxListeners(0);
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.ndjson`);
  }

  open(id: string): void {
    if (this.active.has(id)) return;
    this.active.set(id, {
      lines: [],
      file: fs.createWriteStream(this.file(id), { flags: "a" }),
      partial: { stdout: "", stderr: "", system: "" },
    });
  }

  /** Append raw process output; splits on newlines and handles carriage-return progress bars. */
  write(id: string, stream: LogStream, chunk: string): void {
    const log = this.active.get(id);
    if (!log) return;
    const text = log.partial[stream] + chunk;
    const parts = text.split(/\r?\n/);
    log.partial[stream] = parts.pop() ?? "";
    for (const part of parts) this.push(id, log, stream, part);
  }

  system(id: string, message: string): void {
    const log = this.active.get(id);
    if (log) this.push(id, log, "system", message);
  }

  private push(id: string, log: ActiveLog, stream: LogStream, raw: string): void {
    // Keep only what a terminal would show after carriage returns (spinners, progress bars).
    let text = raw.includes("\r") ? (raw.split("\r").filter(Boolean).pop() ?? "") : raw;
    // Strip ANSI escape sequences; the dashboard renders plain text.
    text = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    if (text.length > MAX_LINE_LENGTH) text = `${text.slice(0, MAX_LINE_LENGTH)}… [truncated]`;
    const line: LogLine = { seq: log.lines.length, t: Date.now(), stream, text };
    log.lines.push(line);
    log.file.write(`${JSON.stringify(line)}\n`);
    this.emitter.emit(id, { type: "line", line } satisfies LogEvent);
  }

  /** Flush partial lines, close the file and notify subscribers that the stream ended. */
  async close(id: string, status: string): Promise<void> {
    const log = this.active.get(id);
    if (!log) return;
    for (const stream of ["stdout", "stderr"] as const) {
      if (log.partial[stream]) this.push(id, log, stream, log.partial[stream]);
    }
    await new Promise<void>((resolve) => log.file.end(resolve));
    this.active.delete(id);
    this.emitter.emit(id, { type: "end", status } satisfies LogEvent);
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  /** All lines so far: from memory for running builds, from disk for finished ones. */
  read(id: string): LogLine[] {
    const log = this.active.get(id);
    if (log) return [...log.lines];
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(id), "utf8");
    } catch {
      return [];
    }
    const lines: LogLine[] = [];
    for (const row of raw.split("\n")) {
      if (!row) continue;
      try {
        lines.push(JSON.parse(row) as LogLine);
      } catch {
        // A torn final line from a crash; skip it.
      }
    }
    return lines;
  }

  /**
   * Replay existing lines then follow live output. Replay + subscribe happen synchronously,
   * so no line can slip between them. Pass `pending` for a queued build whose log hasn't
   * opened yet, to receive it from the first line. Returns an unsubscribe function.
   */
  follow(id: string, onEvent: (event: LogEvent) => void, afterSeq = -1, pending = false): () => void {
    for (const line of this.read(id)) if (line.seq > afterSeq) onEvent({ type: "line", line });
    if (!this.active.has(id) && !pending) return () => {};
    this.emitter.on(id, onEvent);
    return () => this.emitter.off(id, onEvent);
  }

  remove(id: string): void {
    fs.rmSync(this.file(id), { force: true });
  }
}
