// Builds the Chrome Web Store package of the browser extension. The folder in
// `extension/` stays loadable as it is ("Load unpacked"); the store package is
// a copy of it without documentation and store material, with a manifest
// variant generated here rather than edited by hand.
import { deflateRawSync, crc32 } from "node:zlib";

// Paths (relative to `extension/`) that never ship to the store.
const EXCLUDED = [
  /^README(\.[a-z]+)?$/i,
  /^CHANGELOG(\.[a-z]+)?$/i,
  /^store\//,
  /^tests?\//,
  /\.test\.[cm]?[jt]s$/,
  // Dotfiles and editor or OS leftovers.
  /(^|\/)\./,
  /(^|\/)Thumbs\.db$/i,
];

export function isPackaged(path: string): boolean {
  return !EXCLUDED.some((pattern) => pattern.test(path));
}

type Manifest = Record<string, unknown> & { version?: unknown; name?: unknown };

// The store manifest drops keys Chrome does not use. The Firefox block stays
// in the development manifest for a future Firefox build; host permissions are
// unchanged, because the checks run in text fields on every http and https page.
export function storeManifest(manifest: Manifest): Manifest {
  const copy = { ...manifest };
  delete copy.browser_specific_settings;
  return copy;
}

// Chrome accepts one to four dot-separated integers, each at most 65535.
export function checkVersion(version: unknown): string {
  if (typeof version !== "string" || !/^\d+(\.\d+){0,3}$/.test(version)
    || version.split(".").some((part) => Number(part) > 65535 || (part.length > 1 && part.startsWith("0")))) {
    throw new Error(`manifest version must be 1-4 dot-separated integers, got ${JSON.stringify(version)}`);
  }
  return version;
}

// Every file the manifest points at must be in the package; a missing one is
// a broken upload that review would reject.
export function referencedFiles(manifest: Manifest): string[] {
  const files = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string") files.add(value); };
  const background = manifest.background as { service_worker?: unknown } | undefined;
  add(background?.service_worker);
  const action = manifest.action as { default_popup?: unknown; default_icon?: Record<string, unknown> } | undefined;
  add(action?.default_popup);
  Object.values(action?.default_icon ?? {}).forEach(add);
  add((manifest.options_ui as { page?: unknown } | undefined)?.page);
  Object.values((manifest.icons as Record<string, unknown> | undefined) ?? {}).forEach(add);
  for (const script of (manifest.content_scripts as { js?: unknown[]; css?: unknown[] }[] | undefined) ?? []) {
    (script.js ?? []).forEach(add);
    (script.css ?? []).forEach(add);
  }
  return [...files].sort();
}

export type ZipEntry = { path: string; data: Buffer };

// A minimal, deterministic ZIP writer: sorted entries, a fixed timestamp and
// no extra fields, so the same sources always give the same archive.
export function createZip(entries: ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const name = Buffer.from(entry.path, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = compressed.length < entry.data.length;
    const body = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
