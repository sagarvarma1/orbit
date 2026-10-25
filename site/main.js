// Hero terminal: an illustrative Orbit build log (same format as the real one), replayed line by line.
// `t` is the elapsed build time shown in the gutter; `wait` is the pause before the line appears.
const LINES = [
  { text: "$ git push origin main", cls: "t-cmd", wait: 900, typed: true },
  { text: "Build started for orbit-demo (production)", t: 0.0, wait: 450 },
  { text: 'Cloned 4f2a9c1 "Update hero copy" in 1.1s', t: 1.1, wait: 350 },
  { text: "Framework: Vite · package manager: npm · builder: docker", t: 1.1, wait: 300 },
  { text: "Routing from vercel.json: 1 redirect, 1 rewrite, 1 header rule", t: 1.1, wait: 300 },
  { text: "Restored build cache (lockfile unchanged)", t: 1.3, wait: 500 },
  { text: "Build completed in 3.8s", t: 5.1, wait: 900 },
  { text: "Collected 9 static files (412.6 KB)", t: 5.2, wait: 250 },
  { text: "Bundled 1 function(s): /api/hello", t: 5.4, wait: 250 },
  { text: "GitHub: commit status set to success", t: 5.9, wait: 400 },
  { text: "✓ Ready  https://orbit-demo.orbitdeploy.dev", cls: "t-ok", t: 5.9, wait: 300 },
];

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const code = document.querySelector("#terminal code");

function line(text, cls, seconds) {
  const row = document.createElement("div");
  if (seconds != null) {
    const time = document.createElement("span");
    time.className = "t-time";
    time.textContent = `${seconds.toFixed(1).padStart(4, " ")}s  `;
    row.append(time);
  }
  const body = document.createElement("span");
  if (cls) body.className = cls;
  if (cls === "t-ok") {
    // Highlight the URL in the final line.
    const [label, url] = text.split(/\s{2}/);
    body.textContent = `${label}  `;
    const link = document.createElement("span");
    link.className = "t-url";
    link.textContent = url;
    row.append(body, link);
  } else {
    body.textContent = text;
    row.append(body);
  }
  code.append(row);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function play() {
  for (;;) {
    code.textContent = "";
    for (const l of LINES) {
      await sleep(l.wait);
      if (l.typed) {
        const target = line("", l.cls, null);
        const cursor = document.createElement("span");
        cursor.className = "cursor";
        target.after(cursor);
        for (const ch of l.text) {
          target.textContent += ch;
          await sleep(45);
        }
        await sleep(350);
        cursor.remove();
      } else {
        line(l.text, l.cls, l.t);
      }
    }
    await sleep(5000);
  }
}

if (code) {
  if (reduceMotion) {
    for (const l of LINES) line(l.text, l.cls, l.typed ? null : l.t);
  } else {
    play();
  }
}

// Copy buttons
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const text = document.getElementById(button.dataset.copy)?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select & copy";
    }
    setTimeout(() => (button.textContent = "Copy"), 1600);
  });
}
