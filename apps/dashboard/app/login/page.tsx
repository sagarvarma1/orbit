"use client";

import { AuthForm } from "@/components/auth-form";

export default function LoginPage() {
  return (
    <AuthForm
      title="Sign in to Orbit"
      subtitle="Use the admin account created when this instance was set up."
      endpoint="/api/auth/login"
      submitLabel="Sign In"
      footer="Forgot the password? Restart the API with ORBIT_RESET_ADMIN_PASSWORD set to a new one."
    />
  );
}
