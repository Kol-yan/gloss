// `npm run extension:zip` writes dist/gloss-extension-<version>.zip, the file
// uploaded to the Chrome Web Store developer dashboard.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DEFAULT_ORIGIN } from "../extension/capture.mjs";
import {
  checkVersion,
  createZip,
  isPackaged,
  referencedFiles,
  storeManifest,
  type ZipEntry,
} from "./extension-package";

const STORE_ORIGIN = "https://gloss.li";
const root = join(import.meta.dirname, "..");
const source = join(root, "extension");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

// Store users get the hosted server unless they choose another one.
if (DEFAULT_ORIGIN !== STORE_ORIGIN) {
  throw new Error(`extension/capture.mjs must default to ${STORE_ORIGIN} for the store build, found ${DEFAULT_ORIGIN}`);
}

const manifest = storeManifest(JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")));
const version = checkVersion(manifest.version);

const files = walk(source)
  .map((path) => relative(source, path).split(sep).join("/"))
  .filter((path) => path !== "manifest.json" && isPackaged(path));

const missing = referencedFiles(manifest).filter((path) => !files.includes(path));
if (missing.length) throw new Error(`manifest.json points at files that are not packaged: ${missing.join(", ")}`);

const entries: ZipEntry[] = [
  { path: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
  ...files.map((path) => ({ path, data: readFileSync(join(source, path)) })),
];

const out = join(root, "dist", `gloss-extension-${version}.zip`);
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(out, createZip(entries));
console.log(`${relative(root, out)}: ${entries.length} files, default server ${DEFAULT_ORIGIN}`);
for (const entry of entries) console.log(`  ${entry.path}`);
