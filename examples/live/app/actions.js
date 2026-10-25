"use server";

import { pulse } from "./lib/state";

export async function sendPulse(from, hue) {
  const id = String(from).slice(0, 16);
  const h = Math.round(Number(hue)) % 360;
  return pulse(id, Number.isFinite(h) ? h : 0);
}
