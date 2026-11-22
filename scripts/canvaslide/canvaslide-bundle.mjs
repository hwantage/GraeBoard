// One verified editor build as a single file: a gzip-compressed tar archive
// with sorted entries and fixed metadata, so the same build directory always
// packs to the same bytes. GraeBoard keeps these bundles; deployments unpack
// them instead of building the upstream editor.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { listFiles } from "./canvaslide-build-identity.mjs";

const BLOCK = 512;
function header(name, size) {
  const buffer = Buffer.alloc(BLOCK);
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
    throw new Error(`Path too long for the bundle: ${prefix}/${name}`);
  buffer.write(name, 0);
  buffer.write("0000644\0", 100);
  buffer.write("0000000\0", 108);
  buffer.write("0000000\0", 116);
  buffer.write(size.toString(8).padStart(11, "0") + "\0", 124);
  buffer.write("00000000000\0", 136);
  buffer.write("        ", 148);
  buffer.write("0", 156);
  buffer.write("ustar\0", 257);
  buffer.write("00", 263);
  buffer.write(prefix, 345);
  let sum = 0;
  for (const byte of buffer) sum += byte;
  buffer.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return buffer;
}
export function packBundle(directory) {
  const parts = [];
  for (const file of listFiles(directory)) {
    const bytes = readFileSync(file);
    parts.push(
      header(relative(directory, file).split("\\").join("/"), bytes.length),
      bytes,
      Buffer.alloc((BLOCK - (bytes.length % BLOCK)) % BLOCK),
    );
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts), { level: 9, mtime: 0 });
}
// Writes the archive's files under `directory`. Only plain relative file
// entries are accepted.
export function unpackBundle(bundle, directory) {
  const tar = gunzipSync(bundle);
  const text = (start, length) =>
    tar
      .subarray(start, start + length)
      .toString("utf8")
      .replace(/\0.*$/s, "");
  let files = 0;
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const name = text(offset, 100);
    if (!name) break;
    const prefix = text(offset + 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(text(offset + 124, 12), 8);
    const type = text(offset + 156, 1);
    if (
      !["0", ""].includes(type) ||
      !Number.isSafeInteger(size) ||
      path.startsWith("/") ||
      path.split("/").some((part) => part === ".." || part === "")
    )
      throw new Error(`Unsupported bundle entry: ${path}`);
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, tar.subarray(offset + BLOCK, offset + BLOCK + size));
    files++;
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
