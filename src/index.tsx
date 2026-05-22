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
  ): Promise<string> {
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
      return await NativeBitnet.generate(
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
    } finally {
      subscription?.remove();
    }
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
