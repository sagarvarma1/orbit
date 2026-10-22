import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { AuthProvider } from "@/components/auth";
import { Header } from "@/components/header";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orbit",
  description: "Deploy from Git. Preview every push. Roll back instantly.",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen font-sans">
        <AuthProvider>
          <Header />
          <main className="mx-auto w-full max-w-6xl px-6 pb-24">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
