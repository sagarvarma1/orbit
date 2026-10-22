import { useEffect, useRef } from "react";

// A badge hanging from a lanyard, simulated the way games do ropes and ragdolls:
// - The card is a rigid rod between two points (the clip and the bottom edge), moved with Verlet
//   integration and kept rigid by distance constraints (Jakobsen, "Advanced Character Physics").
//   The lanyard is an inextensible max-distance constraint, so it never stretches or jitters.
// - Physics runs at a fixed 120 Hz step and rendering interpolates between steps
//   (Fiedler, "Fix Your Timestep"), so it looks the same at 60, 120 or 144 fps.
// - Spinning coasts with friction, then a damped spring settles it on the nearest face.
// Everything runs in one requestAnimationFrame loop that writes styles directly, no re-renders.

const DT = 1 / 120;
const GRAVITY = 2600; // px/s²
const DAMPING = 0.982; // velocity kept per step
const ITERATIONS = 6;
const MAX_SPEED = 1400; // px/s, caps flings so the card stays on screen
const SPIN_FRICTION = 3; // 1/s
const SETTLE_SPEED = 260; // deg/s, below this the spin settles onto a face
const SETTLE_OMEGA = 11;
const SETTLE_ZETA = 0.55;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export default function Badge({ front, back }) {
  const cardRef = useRef(null);
  const strapRef = useRef(null);
  const textRef = useRef(null);

  useEffect(() => {
    const card = cardRef.current;
    const point = (x, y) => ({ x, y, px: x, py: y });
    const s = {
      anchor: { x: 0, y: -12 },
      length: 0,
      w: 0,
      h: 0,
      a: point(0, 0), // clip at the top of the card
      b: point(0, 0), // middle of the bottom edge
      prev: null, // state before the last step, for interpolation
      ry: 0,
      ryV: 0,
      face: 0,
      settling: true,
      tilt: 0,
      drag: null,
    };

    function layout() {
      const W = window.innerWidth;
      const H = window.innerHeight;
      s.w = Math.min(300, W * 0.78);
      s.h = s.w * 1.42;
      card.style.width = `${s.w}px`;
      card.style.height = `${s.h}px`;
      s.anchor = { x: W / 2, y: -12 };
      s.length = Math.max(60, (H - s.h) / 2 - s.anchor.y - 10);
    }
    function hangAtRest() {
      s.a = point(s.anchor.x, s.anchor.y + s.length);
      s.b = point(s.anchor.x, s.anchor.y + s.length + s.h);
    }
    layout();
    hangAtRest();

    function satisfyRigid() {
      const { a, b } = s;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const k = (d - s.h) / d / 2;
      a.x += dx * k;
      a.y += dy * k;
      b.x -= dx * k;
      b.y -= dy * k;
    }
    function satisfyRope() {
      const { a, anchor } = s;
      const dx = a.x - anchor.x;
      const dy = a.y - anchor.y;
      const d = Math.hypot(dx, dy);
      if (d > s.length) {
        a.x = anchor.x + (dx / d) * s.length;
        a.y = anchor.y + (dy / d) * s.length;
      }
    }
    // Move the grabbed point on the rod to the pointer, sharing the correction between both ends
    // by leverage so the card can still rotate around where you hold it.
    function satisfyGrab() {
      const { a, b, drag } = s;
      const t = drag.t;
      const gx = lerp(a.x, b.x, t);
      const gy = lerp(a.y, b.y, t);
      const dx = drag.target.x - gx;
      const dy = drag.target.y - gy;
      const n = (1 - t) ** 2 + t ** 2;
      a.x += (dx * (1 - t)) / n;
      a.y += (dy * (1 - t)) / n;
      b.x += (dx * t) / n;
      b.y += (dy * t) / n;
    }

    function step() {
      for (const p of [s.a, s.b]) {
        let vx = (p.x - p.px) * DAMPING;
        let vy = (p.y - p.py) * DAMPING;
        const speed = Math.hypot(vx, vy) / DT;
        if (speed > MAX_SPEED) {
          vx *= MAX_SPEED / speed;
          vy *= MAX_SPEED / speed;
        }
        p.px = p.x;
        p.py = p.y;
        p.x += vx;
        p.y += vy + GRAVITY * DT * DT;
      }
      for (let i = 0; i < ITERATIONS; i++) {
        if (s.drag) satisfyGrab();
        else satisfyRope();
        satisfyRigid();
      }

      // Spin: coast with friction, then a damped spring lands it on the nearest face.
      if (!s.settling) {
        s.ryV *= Math.exp(-SPIN_FRICTION * DT);
        if (Math.abs(s.ryV) < SETTLE_SPEED) {
          s.face = s.ryV > 0 ? Math.ceil(s.ry / 180) * 180 : Math.floor(s.ry / 180) * 180;
          s.settling = true;
        }
      } else {
        s.ryV += (-(SETTLE_OMEGA ** 2) * (s.ry - s.face) - 2 * SETTLE_ZETA * SETTLE_OMEGA * s.ryV) * DT;
      }
      s.ry += s.ryV * DT;

      // Lean into sideways motion a little, smoothed so it never snaps.
      const vx = ((s.a.x - s.a.px + s.b.x - s.b.px) / 2) / DT;
      s.tilt = lerp(s.tilt, clamp(vx * 0.012, -22, 22), 1 - Math.exp(-10 * DT));
    }

    function snapshot() {
      return { ax: s.a.x, ay: s.a.y, bx: s.b.x, by: s.b.y, ry: s.ry, tilt: s.tilt };
    }

    function draw(alpha) {
      const p = s.prev ?? snapshot();
      const ax = lerp(p.ax, s.a.x, alpha);
      const ay = lerp(p.ay, s.a.y, alpha);
      const bx = lerp(p.bx, s.b.x, alpha);
      const by = lerp(p.by, s.b.y, alpha);
      const ry = lerp(p.ry, s.ry, alpha);
      const tilt = lerp(p.tilt, s.tilt, alpha);
      const rz = (-Math.atan2(bx - ax, by - ay) * 180) / Math.PI;

      // Round, and only touch the DOM when something visibly changed, so a card at rest is left
      // completely alone instead of being re-rendered every frame.
      const r = (v) => v.toFixed(2);
      const transform = `translate3d(${r(ax - s.w / 2)}px, ${r(ay)}px, 0) rotateZ(${r(rz)}deg) rotateY(${r(ry + tilt)}deg)`;
      if (transform === s.lastTransform) return;
      s.lastTransform = transform;
      card.style.transform = transform;
      card.style.setProperty("--shine", `${r((((ry % 360) + 360) % 360) / 3.6 + rz)}%`);

      const { anchor } = s;
      const d = Math.hypot(ax - anchor.x, ay - anchor.y);
      const sag = d < s.length ? Math.sqrt(s.length ** 2 - d ** 2) * 0.7 : 0;
      const cx = (anchor.x + ax) / 2;
      const cy = (anchor.y + ay) / 2 + sag;
      const path = `M ${r(anchor.x)} ${r(anchor.y)} Q ${r(cx)} ${r(cy)} ${r(ax)} ${r(ay + 6)}`;
      strapRef.current.setAttribute("d", path);
      textRef.current.setAttribute("d", path);
    }

    let last = performance.now();
    let acc = 0;
    let frame = requestAnimationFrame(function tick(now) {
      acc += Math.min((now - last) / 1000, 0.1);
      last = now;
      while (acc >= DT) {
        s.prev = snapshot();
        step();
        acc -= DT;
      }
      draw(acc / DT);
      frame = requestAnimationFrame(tick);
    });

    function grabTarget(e) {
      return { x: e.clientX - s.drag.offset.x, y: e.clientY - s.drag.offset.y };
    }
    function onDown(e) {
      card.setPointerCapture(e.pointerId);
      const { a, b } = s;
      // Where along the card (0 = clip, 1 = bottom) the pointer grabbed it.
      const t = clamp(((e.clientX - a.x) * (b.x - a.x) + (e.clientY - a.y) * (b.y - a.y)) / s.h ** 2, 0, 1);
      const gx = lerp(a.x, b.x, t);
      const gy = lerp(a.y, b.y, t);
      s.drag = {
        t,
        offset: { x: e.clientX - gx, y: e.clientY - gy },
        target: { x: gx, y: gy },
        start: { x: e.clientX, y: e.clientY, time: performance.now() },
        history: [{ x: e.clientX, y: e.clientY, time: e.timeStamp }],
      };
      card.classList.add("grabbing");
    }
    function onMove(e) {
      if (!s.drag) return;
      s.drag.target = grabTarget(e);
      s.drag.history.push({ x: e.clientX, y: e.clientY, time: e.timeStamp });
      if (s.drag.history.length > 12) s.drag.history.shift();
    }
    function onUp(e) {
      if (!s.drag) return;
      const { start, history } = s.drag;
      // Release velocity from the pointer's last ~80 ms, not the last frame, so flings are reliable.
      const recent = history.filter((h) => e.timeStamp - h.time < 80);
      const first = recent[0] ?? history.at(-1);
      const span = Math.max((e.timeStamp - first.time) / 1000, DT);
      const fling = {
        x: clamp((e.clientX - first.x) / span, -MAX_SPEED, MAX_SPEED),
        y: clamp((e.clientY - first.y) / span, -MAX_SPEED, MAX_SPEED),
      };
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      s.drag = null;
      card.classList.remove("grabbing");
      if (moved < 6 && performance.now() - start.time < 350) {
        // A tap flips the card.
        s.face = Math.round(s.ry / 180) * 180 + 180;
        s.settling = true;
        return;
      }
      // Throw the card with the pointer's velocity (Verlet velocity is position minus previous),
      // and spin it in proportion to the sideways speed.
      for (const p of [s.a, s.b]) {
        p.px = p.x - fling.x * DT;
        p.py = p.y - fling.y * DT;
      }
      s.ryV = clamp(s.ryV + fling.x * 0.35, -700, 700);
      s.settling = Math.abs(s.ryV) < SETTLE_SPEED;
      if (s.settling) s.face = Math.round(s.ry / 180) * 180;
    }
    function onResize() {
      layout();
      if (!s.drag) hangAtRest();
      s.prev = null;
      s.lastTransform = null;
    }

    card.addEventListener("pointerdown", onDown);
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerup", onUp);
    card.addEventListener("pointercancel", onUp);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      card.removeEventListener("pointerdown", onDown);
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerup", onUp);
      card.removeEventListener("pointercancel", onUp);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <>
      <svg className="lanyard" aria-hidden="true">
        <path ref={strapRef} className="strap" />
        <path ref={textRef} id="lanyard-path" fill="none" stroke="none" />
        <text className="strap-text" dy="4">
          <textPath href="#lanyard-path">{"ORBIT · DEPLOY · PREVIEW · SHIP · ".repeat(12)}</textPath>
        </text>
      </svg>
      <div ref={cardRef} className="card" role="img" aria-label="Sagar Varma's badge. Drag, fling or tap to flip.">
        <div className="clip" />
        <div className="face front">
          {front}
          <div className="foil" />
        </div>
        <div className="face back">
          {back}
          <div className="foil" />
        </div>
      </div>
    </>
  );
}
