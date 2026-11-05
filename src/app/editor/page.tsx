import type { Metadata } from "next";
import { EditorSession } from "@/features/editor/editor-session";

export const metadata: Metadata = { title: "Editor" };

export default function EditorPage() {
  return <EditorSession />;
}
