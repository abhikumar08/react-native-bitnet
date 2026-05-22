import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import NativeBitnet from './NativeBitnet';
import { sha256Hex } from './sha256';

export type ModelRef = string;

export type DownloadProgress = {
  cacheKey: string;
  bytesDownloaded: number;
  totalBytes: number; // -1 if the server didn't send Content-Length
  bytesPerSecond: number;
};

export type CachedModelEntry = {
  modelRef: string;
  cacheKey: string;
  localPath: string;
  sizeBytes: number;
  expectedSizeBytes: number;
  complete: boolean;
  createdAt: number;
  completedAt: number;
  sha256: string;
  etag: string;
  lastError?: string;
  resolvedUrl: string;
};

export type DownloadOptions = {
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  authToken?: string;
  expectedSizeBytes?: number;
  expectedSha256?: string;
};

export type ResumeSkipRules = {
  userCancelled?: boolean;
  checksumMismatch?: boolean;
  diskFull?: boolean;
  httpClientError?: boolean;
};

export type ResumeAllOptions = {
  onProgress?: (ref: ModelRef, p: DownloadProgress) => void;
  skip?: ResumeSkipRules;
  concurrency?: number;
  signal?: AbortSignal;
};

export type ResumeAllResult = {
  resumed: CachedModelEntry[];
  skipped: { entry: CachedModelEntry; reason: string }[];
  failed: { entry: CachedModelEntry; error: Error }[];
};

const eventEmitter = new NativeEventEmitter(
  Platform.OS === 'ios' ? NativeModules.Bitnet : undefined
);

// Tracks in-process dedup: a Promise per cacheKey for the current JS lifetime.
// Native also dedupes, but doing it here avoids the round-trip when the same
// component re-mounts and re-issues the same download in a tight loop.
const inFlight = new Map<
  string,
  {
    promise: Promise<CachedModelEntry>;
    abortControllers: Set<AbortController>;
  }
>();

function canonicalize(ref: ModelRef): {
  url: string;
  cacheKey: string;
  canonicalRef: string;
} {
  if (ref.startsWith('file://')) {
    return { url: ref, cacheKey: '', canonicalRef: ref };
  }
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    const lower = ref.replace(
      /^([a-z]+):\/\/([^/]+)/i,
      (_, s, h) => `${s.toLowerCase()}://${h.toLowerCase()}`
    );
    return {
      url: ref,
      cacheKey: sha256Hex(lower).slice(0, 16),
      canonicalRef: lower,
    };
  }
  if (ref.startsWith('hf://')) {
    const rest = ref.slice(5);
    let revision = 'main';
    let pathPart = rest;
    const at = rest.lastIndexOf('@');
    if (at !== -1 && !rest.slice(at).includes('/')) {
      revision = rest.slice(at + 1) || 'main';
      pathPart = rest.slice(0, at);
    }
    const segments = pathPart.split('/');
    if (segments.length < 3) {
      throw new Error(`E_INVALID_REF: hf ref needs owner/repo/file: ${ref}`);
    }
    const [owner, repo, ...fileParts] = segments;
    const filePath = fileParts.join('/');
    if (!owner || !repo || !filePath) {
      throw new Error(`E_INVALID_REF: hf ref needs owner/repo/file: ${ref}`);
    }
    const canonicalRef = `hf://${owner}/${repo}/${filePath}@${revision}`;
    const url = `https://huggingface.co/${owner}/${repo}/resolve/${revision}/${filePath}`;
    return {
      url,
      cacheKey: sha256Hex(canonicalRef).slice(0, 16),
      canonicalRef,
    };
  }
  throw new Error(`E_INVALID_REF: unrecognized scheme in modelRef: ${ref}`);
}

function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

