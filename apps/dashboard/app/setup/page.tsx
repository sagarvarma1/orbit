"use client";

import { AuthForm } from "@/components/auth-form";

export default function SetupPage() {
  return (
    <AuthForm
      title="Set up Orbit"
      subtitle={
        <>
          Create the admin account. The setup code is printed by the Orbit API when it starts (run{" "}
          <span className="font-mono text-fg">docker compose logs api</span> on the server).
        </>
      }
      endpoint="/api/auth/setup"
      withCode
      submitLabel="Create Account"
    />
  );
}
