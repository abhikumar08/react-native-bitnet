import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import NativeBitnet from './NativeBitnet';
import { Models, type DownloadOptions, type ModelRef } from './models';

// Event emitter for streaming tokens. On Android, NativeEventEmitter wraps
// DeviceEventEmitter; on iOS it requires the module to expose
// supportedEvents/addListener/removeListeners.
const eventEmitter = new NativeEventEmitter(
  Platform.OS === 'ios' ? NativeModules.Bitnet : undefined
);

export { Models };
export type {
  ModelRef,
  DownloadOptions,
  DownloadProgress,
  CachedModelEntry,
  ResumeAllOptions,
  ResumeAllResult,
  ResumeSkipRules,
} from './models';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

// Why generation ended. Mirrors OpenAI's `finish_reason` plus an on-device
// 'cancelled' for the case where the caller invoked engine.cancel(). Both
// EOS (the model emitting its end-of-sequence token) and a stop-sequence
// match collapse to 'stop' to match OpenAI semantics.
export type FinishReason = 'length' | 'stop' | 'cancelled';

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type GenerationResult = {
  // The full generated text, with any matched stop sequence trimmed.
  text: string;
  finishReason: FinishReason;
  usage: TokenUsage;
  // Wall-clock time the engine spent in this generate() call, in ms.
  wallTimeMs: number;
};

// One streamed chunk yielded by engine.stream(). `delta` is the incremental
// text since the previous chunk; the SDK buffers across token boundaries so
// this never contains a partial multi-byte UTF-8 sequence. The shape is an
// object (not a bare string) so future fields (logprobs, role, tool calls)
// can be added without breaking callers.
export type GenerationChunk = {
  delta: string;
};

// The return type of engine.stream(): an async iterable of deltas with a
// side-channel Promise carrying the final GenerationResult. Awaiting
// `.result` after the `for await` loop is how callers read finishReason,
// usage, wallTimeMs, etc.
export type GenerationStream = AsyncIterable<GenerationChunk> & {
  result: Promise<GenerationResult>;
};

export type GenerationParams = {
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  seed?: number;
  // OpenAI-style stop sequence(s). Match is trimmed from the returned text
  // and is not emitted to onToken. Pass a single string or an array.
  stop?: string | string[];
  // llama.cpp-style multiplicative repeat penalty. 1.0 = disabled, > 1.0
  // reduces repetition. Note: this is NOT the same math as OpenAI's
  // frequencyPenalty — both are exposed so callers can pick the one that
  // fits the model they're targeting.
  repeatPenalty?: number;
  // Window (in recent tokens) used by repeat / frequency / presence penalties.
  // 0 disables, -1 means full context.
  repeatLastN?: number;
  // OpenAI-style additive penalties. 0.0 = disabled.
  frequencyPenalty?: number;
  presencePenalty?: number;
  onToken?: (token: string) => void; // streaming callback
};

export type ModelInfo = {
  architecture: string;
  nVocab: number;
  nCtxTrain: number;
  nEmbd: number;
  modelSizeBytes: number;
};

export type EngineConfig = {
  // Exactly one of modelPath / modelRef is required.
  // modelPath: absolute path to a GGUF already on disk (sideloaded, bundled, etc.).
  // modelRef: "hf://owner/repo/file.gguf[@revision]" or "https://...". SDK downloads + caches.
  modelPath?: string;
  modelRef?: ModelRef;
  downloadOptions?: DownloadOptions;
  contextSize?: number;
  threads?: number;
  batchSize?: number;
};

export class Engine {
  private handle: number;
  private disposed = false;

  private constructor(handle: number) {
    this.handle = handle;
  }

  static async load(config: EngineConfig): Promise<Engine> {
    if (config.modelPath && config.modelRef) {
      throw new Error(
        'Engine.load: provide either modelPath or modelRef, not both.'
      );
    }
    let modelPath = config.modelPath;
    if (config.modelRef) {
      const entry = await Models.download(
        config.modelRef,
        config.downloadOptions
      );
      modelPath = entry.localPath;
    }
    if (!modelPath) {
      throw new Error('Engine.load: modelPath or modelRef must be provided.');
    }
    const handle = await NativeBitnet.loadModel(
      modelPath,
      config.contextSize ?? 2048,
      config.threads ?? 4,
      config.batchSize ?? 512
    );
    return new Engine(handle);
  }

  async generate(
    prompt: string,
    params: GenerationParams = {}
  ): Promise<GenerationResult> {
    this.throwIfDisposed();

    let subscription: { remove: () => void } | undefined;
    if (params.onToken) {
      const cb = params.onToken;
      subscription = eventEmitter.addListener('BitnetToken', (event: any) => {
        if (event.handle === this.handle) cb(event.token);
      });
    }

    const stopArray =
      typeof params.stop === 'string' ? [params.stop] : (params.stop ?? []);

    try {
      // Cast narrows the spec-layer `finishReason: string` to our
      // FinishReason union. The native side only ever resolves with one of
      // those three values.
      const raw = await NativeBitnet.generate(
        this.handle,
        prompt,
        params.maxTokens ?? 256,
        params.temperature ?? 0.8,
        params.topK ?? 40,
        params.topP ?? 0.95,
        params.seed ?? 0,
        JSON.stringify(stopArray),
        params.repeatPenalty ?? 1.1,
        params.repeatLastN ?? 64,
        params.frequencyPenalty ?? 0.0,
        params.presencePenalty ?? 0.0
      );
      return raw as GenerationResult;
    } finally {
      subscription?.remove();
    }
  }

