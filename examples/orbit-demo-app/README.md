# orbit-demo-app

A Vite + React badge you can drag, fling and flip, deployed with [Orbit](../../README.md):

- The badge hangs from a lanyard simulated with a spring and gravity (`src/Badge.jsx`, no 3D library).
- Its accent color comes from the commit SHA, so every deployment looks different.
- The back shows the commit, branch and deployment ID Orbit injected at build time
  (`ORBIT_GIT_COMMIT_SHA`, `ORBIT_GIT_COMMIT_REF`, `ORBIT_DEPLOYMENT_ID`), plus a live response from the function.
- `VITE_MESSAGE` (set it in Orbit's Environment Variables) replaces the tagline.
- `api/hello.js` is a serverless function served at `/api/hello`.
- `vercel.json` adds routing rules that Orbit applies at the edge:
  - `/old-about` permanently redirects (308) to `/about`
  - `/hello/<name>` is rewritten to the function, so `/hello/sagar` returns `/api/hello?name=sagar` with the URL unchanged
  - every response gets `X-Content-Type-Options: nosniff` and `X-Powered-By: Orbit`

Push this folder to your own public GitHub repo, then import it in Orbit.
