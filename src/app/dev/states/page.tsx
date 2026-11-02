import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StatesGallery } from "@/features/dev/states-gallery";

export const metadata: Metadata = { title: "UI states", robots: { index: false, follow: false } };

// Design-review gallery with sample data. It must never be reachable in production.
export default function StatesPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <StatesGallery />;
}
