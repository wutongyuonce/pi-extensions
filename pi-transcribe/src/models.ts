import {
  downloadFile,
  fileDownloadInfo,
  getHFHubCachePath,
  getRepoFolderName,
} from "@huggingface/hub";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  statSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ReadableStream } from "node:stream/web";
import type { CatalogModel } from "./catalog.js";

function repositoryCacheDirectory(model: CatalogModel): string {
  return join(
    getHFHubCachePath(),
    getRepoFolderName({ name: model.repository, type: "model" }),
  );
}

export type CachedCatalogModel = {
  path: string;
};

/** Find the exact catalog revision in the standard Hugging Face cache. */
export function findCachedCatalogModel(model: CatalogModel): CachedCatalogModel | undefined {
  const path = join(
    repositoryCacheDirectory(model),
    "snapshots",
    model.revision,
    model.filename,
  );
  if (!existsSync(path)) return undefined;
  try {
    return statSync(path).size === model.size ? { path } : undefined;
  } catch {
    // A cache entry can disappear during concurrent HF cache maintenance.
    return undefined;
  }
}

type DownloadProgress = {
  downloaded: number;
  total: number;
};

async function createCacheLink(blobPath: string, pointerPath: string): Promise<void> {
  await rm(pointerPath, { force: true });
  try {
    await symlink(relative(dirname(pointerPath), blobPath), pointerPath);
  } catch {
    // Match Hugging Face's Windows fallback when symlinks are unavailable.
    await copyFile(blobPath, pointerPath);
  }
}

