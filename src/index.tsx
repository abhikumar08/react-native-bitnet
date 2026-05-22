import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import NativeBitnet from './NativeBitnet';
import { Models, type DownloadOptions, type ModelRef } from './models';

// Event emitter for streaming tokens. On Android, NativeEventEmitter wraps
// DeviceEventEmitter; on iOS it requires the module to expose
// supportedEvents/addListener/removeListeners.
const eventEmitter = new NativeEventEmitter(
  Platform.OS === 'ios' ? NativeModules.Bitnet : undefined
);

// Monotonic per-call id passed to native and echoed back on each BitnetToken
// event. Listeners filter on this in addition to `handle` so a just-cancelled
// generation's residual tokens can't leak into the next subscription. Module
// scope is fine — JS is single-threaded so increments are atomic and the
// space (2^53 IDs) won't realistically wrap.
let nextRequestId = 1;
function makeRequestId(): number {
  return nextRequestId++;
}

function makeEngineBusyError(): Error & { code: string } {
  const err = new Error(
    'Another generate() is already in progress on this engine. ' +
      'Await the in-flight call or call engine.cancel() first.'
  ) as Error & { code: string };
  err.code = 'E_ENGINE_BUSY';
  return err;
}

// AbortError. We don't rely on the global DOMException (not consistently
// available in React Native's Hermes runtime) — a tagged Error subclass is
// sufficient. The `name === 'AbortError'` shape is what AbortController-aware
// callers check.
class AbortError extends Error {
  constructor(message: string = 'The operation was aborted.') {
    super(message);
    this.name = 'AbortError';
  }
}

// Convert an aborted AbortSignal into an Error to throw. If the signal's
// `reason` is already an Error instance, we propagate that (matches Web spec
// behavior where `controller.abort(myErr)` reaches catch handlers as `myErr`).
function makeAbortError(signal?: AbortSignal): Error {
  const reason = (signal as unknown as { reason?: unknown })?.reason;
  if (reason instanceof Error) return reason;
  return new AbortError(typeof reason === 'string' ? reason : undefined);
}

// Short opaque id for the synthetic `chatcmpl-…` field of the chat-completions
// facade. Not crypto-strong; only for log correlation.
function makeChatCompletionId(): string {
  const r = () => Math.random().toString(36).slice(2, 8);
  return `chatcmpl-${r()}${r()}`;
}

// Collapse our internal FinishReason → OpenAI's allowed set. 'cancelled' has
// no OpenAI equivalent and maps to 'stop'.
function finishReasonForOpenAI(r: FinishReason): ChatCompletionFinishReason {
  if (r === 'length') return 'length';
  return 'stop';
}

// Project a ChatCompletionCreateParams down to the GenerationParams subset
// that engine.generate / engine.stream accept. (Just drops `messages` and
// `stream`; everything else flows through 1:1.)
function pickGenerationParams(p: ChatCompletionCreateParams): GenerationParams {
  return {
    maxTokens: p.maxTokens,
    temperature: p.temperature,
    topK: p.topK,
    topP: p.topP,
    seed: p.seed,
    stop: p.stop,
    repeatPenalty: p.repeatPenalty,
    repeatLastN: p.repeatLastN,
    frequencyPenalty: p.frequencyPenalty,
    presencePenalty: p.presencePenalty,
  };
}

// Wrap an Engine GenerationStream as an OpenAI-shaped chunk stream. First
// chunk carries `delta.role: 'assistant'` (per OpenAI's protocol); middle
// chunks carry `delta.content` only; the final chunk has an empty delta with
// finish_reason set, matching what `await upstream.result` produces.
function toOpenAIStream(
  upstream: GenerationStream,
  id: string,
  created: number,
  model: string
): ChatCompletionStream {
  const baseEnvelope = {
    id,
    object: 'chat.completion.chunk' as const,
    created,
    model,
  };
  return {
    async *[Symbol.asyncIterator]() {
      let first = true;
      for await (const chunk of upstream) {
        yield {
          ...baseEnvelope,
          choices: [
            {
              index: 0,
              delta: first
                ? { role: 'assistant' as const, content: chunk.delta }
                : { content: chunk.delta },
              finish_reason: null,
            },
          ],
        };
        first = false;
      }
      const result = await upstream.result;
      yield {
        ...baseEnvelope,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReasonForOpenAI(result.finishReason),
          },
        ],
      };
    },
  };
}

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

