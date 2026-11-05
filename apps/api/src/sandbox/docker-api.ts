import http from "node:http";

/** A minimal Docker Engine API client over the daemon's unix socket (no CLI process per call). */
export class DockerApi {
  constructor(readonly socketPath = "/var/run/docker.sock") {}

  /** JSON request; resolves with the parsed body, rejects with the daemon's message on >= 400. */
  async request<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const { status, text } = await this.raw(method, path, body, timeoutMs);
    if (status >= 400) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // plain text error
      }
      throw new DockerError(status, message.trim() || `Docker API ${method} ${path} failed (${status})`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private raw(method: string, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
          timeout: timeoutMs,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`Docker API ${method} ${path} timed out`)));
      req.on("error", reject);
      req.end(payload);
    });
  }

  /**
   * Follows a container's output. Docker multiplexes stdout and stderr in 8-byte-header frames
   * when the container has no TTY. Returns a function that stops following.
   */
  follow(id: string, onData: (stream: "stdout" | "stderr", text: string) => void): () => void {
    const req = http.request({
      socketPath: this.socketPath,
      method: "GET",
      path: `/containers/${id}/logs?follow=1&stdout=1&stderr=1`,
    });
    req.on("response", (res) => {
      let buffer = Buffer.alloc(0);
      res.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 8) {
          const size = buffer.readUInt32BE(4);
          if (buffer.length < 8 + size) break;
          const stream = buffer[0] === 2 ? "stderr" : "stdout";
          onData(stream, buffer.subarray(8, 8 + size).toString("utf8"));
          buffer = buffer.subarray(8 + size);
        }
      });
      res.on("error", () => {});
    });
    req.on("error", () => {});
    req.end();
    return () => req.destroy();
  }
}

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