  // Streaming generation via an async iterable. Drop-in for OpenAI's
  // `stream: true` callers. Yields one { delta } chunk per emitted token
  // (combined safely across UTF-8 boundaries) and exposes the final
  // GenerationResult on `.result`.
  //
  // Breaking out of the `for await` loop (or calling iterator.return()
  // directly) auto-cancels the underlying generation — the engine doesn't
  // keep churning to maxTokens after the consumer walks away.
  stream(prompt: string, params: GenerationParams = {}): GenerationStream {
    this.throwIfDisposed();

    const handle = this.handle;
    // Chunks that arrived before the consumer called next() — drained FIFO
    // on subsequent next() calls.
    const queue: GenerationChunk[] = [];
    // Resolvers for next() calls that arrived before any chunk. A queue,
    // not a single slot, so concurrent next() invocations (uncommon with
    // `for await`, but legal with manual iterator use) don't silently
    // overwrite each other's resolver.
    const waiters: ((r: IteratorResult<GenerationChunk>) => void)[] = [];
    let finished = false;
    let cancelled = false;

    const subscription = eventEmitter.addListener(
      'BitnetToken',
      (event: any) => {
        if (event.handle !== handle || finished) return;
        const chunk: GenerationChunk = { delta: event.token };
        const w = waiters.shift();
        if (w) {
          w({ value: chunk, done: false });
        } else {
          queue.push(chunk);
        }
      }
    );

    const stopArray =
      typeof params.stop === 'string' ? [params.stop] : (params.stop ?? []);

    // Kick off native generation. We do NOT thread params.onToken — the
    // async-iterator IS this method's streaming surface. Callers wanting
    // the callback style should use engine.generate() instead.
    const resultPromise: Promise<GenerationResult> = NativeBitnet.generate(
      handle,
      prompt,
      params.maxTokens ?? 256,
      params.temperature ?? 0.8,
      params.topK ?? 40,
      params.topP ?? 0.95,
      params.seed ?? 0,
      JSON.stringify(stopArray),
      params.repeatPenalty ?? 1.1,
      params.repeatLastN ?? 64,
      params.frequencyPenalty ?? 0.0,
      params.presencePenalty ?? 0.0
    ).then((raw) => raw as GenerationResult);

    // Settle pending waiters and remove the subscription when generation
    // finishes, whether by success or error. Wrapped in catch so any
    // cleanup failure can't become an unhandled rejection on the
    // discarded Promise returned by .finally().
    resultPromise
      .finally(() => {
        finished = true;
        try {
          subscription.remove();
        } catch {
          // listener already gone
        }
        while (waiters.length > 0) {
          const w = waiters.shift()!;
          w({ value: undefined as never, done: true });
        }
      })
      .catch(() => {
        // resultPromise's rejection reaches the caller via stream.result;
        // we just don't want it to also crash here.
      });

    const iterator: AsyncIterator<GenerationChunk> = {
      next() {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift()!, done: false });
        }
        if (finished) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          waiters.push(resolve);
        });
      },
      return() {
        if (!cancelled && !finished) {
          cancelled = true;
          try {
            NativeBitnet.cancelGeneration(handle);
          } catch {
            // engine disposed mid-stream — nothing to cancel
          }
        }
        // Drain any pending waiters with done=true so they unblock
        // immediately rather than waiting for the native cancel to round-
        // trip back through the generate Promise.
        while (waiters.length > 0) {
          const w = waiters.shift()!;
          w({ value: undefined as never, done: true });
        }
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };

    return {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      result: resultPromise,
    };
  }

  cancel(): void {
    this.throwIfDisposed();
    NativeBitnet.cancelGeneration(this.handle);
  }

  async applyChatTemplate(
    messages: ChatMessage[],
    addAssistantHeader = true
  ): Promise<string> {
    this.throwIfDisposed();
    return NativeBitnet.applyChatTemplate(
      this.handle,
      JSON.stringify(messages),
      addAssistantHeader
    );
  }

  async modelInfo(): Promise<ModelInfo> {
    this.throwIfDisposed();
    return NativeBitnet.getModelInfo(this.handle);
  }

  dispose(): void {
    if (!this.disposed) {
      NativeBitnet.disposeEngine(this.handle);
      this.disposed = true;
    }
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new Error('Engine has been disposed');
    }
  }
}

// Convenience facade
export const Bitnet = {
  load: Engine.load,
};
