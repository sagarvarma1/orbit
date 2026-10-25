import { headers } from "next/headers";
import { Suspense } from "react";
import { Arrival } from "./components/Arrival";
import { LatencyLab } from "./components/LatencyLab";
import { Live } from "./components/Live";
import { Since } from "./components/Since";
import { Xray } from "./components/Xray";
import { countRequest } from "./lib/state";
import { hue } from "./theme";

// Rendered on the server for every request.
export const dynamic = "force-dynamic";

const SOURCES = [
  { id: "a", label: "Inventory", detail: "1,204 items in stock", delay: 300 },
  { id: "b", label: "Recommendations", detail: "8 picks for you", delay: 1100 },
  { id: "c", label: "Analytics", detail: "42,918 views today", delay: 2200 },
];

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)} days`;
}

/** A slow data source: the shell doesn't wait for it; its HTML streams in when it's done. */
async function Source({ source, startedAt }) {
  await new Promise((resolve) => setTimeout(resolve, source.delay));
  const finished = Date.now() - startedAt;
  return (
    <div className="card source done">
      <script
        dangerouslySetInnerHTML={{
          __html: `(window.__orbitArrive=window.__orbitArrive||{})[${JSON.stringify(source.id)}]=performance.now()`,
        }}
      />
      <div className="source-top">
        <span className="source-label">{source.label}</span>
        <span className="check">✓</span>
      </div>
      <div className="source-detail">{source.detail}</div>
      <dl className="source-times">
        <div>
          <dt>server finished</dt>
          <dd className="tabular">+{(finished / 1000).toFixed(2)}s</dd>
        </div>
        <div>
          <dt>reached your browser</dt>
          <dd>
            <Arrival id={source.id} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

function Pending({ source }) {
  return (
    <div className="card source">
      <div className="source-top">
        <span className="source-label">{source.label}</span>
        <span className="spinner" />
      </div>
      <div className="skeleton" />
      <div className="source-wait">waiting on a slow source ({(source.delay / 1000).toFixed(1)}s, simulated)</div>
    </div>
  );
}

function Section({ n, title, children, lede }) {
  return (
    <section className="section">
      <div className="section-head">
        <span className="section-n">{n}</span>
        <h2>{title}</h2>
        <p>{lede}</p>
      </div>
      {children}
    </section>
  );
}

export default async function Page() {
  const startedAt = Date.now();
  const { request, bootedAt } = countRequest();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const bootMs = startedAt - bootedAt;
  const woke = request === 1;

  const env = process.env;
  const deploymentUrl = env.ORBIT_URL;
  const commit = env.ORBIT_GIT_COMMIT_SHA;
  const message = env.ORBIT_GIT_COMMIT_MESSAGE?.split("\n")[0];
  const builtAgo = env.BUILT_AT ? duration(startedAt - Date.parse(env.BUILT_AT)) : null;
  const onAlias = deploymentUrl && !deploymentUrl.includes(host);

  return (
    <main>
      <header className="hero">
        <div className="orbit-art" aria-hidden="true">
          <div className="tilt">
            <div className="ring r1" />
            <div className="ring r2" />
            <div className="ring r3" />
          </div>
          <div className="planet" />
        </div>
        <div className="pill">
          <span className="dot on" /> Live · server-rendered on Orbit
        </div>
        <h1>
          This page didn&apos;t exist
          <br />
          until you asked for it.
        </h1>
        <p className="lede">
          A server built this HTML for you, just now, and is streaming parts of it as they finish. Everything below is live:
          nothing on this page is a recording.
        </p>
        <div className="hero-stats">
          <div className="hero-stat">
            <div className="stat-value accent">
              <Since />
            </div>
            <div className="stat-label">since you asked for this page</div>
          </div>
          <div className="hero-stat">
            <div className="stat-value tabular">#{request}</div>
            <div className="stat-label">request to this server</div>
          </div>
          <div className="hero-stat">
            <div className="stat-value tabular">{duration(bootMs)}</div>
            <div className="stat-label">since this server booted</div>
          </div>
        </div>
        {woke && (
          <div className="woke">
            <b>You woke this server up.</b> Nobody had visited in a while, so Orbit started a fresh Node.js server for this
            deployment {bootMs < 60_000 ? `${(bootMs / 1000).toFixed(1)}s` : ""} before rendering your page. Refresh: it&apos;s
            already warm.
          </div>
        )}
      </header>

      <Section
        n="01"
        title="Streamed, not waited for"
        lede="The page shell reached you first. Each card below waited on a slow source and streamed in over the same connection the moment it finished: React Suspense, through Orbit's edge."
      >
        <div className="sources">
          {SOURCES.map((source) => (
            <Suspense key={source.id} fallback={<Pending source={source} />}>
              <Source source={source} startedAt={startedAt} />
            </Suspense>
          ))}
        </div>
      </Section>

      <Section
        n="02"
        title="One room, one server"
        lede="Every deployment gets its own long-running server, so everyone looking at this page right now is connected to the same process."
      >
        <Live />
      </Section>

      <Section
        n="03"
        title="Feel the warm server"
        lede="Fire requests at this deployment's route handler and watch the round trips land."
      >
        <LatencyLab />
      </Section>

      <Section
        n="04"
        title="X-ray"
        lede="The real response headers your browser just got for this page. The x-orbit ones come from Orbit's edge."
      >
        <Xray />
      </Section>

      <Section
        n="05"
        title="Every push is a time machine"
        lede="Each git push builds a new immutable deployment with its own permanent URL. Rolling back moves a pointer: no rebuild, instant."
      >
        <div className="machine">
          <dl className="facts">
            <div>
              <dt>Environment</dt>
              <dd>{env.ORBIT_ENV ?? "local"}</dd>
            </div>
            <div>
              <dt>Deployment</dt>
              <dd className="mono">{env.ORBIT_DEPLOYMENT_ID ?? "local"}</dd>
            </div>
            <div>
              <dt>Commit</dt>
              <dd>
                <span className="mono">{commit ? commit.slice(0, 7) : "local"}</span>
                {message ? <span className="muted"> {message}</span> : null}
              </dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd className="mono">{env.ORBIT_GIT_COMMIT_REF ?? "local"}</dd>
            </div>
            <div>
              <dt>Built</dt>
              <dd>{builtAgo ? `${builtAgo} ago` : "just now"}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd className="mono">Node.js {process.version}</dd>
            </div>
            <div>
              <dt>Permanent URL</dt>
              <dd className="mono wrap">
                {deploymentUrl ? <a href={deploymentUrl}>{deploymentUrl.replace(/^https?:\/\//, "")}</a> : "local"}
              </dd>
            </div>
          </dl>
          <div className="card try">
            <div className="swatch" />
            <h3>Try it</h3>
            <p>
              This page&apos;s color comes from one number: <code>hue = {hue}</code> in <code>app/theme.js</code>. Change it and
              push. The new deployment gets the new color; the permanent URL on the left keeps this one forever. Roll back from
              the dashboard and this color is live again in an instant.
            </p>
            {onAlias && <p className="muted small">You&apos;re on {host}, an alias that points at this deployment.</p>}
          </div>
        </div>
      </Section>

      <footer className="footer">
        <span>
          Deployed with <b>Orbit</b>, a self-hosted deployment platform.
        </span>
        <a href="https://github.com/sagarvarma1/orbit/tree/main/examples/live">Source of this page</a>
      </footer>
    </main>
  );
}
