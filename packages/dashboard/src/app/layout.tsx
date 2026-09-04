import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Observability Agent",
  description: "Statistical detection, LLM judgement, and commit correlation — with the reasoning shown.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
