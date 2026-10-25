export const metadata = { title: "Rendered on Orbit", description: "A Next.js page rendered on every request by Orbit." };

export default function Layout({ children }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#000",
          color: "#ededed",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        }}
      >
        {children}
      </body>
    </html>
  );
}
