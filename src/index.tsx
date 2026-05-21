import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import NativeBitnet from './NativeBitnet';

// Event emitter for streaming tokens. On Android, NativeEventEmitter wraps
// DeviceEventEmitter; on iOS it requires the module to expose
// supportedEvents/addListener/removeListeners (NOOP for our case).
const eventEmitter = new NativeEventEmitter(
  Platform.OS === 'ios' ? NativeModules.Bitnet : undefined
);

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
  onToken?: (token: string) => void;  // streaming callback
};

export type ModelInfo = {
  architecture: string;
  nVocab: number;
  nCtxTrain: number;
  nEmbd: number;
  modelSizeBytes: number;
};

export type EngineConfig = {
  modelPath: string;
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
    const handle = await NativeBitnet.loadModel(
      config.modelPath,
      config.contextSize ?? 2048,
      config.threads ?? 4,
      config.batchSize ?? 512
    );
    return new Engine(handle);
  }

  async generate(prompt: string, params: GenerationParams = {}): Promise<string> {
    this.throwIfDisposed();

    let subscription: { remove: () => void } | undefined;
    if (params.onToken) {
      const cb = params.onToken;
      subscription = eventEmitter.addListener('BitnetToken', (event) => {
        if (event.handle === this.handle) cb(event.token);
      });
    }

    try {
      return await NativeBitnet.generate(
        this.handle,
        prompt,
        params.maxTokens ?? 256,
        params.temperature ?? 0.8,
        params.topK ?? 40,
        params.topP ?? 0.95,
        params.seed ?? 0
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