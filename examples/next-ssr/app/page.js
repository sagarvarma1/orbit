import { headers } from "next/headers";

// Rendered on the server for every request, so each refresh shows new values.
export const dynamic = "force-dynamic";

const row = { display: "flex", justifyContent: "space-between", gap: 24, padding: "10px 0", borderTop: "1px solid #1f1f1f" };
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "#a1a1a1" };

export default async function Page() {
  const h = await headers();
  const renderedAt = new Date();
  const facts = [
    ["Rendered at", renderedAt.toISOString().replace("T", " ").slice(0, 23) + " UTC"],
    ["Host", h.get("host") ?? "unknown"],
    ["Deployment", process.env.ORBIT_DEPLOYMENT_ID ?? "local"],
    ["Commit", (process.env.ORBIT_GIT_COMMIT_SHA ?? "local").slice(0, 7)],
    ["Node.js", process.version],
  ];
  return (
    <main style={{ width: "min(560px, calc(100vw - 32px))" }}>
      <p style={{ ...mono, fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase" }}>Next.js on Orbit</p>
      <h1 style={{ fontSize: 40, letterSpacing: "-0.04em", margin: "8px 0 24px" }}>Rendered on the server.</h1>
      <div style={{ borderBottom: "1px solid #1f1f1f" }}>
        {facts.map(([label, value]) => (
          <div key={label} style={row}>
            <span>{label}</span>
            <span style={mono}>{value}</span>
          </div>
        ))}
      </div>
      <p style={{ color: "#6b6b6b", fontSize: 14, marginTop: 20 }}>
        Refresh the page: the time changes because this HTML was built for this request. JSON from a route handler:{" "}
        <a href="/api/now" style={{ color: "#52a8ff" }}>
          /api/now
        </a>
      </p>
    </main>
  );
}
