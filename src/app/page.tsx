import { EditorScreen } from "@/features/editor/editor-screen";

// The cloud checker and the in-browser rule checker are wired in later; until
// then the editor opens empty and says so honestly.
export default function EditorPage() {
  return <EditorScreen />;
}
