// Landing page motion: the product shot's deployments list, and the rollback timeline.
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Product shot: a push arrives, builds, and goes live in production. Illustrative, on a loop.
const COMMITS = [
  { msg: "Add gift cards", branch: "main", sha: "3e9b0c4" },
  { msg: "Fix cart badge on mobile", branch: "main", sha: "a71d5f2" },
  { msg: "Launch winter sale banner", branch: "main", sha: "c02e8b9" },
  { msg: "Faster search results", branch: "main", sha: "5bd41e7" },
];

function row({ msg, branch }) {
  const li = document.createElement("li");
  li.className = "enter";
  li.innerHTML = `<span class="dot building"></span><span class="d-msg"></span><span class="d-branch"></span><span class="d-env d-building">Building</span><span class="d-time">0s</span>`;
  li.querySelector(".d-msg").textContent = msg;
  li.querySelector(".d-branch").textContent = branch;
  return li;
}

async function playShot() {
  const list = document.getElementById("shot-list");
  const source = document.getElementById("shot-source");
  const preview = document.querySelector(".shot-preview");
  if (!list) return;
  for (let i = 0; ; i = (i + 1) % COMMITS.length) {
    await sleep(2600);
    const commit = COMMITS[i];
    const li = row(commit);
    list.prepend(li);
    const time = li.querySelector(".d-time");
    for (let s = 1; s <= 4; s++) {
      await sleep(700);
      time.textContent = `${s}s`;
    }
    // Ready: it becomes production, and the previous production steps back.
    list.querySelector(".d-prod")?.classList.remove("d-prod");
    li.querySelector(".dot").className = "dot ok";
    const env = li.querySelector(".d-env");
    env.className = "d-env d-prod";
    env.textContent = "Production";
    time.textContent = "just now";
    source.textContent = `${commit.branch} · ${commit.sha}`;
    preview.classList.remove("fresh");
    void preview.offsetWidth;
    preview.classList.add("fresh");
    while (list.children.length > 3) list.lastElementChild.remove();
  }
}

// Rollback: v4 ships with a problem, production points back at v3, then v4 is fixed and live.
async function playTimeline() {
  const nodes = [...document.querySelectorAll(".tl-node")];
  const text = document.getElementById("tl-text");
  const dot = document.getElementById("tl-dot");
  if (!nodes.length) return;
  const live = (v) => nodes.forEach((n) => n.classList.toggle("live", n.dataset.v === String(v)));
  const status = (message, cls) => {
    text.textContent = message;
    dot.className = `dot ${cls}`;
  };
  for (;;) {
    nodes[3].classList.remove("bad");
    live(4);
    status("v4 is live", "ok");
    await sleep(2200);
    nodes[3].classList.add("bad");
    status("v4 has a bug", "err");
    await sleep(1600);
    live(3);
    status("Rolled back to v3 instantly, no rebuild", "ok");
    await sleep(3200);
  }
}

if (reduceMotion) {
  document.querySelectorAll(".tl-node")[3]?.classList.add("live");
} else {
  playShot();
  playTimeline();
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
