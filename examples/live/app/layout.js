import "./globals.css";
import { hue } from "./theme";

export const metadata = {
  title: "Orbit Live",
  description: "A Next.js app rendered, streamed and kept warm by Orbit, a self-hosted deployment platform.",
  icons: { icon: "/favicon.svg" },
};

export const viewport = { themeColor: "#050507" };

export default function Layout({ children }) {
  return (
    <html lang="en" style={{ "--hue": hue }}>
      <body>{children}</body>
    </html>
  );
}