async function downloadOnce(
  ref: ModelRef,
  opts: DownloadOptions
): Promise<CachedModelEntry> {
  const { url, cacheKey, canonicalRef } = canonicalize(ref);

  // file:// refs are passthrough — no download, no cache entry.
  if (cacheKey === '') {
    const localPath = url.slice('file://'.length);
    return {
      modelRef: ref,
      cacheKey: '',
      localPath,
      sizeBytes: -1,
      expectedSizeBytes: -1,
      complete: true,
      createdAt: Date.now(),
      completedAt: Date.now(),
      sha256: '',
      etag: '',
      resolvedUrl: url,
    };
  }

  if (opts.signal?.aborted) {
    throw abortError();
  }

  // Subscribe to progress events keyed by cacheKey BEFORE invoking native.
  const onProgress = opts.onProgress;
  const subscription = onProgress
    ? eventEmitter.addListener('BitnetDownloadProgress', (event: any) => {
        if (event?.cacheKey === cacheKey) {
          onProgress({
            cacheKey: event.cacheKey,
            bytesDownloaded: event.bytesDownloaded,
            totalBytes: event.totalBytes,
            bytesPerSecond: event.bytesPerSecond,
          });
        }
      })
    : undefined;

  const onAbort = () => {
    try {
      NativeBitnet.cancelDownload(cacheKey);
    } catch {
      // best-effort
    }
  };
  opts.signal?.addEventListener('abort', onAbort);

  const authHeader = opts.authToken ? `Bearer ${opts.authToken}` : '';

  try {
    const result = await NativeBitnet.startDownload(
      cacheKey,
      canonicalRef,
      url,
      authHeader,
      opts.expectedSizeBytes ?? -1,
      opts.expectedSha256 ?? ''
    );
    return {
      modelRef: canonicalRef,
      cacheKey,
      localPath: result.localPath,
      sizeBytes: result.sizeBytes,
      expectedSizeBytes: opts.expectedSizeBytes ?? result.sizeBytes,
      complete: true,
      createdAt: 0,
      completedAt: Date.now(),
      sha256: result.sha256,
      etag: '',
      resolvedUrl: url,
    };
  } catch (e: any) {
    if (e?.code === 'E_DOWNLOAD_CANCELLED' || opts.signal?.aborted) {
      throw abortError();
    }
    throw e;
  } finally {
    subscription?.remove();
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

async function downloadModel(
  ref: ModelRef,
  opts: DownloadOptions = {}
): Promise<CachedModelEntry> {
  const { cacheKey } = canonicalize(ref);
  if (cacheKey === '') {
    return downloadOnce(ref, opts);
  }

  const existing = inFlight.get(cacheKey);
  if (existing) {
    // Track this caller's controller so we can do AbortSignal.any-style cancel:
    // the underlying task only aborts when ALL subscribers have aborted.
    const controller = new AbortController();
    existing.abortControllers.add(controller);

    const userSignal = opts.signal;
    if (userSignal) {
      const propagate = () => {
        existing.abortControllers.delete(controller);
        if (existing.abortControllers.size === 0) {
          try {
            NativeBitnet.cancelDownload(cacheKey);
          } catch {
            // best-effort
          }
        }
      };
      if (userSignal.aborted) {
        propagate();
      } else {
        userSignal.addEventListener('abort', propagate, { once: true });
      }
    }

    // Wire onProgress for this caller through the shared event stream.
    const onProgress = opts.onProgress;
    const sub = onProgress
      ? eventEmitter.addListener('BitnetDownloadProgress', (event: any) => {
          if (event?.cacheKey === cacheKey) {
            onProgress({
              cacheKey: event.cacheKey,
              bytesDownloaded: event.bytesDownloaded,
              totalBytes: event.totalBytes,
              bytesPerSecond: event.bytesPerSecond,
            });
          }
        })
      : undefined;

    try {
      return await existing.promise;
    } finally {
      sub?.remove();
      existing.abortControllers.delete(controller);
    }
  }

  // Fresh download. Track the controller set for AbortSignal-any semantics.
  const controllers = new Set<AbortController>();
  const myController = new AbortController();
  controllers.add(myController);

  const userSignal = opts.signal;
  if (userSignal) {
    const propagate = () => {
      controllers.delete(myController);
      if (controllers.size === 0) {
        try {
          NativeBitnet.cancelDownload(cacheKey);
        } catch {
          // best-effort
        }
      }
    };
    if (userSignal.aborted) {
      propagate();
    } else {
      userSignal.addEventListener('abort', propagate, { once: true });
    }
  }

  const promise = downloadOnce(ref, {
    ...opts,
    // We already manage cancellation via the controllers Set above; pass no
    // signal down to avoid double-cancelling.
    signal: undefined,
  }).finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, { promise, abortControllers: controllers });
  return promise;
}

async function listModels(): Promise<CachedModelEntry[]> {
  const json = await NativeBitnet.listModels();
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as CachedModelEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function isCached(ref: ModelRef): Promise<boolean> {
  const { canonicalRef } = canonicalize(ref);
  return NativeBitnet.isModelCached(canonicalRef);
}

async function deleteModel(ref: ModelRef): Promise<boolean> {
  const { canonicalRef } = canonicalize(ref);
  return NativeBitnet.deleteModel(canonicalRef);
}

function shouldSkipForResume(
  entry: CachedModelEntry,
  skip: ResumeSkipRules
): string | null {
  const userCancelled = skip.userCancelled ?? true;
  const checksumMismatch = skip.checksumMismatch ?? true;
  const diskFull = skip.diskFull ?? true;
  const httpClientError = skip.httpClientError ?? true;
  switch (entry.lastError) {
    case 'E_DOWNLOAD_CANCELLED':
      return userCancelled ? 'userCancelled' : null;
    case 'E_CHECKSUM_MISMATCH':
      return checksumMismatch ? 'checksumMismatch' : null;
    case 'E_DISK_FULL':
      return diskFull ? 'diskFull' : null;
    case 'E_HTTP_4XX':
      return httpClientError ? 'httpClientError' : null;
    default:
      return null;
  }
}

async function resumeAll(
  opts: ResumeAllOptions = {}
): Promise<ResumeAllResult> {
  const entries = await listModels();
  const incomplete = entries.filter((e) => !e.complete);
  const result: ResumeAllResult = { resumed: [], skipped: [], failed: [] };

  const skipRules = opts.skip ?? {};
  const concurrency = Math.max(1, opts.concurrency ?? 1);

  const queue = incomplete.slice();

  async function worker() {
    while (queue.length > 0) {
      if (opts.signal?.aborted) return;
      const entry = queue.shift();
      if (!entry) return;
      const skipReason = shouldSkipForResume(entry, skipRules);
      if (skipReason) {
        result.skipped.push({ entry, reason: skipReason });
        continue;
      }
      try {
        const done = await downloadModel(entry.modelRef, {
          signal: opts.signal,
          onProgress: opts.onProgress
            ? (p) => opts.onProgress!(entry.modelRef, p)
            : undefined,
        });
        result.resumed.push(done);
      } catch (err) {
        result.failed.push({ entry, error: err as Error });
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return result;
}

export const Models = {
  download: downloadModel,
  resumeAll,
  isCached,
  list: listModels,
  delete: deleteModel,
  cacheSize: () => NativeBitnet.getCacheSize(),
  cacheDir: () => NativeBitnet.getCacheDir(),
  resolve: (ref: ModelRef) => {
    const { url, cacheKey } = canonicalize(ref);
    return { url, cacheKey };
  },
};

// Exported for tests only.
export const __internals = { canonicalize };