export async function downloadCatalogModel(
  model: CatalogModel,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: DownloadProgress) => void;
    /** Overridable for tests; defaults to the global fetch. */
    fetch?: typeof fetch;
  } = {},
): Promise<string> {
  const { signal, onProgress } = options;
  const fetchImpl = options.fetch ?? fetch;
  signal?.throwIfAborted();

  const storage = repositoryCacheDirectory(model);
  const pointerPath = join(storage, "snapshots", model.revision, model.filename);
  if (await stat(pointerPath).then((value) => value.size === model.size, () => false)) {
    onProgress?.({ downloaded: model.size, total: model.size });
    return pointerPath;
  }

  const token = process.env.HF_TOKEN?.trim();
  const credentials = token ? { accessToken: token } : {};
  const abortingFetch: typeof fetch = (input, init) =>
    fetchImpl(input, { ...init, signal });
  const info = await fileDownloadInfo({
    repo: model.repository,
    path: model.filename,
    revision: model.revision,
    fetch: abortingFetch,
    ...credentials,
  });
  if (!info) throw new Error(`Could not find ${model.filename} on Hugging Face`);
  if (info.size !== model.size) {
    throw new Error(
      `${model.name} size mismatch: catalog has ${model.size} bytes, Hugging Face reports ${info.size}`,
    );
  }

  // Match Hugging Face's standard cache key for these LFS-backed model files.
  const etag = info.etag.replace(/^W\//, "").replace(/^"|"$/g, "");
  const blobPath = join(storage, "blobs", etag);
  // The blob key names this exact content (the size was checked against the
  // catalog above), so a blob of any other size is a broken write by another
  // cache user and is replaced by a fresh download.
  const blobUsable = (): Promise<boolean> =>
    stat(blobPath).then((value) => value.size === model.size, () => false);
  await mkdir(dirname(blobPath), { recursive: true });
  await mkdir(dirname(pointerPath), { recursive: true });

  if (await blobUsable()) {
    await createCacheLink(blobPath, pointerPath);
    onProgress?.({ downloaded: model.size, total: model.size });
    return pointerPath;
  }

  // A stable partial name lets a later attempt resume after cancellation or a
  // dropped connection. The picker serializes downloads; simultaneous writes
  // from separate processes are deliberately outside this best-effort design.
  const partialPath = `${blobPath}.incomplete`;

  const transfer = async (resume: boolean): Promise<void> => {
    const digest = createHash("sha256");
    let downloaded = 0;
    let body: ReadableStream<Uint8Array> | undefined;

    if (resume) {
      // Hash the saved prefix, then request and append only the remainder. A
      // full-size partial skips the payload request and goes to verification.
      for await (const chunk of createReadStream(partialPath)) {
        signal?.throwIfAborted();
        digest.update(chunk as Buffer);
        downloaded += (chunk as Buffer).length;
      }
      if (downloaded < model.size) {
        const response = await abortingFetch(info.url, {
          headers: {
            Range: `bytes=${downloaded}-`,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (response.status === 200 && response.body) {
          // The server ignored the range; discard the response and restart.
          await response.body.cancel().catch(() => undefined);
          await rm(partialPath, { force: true });
          return transfer(false);
        }
        if (response.status !== 206 || !response.body) {
          // Keep the saved prefix across transient server failures.
          await response.body?.cancel().catch(() => undefined);
          throw new Error(
            `Hugging Face returned HTTP ${response.status} while resuming ${model.name}`,
          );
        }
        const contentRange = response.headers.get("content-range");
        const range = contentRange?.match(/^bytes (\d+)-\d+\/(\d+)$/);
        if (!range || Number(range[1]) !== downloaded || Number(range[2]) !== model.size) {
          // Never append a response for different bytes.
          await response.body.cancel().catch(() => undefined);
          throw new Error(
            `Hugging Face returned an unexpected resume range (${contentRange ?? "missing"}) for ${model.name}`,
          );
        }
        body = response.body as unknown as ReadableStream<Uint8Array>;
      }
    } else {
      await rm(partialPath, { force: true });
      const blob = await downloadFile({
        repo: model.repository,
        path: model.filename,
        revision: model.revision,
        downloadInfo: info,
        fetch: abortingFetch,
        ...credentials,
      });
      if (!blob) throw new Error(`Could not download ${model.filename}`);
      body = blob.stream() as unknown as ReadableStream<Uint8Array>;
    }

    onProgress?.({ downloaded, total: model.size });
    if (body) {
      let lastReport = 0;
      const file = await open(partialPath, resume ? "a" : "w");
      try {
        for await (const value of body) {
          signal?.throwIfAborted();
          const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          // Await each write so any later abort or stream error leaves a clean,
          // fully written prefix that can safely be resumed.
          await file.writeFile(chunk);
          downloaded += chunk.length;
          digest.update(chunk);
          const now = Date.now();
          if (now - lastReport >= 100 || downloaded === model.size) {
            lastReport = now;
            onProgress?.({ downloaded, total: model.size });
          }
        }
      } finally {
        await file.close();
      }
    }
    signal?.throwIfAborted();

    const written = await stat(partialPath);
    if (written.size < model.size) {
      throw new Error(`${model.name} download ended early; partial bytes were kept`);
    }
    if (written.size > model.size || digest.digest("hex") !== model.sha256) {
      await rm(partialPath, { force: true });
      throw new Error(`${model.name} verification failed; incomplete bytes were removed`);
    }
  };

  const partialBytes = await stat(partialPath).then((value) => value.size, () => 0);
  await transfer(partialBytes > 0 && partialBytes <= model.size);

  if (await blobUsable()) {
    await rm(partialPath, { force: true });
  } else {
    try {
      // rename() replaces a wrong-size blob left by an interrupted writer.
      await rename(partialPath, blobPath);
    } catch (error) {
      // Another process may have published the same verified blob first.
      if (!(await blobUsable())) throw error;
      await rm(partialPath, { force: true });
    }
  }
  await createCacheLink(blobPath, pointerPath);
  onProgress?.({ downloaded: model.size, total: model.size });
  return pointerPath;
}

/** A resumable partial download of this model on disk, if any. */
export function findIncompleteDownload(
  model: CatalogModel,
): { bytes: number } | undefined {
  // For these LFS-backed files the cache key (the server etag) is the content
  // sha256, so the catalog names the partial exactly; partials from other
  // revisions can never match. If the server ever reported a different etag,
  // this merely under-promises: the footer says "download", selecting still
  // resumes the server-etag partial.
  const partialPath = join(
    repositoryCacheDirectory(model),
    "blobs",
    `${model.sha256}.incomplete`,
  );
  try {
    const bytes = statSync(partialPath).size;
    if (bytes > 0 && bytes < model.size) return { bytes };
  } catch {
    // Missing file means no partial download.
  }
  return undefined;
}
