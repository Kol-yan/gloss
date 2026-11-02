import type { Metadata, Viewport } from "next";
import { AppHeader } from "@/components/app-header";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "gloss", template: "%s · gloss" },
  description: "Check your English writing, then practice the words you want to use.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  // Keeps the practice buttons above the on-screen keyboard where the browser supports it.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="antialiased">
      <body className="flex h-dvh flex-col">
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:shadow-card"
        >
          Skip to content
        </a>
        <AppHeader />
        <main id="content" className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </body>
    </html>
  );
}
