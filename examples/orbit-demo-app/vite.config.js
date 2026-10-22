import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Expose Orbit's system variables (ORBIT_ENV, ORBIT_GIT_COMMIT_SHA, ...) alongside VITE_*.
  envPrefix: ["VITE_", "ORBIT_"],
});
