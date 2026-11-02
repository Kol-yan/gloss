"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Editor" },
  { href: "/practice", label: "Practice" },
  { href: "/expressions", label: "My expressions" },
] as const;

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="shrink-0 border-b border-line bg-paper/90 backdrop-blur">
      <div className="mx-auto flex h-13 w-full max-w-6xl items-center justify-between gap-2 px-4">
        <Link href="/" className="text-lg font-bold tracking-tight text-ink" aria-label="Glossy, go to the editor">
          Glossy
        </Link>
        <nav aria-label="Main">
          <ul className="flex items-center gap-0.5 text-sm font-semibold">
            {NAV.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={
                      "relative block rounded-full px-2.5 py-2 transition-colors duration-150 " +
                      (active
                        ? "text-ink after:absolute after:inset-x-2.5 after:bottom-0.5 after:h-0.5 after:rounded-full after:bg-accent"
                        : "text-ink-muted hover:bg-accent-soft hover:text-ink")
                    }
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </header>
  );
}
