import Link from "next/link";
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
        <div className="wrap">
          <nav className="top">
            <Link href="/">Anomalies</Link>
            <Link href="/costs">Cost</Link>
            <span className="readonly">read-only</span>
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