// -----------------------------------------------------------------------------
// OpenAI-shaped chat-completions facade types. The facade itself is built on
// engine.generate / engine.stream — purely a JS-layer adapter. Params use this
// SDK's camelCase convention; results mirror OpenAI's wire format
// (snake_case sub-fields, `choices` array, `usage` totals) so destructuring
// code copied from an OpenAI call site works unchanged.
// -----------------------------------------------------------------------------

export type ChatCompletionCreateParams = {
  messages: ChatMessage[];
  // Same names as GenerationParams (camelCase). `stream` selects the
  // overload at the type level.
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  seed?: number;
  stop?: string | string[];
  repeatPenalty?: number;
  repeatLastN?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stream?: boolean;
};

// Our internal FinishReason includes 'cancelled', which has no OpenAI
// equivalent (OpenAI has no notion of user-initiated mid-stream cancel).
// The facade collapses 'cancelled' → 'stop' for drop-in parity; callers who
// need to distinguish cancel should use the lower-level engine.generate.
export type ChatCompletionFinishReason = 'stop' | 'length' | null;

export type ChatCompletionChoice = {
  index: number;
  message: { role: 'assistant'; content: string };
  finish_reason: ChatCompletionFinishReason;
};

export type ChatCompletionUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type ChatCompletion = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
};

export type ChatCompletionChunkChoice = {
  index: number;
  delta: { role?: 'assistant'; content?: string };
  finish_reason: ChatCompletionFinishReason;
};

export type ChatCompletionChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
};

export type ChatCompletionStream = AsyncIterable<ChatCompletionChunk>;

