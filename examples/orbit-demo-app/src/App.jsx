import { useEffect, useState } from "react";
import Badge from "./Badge.jsx";

// Change this line (or the tagline) and push a commit to see a new deployment.
const VERSION = "v1";
const TAGLINE = "I build things.";

const env = import.meta.env;
const sha = env.ORBIT_GIT_COMMIT_SHA ?? "0f6e3a9";

// Every commit gets its own color, so two deployments side by side look different.
const hue = parseInt(sha.slice(0, 6), 16) % 360;

export default function App() {
  const [fn, setFn] = useState(null);

  useEffect(() => {
    fetch("/api/hello?name=recruiter")
      .then((res) => res.json())
      .then(setFn)
      .catch(() => setFn(null));
  }, []);

  return (
    <div className="stage" style={{ "--hue": hue }}>
      <header className="top">
        <span className="wordmark">sagar varma</span>
        <span className="env">{env.ORBIT_ENV ?? "local"}</span>
      </header>

      <Badge
        front={
          <div className="face-inner">
            <div className="card-head">
              <span className="logo">◎ ORBIT</span>
              <span className="version">{VERSION}</span>
            </div>
            <div className="avatar">SV</div>
            <h1>Sagar Varma</h1>
            <p className="role">Computer Engineering · UCSB</p>
            <p className="tagline">{env.VITE_MESSAGE ?? TAGLINE}</p>
            <ul className="stints">
              <li>Intel</li>
              <li>SemiAnalysis</li>
              <li>Avora (YC F24)</li>
              <li>Perplexity</li>
            </ul>
            <div className="card-foot">
              <span>ACCESS</span>
              <strong>ALL STAGES</strong>
            </div>
          </div>
        }
        back={
          <div className="face-inner back-inner">
            <div className="card-head">
              <span className="logo">◎ ORBIT</span>
              <span className="version">{VERSION}</span>
            </div>
            <p className="back-title">Deployed on Orbit</p>
            <p className="back-sub">a deployment platform I built from scratch</p>
            <dl>
              <dt>commit</dt>
              <dd>{sha.slice(0, 7)}</dd>
              <dt>branch</dt>
              <dd>{env.ORBIT_GIT_COMMIT_REF ?? "local"}</dd>
              <dt>deployment</dt>
              <dd>{env.ORBIT_DEPLOYMENT_ID ?? "dev server"}</dd>
              <dt>function</dt>
              <dd>{fn ? `${fn.message} · ${new Date(fn.time).toLocaleTimeString()}` : "…"}</dd>
            </dl>
            <a className="site" href="https://sagar-varma.com" target="_blank" rel="noreferrer" onPointerDown={(e) => e.stopPropagation()}>
              sagar-varma.com ↗
            </a>
          </div>
        }
      />

      <p className="hint">drag it · fling it · tap to flip</p>
    </div>
  );
}
