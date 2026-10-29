import { mkdir, writeFile, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digest } from "../sync/protocol.mjs";
import { imageReferences, activeImageReferences } from "../sync/retention.mjs";
import { project } from "../sync/reducer.mjs";
import { portableHash, verifyTransfer } from "../../shared/logical-format.mjs";
import { stateFrom } from "./external-backup.mjs";
import { documentImagePath, writeDocumentImage } from "../document-images.mjs";

export const transferAssetUrls = (bundle) =>
  imageReferences(verifyTransfer(bundle).tables, bundle.payload.teamId);
const imageHash = (url) => {
  const hash = url
    .split("/")
    .at(-1)
    .replace(/\.webp$/, "");
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid transfer image");
  return hash;
};
export function fileImageStore(directory) {
  if (!directory) throw new Error("--images-dir is required");
  return {
    async read(url) {
      try {
        return new Uint8Array(
          await readFile(documentImagePath(directory, url)),
        );
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async install(url, bytes) {
      const current = await this.read(url);
      if (current) {
        if (digest(current) !== digest(bytes))
          throw new Error("Refusing to overwrite mismatched target image");
        return;
      }
      writeDocumentImage(directory, url, bytes);
    },
  };
}
export async function exportTransferAssets(
  bundle,
  directory,
  { images, readArchive } = {},
) {
  const urls = transferAssetUrls(bundle);
  if (!urls.length) return { count: 0 };
  if (!images)
    throw new Error(
      "Team contains images; specify --images-dir or --resources",
    );
  directory = resolve(directory);
  const partial = directory + ".partial";
  if (
    (await stat(directory).catch(() => null)) ||
    (await stat(partial).catch(() => null))
  )
    throw new Error("Transfer asset target already exists");
  await mkdir(partial, { recursive: true, mode: 0o700 });
  try {
    const assets = [];
    for (const url of urls) {
      let bytes = await images.read(url);
      if (!bytes && readArchive) bytes = await readArchive(url);
      if (!bytes)
        throw new Error(
          "Referenced transfer image is unavailable locally and in the fixed Git archive",
        );
      const hash = imageHash(url);
      if (bytes.length > 10 * 1024 * 1024 || digest(bytes) !== hash)
        throw new Error("Transfer image checksum mismatch");
      await writeFile(join(partial, hash + ".webp"), bytes, { mode: 0o600 });
      assets.push({ url, hash, size: bytes.length });
    }
    const body = {
      format: "graeboard-transfer-assets",
      version: 1,
      teamId: bundle.payload.teamId,
      bundleHash: bundle.hash,
      assets,
    };
    await writeFile(
      join(partial, "manifest.json"),
      JSON.stringify({ ...body, hash: portableHash(body) }) + "\n",
      { mode: 0o600 },
    );
    await rename(partial, directory);
    return { count: assets.length, directory };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}
export async function verifyTransferAssets(bundle, directory) {
  const urls = transferAssetUrls(bundle);
  if (!urls.length) return new Map();
  const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    ),
    { hash, ...body } = manifest;
  if (
    body.format !== "graeboard-transfer-assets" ||
    body.version !== 1 ||
    body.teamId !== bundle.payload.teamId ||
    body.bundleHash !== bundle.hash ||
    portableHash(body) !== hash
  )
    throw new Error("Transfer asset manifest checksum mismatch");
  const assets = new Map();
  for (const asset of body.assets) {
    if (!urls.includes(asset.url) || asset.hash !== imageHash(asset.url))
      throw new Error("Foreign or unexpected transfer asset");
    const bytes = await readFile(join(directory, asset.hash + ".webp"));
    if (
      bytes.length !== asset.size ||
      bytes.length > 10 * 1024 * 1024 ||
      digest(bytes) !== asset.hash
    )
      throw new Error("Transfer image checksum mismatch");
    assets.set(asset.url, bytes);
  }
  if (urls.some((url) => !assets.has(url)))
    throw new Error("Incomplete transfer image bundle");
  return assets;
}
export async function installTransferAssets(bundle, assets, images) {
  const { state, pending, tables, link } = stateFrom(bundle),
    retentions = tables.site_retention.filter(
      (row) => !link || row.site_id === link.installation_id,
    );
  const active = activeImageReferences(
    state,
    pending,
    retentions,
    project(state, pending).entities,
    bundle.payload.teamId,
  );
  for (const row of tables.site_entities)
    if (!row.deleted && row.entity === "document")
      for (const url of imageReferences(
        JSON.parse(row.payload),
        bundle.payload.teamId,
      ))
        active.add(url);
  if (active.size && !images)
    throw new Error(
      "Specify --images-dir or --resources for the target image store",
    );
  for (const url of active) {
    const bytes = assets.get(url);
    if (!bytes) throw new Error("Active transfer image is missing");
    await images.install(url, bytes);
  }
  return { installed: active.size, archived: assets.size - active.size };
}