// Per-request options for the OpenAI-shape facade. Matches the second-arg
// pattern of `openai.chat.completions.create(body, { signal })` so a
// migrated call site doesn't have to relocate its AbortController wiring.
export type ChatCompletionRequestOptions = {
  signal?: AbortSignal;
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
  // AbortController integration. Aborting causes the returned Promise (or
  // the stream's iterator + .result) to reject with `AbortError`. If the
  // signal is already aborted at the call site, generate()/stream() throw
  // synchronously without entering the native side. Distinct from
  // engine.cancel() — that resolves with `finishReason: 'cancelled'` and a
  // partial GenerationResult; AbortSignal aborts reject. Use whichever
  // matches your call style.
  signal?: AbortSignal;
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
  // Single-flight gate on this engine instance. `generate()` / `stream()`
  // both set this true on entry and clear it when the underlying native
  // call settles. A second invocation while busy throws E_ENGINE_BUSY
  // synchronously — no Promise round-trip needed.
  private busy = false;

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
    // Pre-aborted signal: throw synchronously, never touch native. Matches
    // web-standard AbortController behavior.
    if (params.signal?.aborted) throw makeAbortError(params.signal);
    if (this.busy) throw makeEngineBusyError();
    this.busy = true;

    // Pre-declare so the finally block can reach them even if subscribe throws.
    let subscription: { remove: () => void } | undefined;
    let abortListener: (() => void) | undefined;
    // Tracks whether the signal aborted DURING the await of native generate.
    // Set true only by the listener; we read it after the await to decide
    // whether to throw AbortError. (Reading params.signal.aborted directly
    // would also pick up aborts that happened AFTER generation completed,
    // which per web-standard should not affect a completed operation.)
    let aborted = false;
    try {
      const requestId = makeRequestId();

      if (params.onToken) {
        const cb = params.onToken;
        subscription = eventEmitter.addListener('BitnetToken', (event: any) => {
          if (event.handle === this.handle && event.requestId === requestId) {
            cb(event.token);
          }
        });
      }

      if (params.signal) {
        const signal = params.signal;
        abortListener = () => {
          aborted = true;
          try {
            NativeBitnet.cancelGeneration(this.handle);
          } catch {
            // engine disposed mid-flight — nothing to cancel
          }
        };
        signal.addEventListener('abort', abortListener);
      }

      const stopArray =
        typeof params.stop === 'string' ? [params.stop] : (params.stop ?? []);

      // Cast narrows the spec-layer `finishReason: string` to our
      // FinishReason union. The native side only ever resolves with one of
      // those three values.
      const raw = await NativeBitnet.generate(
        this.handle,
        requestId,
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
      if (aborted) throw makeAbortError(params.signal);
      return raw as GenerationResult;
    } finally {
      // Always reached, so a synchronous throw during setup (subscribe,
      // JSON.stringify, etc.) doesn't leave the engine permanently busy.
      if (abortListener && params.signal) {
        params.signal.removeEventListener('abort', abortListener);
      }
      subscription?.remove();
      this.busy = false;
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
    // Pre-aborted signal: throw synchronously, never touch native.
    if (params.signal?.aborted) throw makeAbortError(params.signal);
    if (this.busy) throw makeEngineBusyError();
    this.busy = true;

    try {
      const handle = this.handle;
      const requestId = makeRequestId();
      // Chunks that arrived before the consumer called next() — drained FIFO
      // on subsequent next() calls.
      const queue: GenerationChunk[] = [];
      // Resolvers for next() calls that arrived before any chunk. Carries
      // both resolve and reject so a signal-abort can settle a parked
      // waiter with AbortError. (Previously a bare resolver-only queue.)
      type Waiter = {
        resolve: (r: IteratorResult<GenerationChunk>) => void;
        reject: (err: Error) => void;
      };
      const waiters: Waiter[] = [];
      let finished = false;
      let cancelled = false;
      // Signal-abort state. `aborted` flips true the moment the abort
      // listener runs; `abortReason` holds the Error we'll surface via
      // next() / .result.
      let aborted = false;
      let abortReason: Error | null = null;
      let abortListener: (() => void) | undefined;

      const subscription = eventEmitter.addListener(
        'BitnetToken',
        (event: any) => {
          if (
            event.handle !== handle ||
            event.requestId !== requestId ||
            finished
          )
            return;
          const chunk: GenerationChunk = { delta: event.token };
          const w = waiters.shift();
          if (w) {
            w.resolve({ value: chunk, done: false });
          } else {
            queue.push(chunk);
          }
        }
      );

      if (params.signal) {
        const signal = params.signal;
        abortListener = () => {
          aborted = true;
          abortReason = makeAbortError(signal);
          // Drain any parked next() calls so they reject immediately
          // rather than waiting for the native cancel to round-trip.
          while (waiters.length > 0) {
            const w = waiters.shift()!;
            w.reject(abortReason);
          }
          try {
            NativeBitnet.cancelGeneration(handle);
          } catch {
            // engine disposed mid-stream — nothing to cancel
          }
        };
        signal.addEventListener('abort', abortListener);
      }

      const stopArray =
        typeof params.stop === 'string' ? [params.stop] : (params.stop ?? []);

      // Kick off native generation. We do NOT thread params.onToken — the
      // async-iterator IS this method's streaming surface. Callers wanting
      // the callback style should use engine.generate() instead.
      const nativeResult: Promise<GenerationResult> = NativeBitnet.generate(
        handle,
        requestId,
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

      // The Promise we expose on .result. If the signal aborted during
      // generation, surface AbortError instead of the underlying Cancelled
      // result so the caller's `await stream.result` matches AbortController
      // semantics.
      const resultPromise: Promise<GenerationResult> = nativeResult.then(
        (r) => {
          if (aborted) throw abortReason!;
          return r;
        }
      );
      // Silence the rejection on the user-facing Promise *as a parallel
      // observer* — this catch creates a sibling Promise; awaiting
      // `resultPromise` still surfaces the rejection to the caller. Without
      // this, an aborted stream whose caller didn't `await stream.result`
      // would trigger an unhandled-rejection warning.
      resultPromise.catch(() => {});

      // Settle pending waiters and remove the subscription when generation
      // finishes, whether by success or error.
      nativeResult
        .finally(() => {
          finished = true;
          this.busy = false;
          try {
            subscription.remove();
          } catch {
            // listener already gone
          }
          if (abortListener && params.signal) {
            params.signal.removeEventListener('abort', abortListener);
          }
          while (waiters.length > 0) {
            const w = waiters.shift()!;
            if (aborted && abortReason) {
              w.reject(abortReason);
            } else {
              w.resolve({ value: undefined as never, done: true });
            }
          }
        })
        .catch(() => {
          // nativeResult's rejection (if any) reaches the caller via
          // resultPromise; we just don't want it to also crash here.
        });

      const iterator: AsyncIterator<GenerationChunk> = {
        next() {
          if (aborted && abortReason) return Promise.reject(abortReason);
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (finished) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          return new Promise<IteratorResult<GenerationChunk>>(
            (resolve, reject) => {
              waiters.push({ resolve, reject });
            }
          );
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
          // for-await break is consumer-initiated, NOT a signal abort.
          // Drain waiters with done=true (not reject) so the loop exits
          // cleanly rather than throwing.
          while (waiters.length > 0) {
            const w = waiters.shift()!;
            w.resolve({ value: undefined as never, done: true });
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
    } catch (e) {
      // Synchronous throw during setup before resultPromise was registered
      // — release the busy slot so the engine isn't permanently wedged.
      // On the success path, resultPromise.finally above clears it instead.
      this.busy = false;
      throw e;
    }
  }

  // OpenAI-shaped facade. Pure JS-layer adapter over applyChatTemplate +
  // generate()/stream(); no native side involvement. Migrating callers can
  // copy their existing OpenAI call site verbatim:
  //
  //   const r = await engine.chat.completions.create({ messages });
  //   console.log(r.choices[0].message.content);
  //
  //   const s = await engine.chat.completions.create({ messages, stream: true });
  //   for await (const c of s) ui.append(c.choices[0].delta.content ?? '');
  //
  // (Only param naming differs: this SDK uses camelCase — `maxTokens` instead
  // of `max_tokens`. Result fields are snake_case to match OpenAI's wire
  // format.)
  get chat() {
    type CreateFn = {
      (
        params: ChatCompletionCreateParams & { stream: true },
        options?: ChatCompletionRequestOptions
      ): Promise<ChatCompletionStream>;
      (
        params: ChatCompletionCreateParams & { stream?: false },
        options?: ChatCompletionRequestOptions
      ): Promise<ChatCompletion>;
    };
    // Arrow function so `this` (the Engine instance) is captured from the
    // enclosing getter rather than rebound when called as
    // `engine.chat.completions.create(...)`.
    const create: CreateFn = (async (
      params: ChatCompletionCreateParams,
      options?: ChatCompletionRequestOptions
    ) => {
      // Pre-aborted: bail before touching modelInfo / applyChatTemplate.
      if (options?.signal?.aborted) throw makeAbortError(options.signal);

      const id = makeChatCompletionId();
      const created = Math.floor(Date.now() / 1000);
      const info = await this.modelInfo();
      const model = info.architecture;

      // Render the chat using the model's GGUF tokenizer.chat_template.
      // Throws E_NOT_TEMPLATABLE if the model has no recognized template;
      // we let that propagate — fixing it is a model concern, not the
      // facade's.
      const prompt = await this.applyChatTemplate(params.messages, true);
      // Forward the signal to the underlying generate/stream call so abort
      // semantics work uniformly across all three call styles.
      const genParams = {
        ...pickGenerationParams(params),
        signal: options?.signal,
      };

      if (params.stream) {
        const upstream = this.stream(prompt, genParams);
        return toOpenAIStream(upstream, id, created, model);
      }
      const result = await this.generate(prompt, genParams);
      return {
        id,
        object: 'chat.completion' as const,
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant' as const,
              content: result.text,
            },
            finish_reason: finishReasonForOpenAI(result.finishReason),
          },
        ],
        usage: {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.totalTokens,
        },
      };
    }) as CreateFn;
    return { completions: { create } };
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
