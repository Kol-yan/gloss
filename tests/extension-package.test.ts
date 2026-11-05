import { readFileSync } from "node:fs";
import { crc32, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  checkVersion,
  createZip,
  isPackaged,
  referencedFiles,
  storeManifest,
} from "../scripts/extension-package";

const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));

// Reads an archive through its central directory, as unzip tools do.
function readZip(zip: Buffer): Map<string, string> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const raw = zip.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    expect(crc32(data)).toBe(crc);
    files.set(name, data.toString("utf8"));
    at += 46 + nameLength;
  }
  return files;
}

describe("extension store package", () => {
  it("leaves documentation, store material and tests out", () => {
    for (const path of ["README.md", "CHANGELOG.md", "store/listing.md", "store/demo.html", "tests/a.js", "lib/a.test.mjs", ".DS_Store", "icons/.keep"]) {
      expect(isPackaged(path), path).toBe(false);
    }
    for (const path of ["background.js", "capture.mjs", "content/checks.js", "lib/api.mjs", "icons/icon-128.png", "popup.html"]) {
      expect(isPackaged(path), path).toBe(true);
    }
  });

  it("keeps permissions and drops only the Firefox block from the store manifest", () => {
    const store = storeManifest(manifest);
    expect(store).not.toHaveProperty("browser_specific_settings");
    expect(store.permissions).toEqual(manifest.permissions);
    expect(store.host_permissions).toEqual(manifest.host_permissions);
    expect(store.content_scripts).toEqual(manifest.content_scripts);
    expect(manifest).toHaveProperty("browser_specific_settings");
  });

  it("fits the store's summary limit and version format", () => {
    expect(manifest.description.length).toBeLessThanOrEqual(132);
    expect(checkVersion(manifest.version)).toBe(manifest.version);
    for (const bad of ["1.0.0.0.0", "v1", "1.070000", "01.2", 3]) expect(() => checkVersion(bad)).toThrow();
  });

  it("lists every file the manifest points at", () => {
    const files = referencedFiles(manifest);
    expect(files).toContain("background.js");
    expect(files).toContain("content/main.js");
    expect(files).toContain("options.html");
    expect(files).toContain("icons/icon-128.png");
    for (const file of files) expect(isPackaged(file), file).toBe(true);
  });

  it("writes a deterministic archive with checksummed entries", () => {
    const entries = [
      { path: "b.txt", data: Buffer.from("b".repeat(500)) },
      { path: "a/ü.txt", data: Buffer.from("tiny") },
    ];
    const zip = createZip(entries);
    expect(createZip([...entries].reverse()).equals(zip)).toBe(true);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(["a/ü.txt", "b.txt"]);
    expect(files.get("b.txt")).toBe("b".repeat(500));
    expect(files.get("a/ü.txt")).toBe("tiny");
  });
});
