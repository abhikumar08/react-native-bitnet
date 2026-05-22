import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  // Engine lifecycle
  loadModel(
    modelPath: string,
    nCtx: number,
    nThreads: number,
    nBatch: number
  ): Promise<number>; // returns engine handle

  disposeEngine(handle: number): void;

  // One-shot generation (the streaming version uses events; see below).
  // stopSequencesJson is a JSON-encoded array of strings — codegen doesn't
  // reliably marshal arrays at the param boundary in this RN version, so we
  // stringify on the JS side (same pattern as applyChatTemplate's rolesJson).
  // finishReason is typed as `string` here because codegen string-literal
  // unions are flaky on older RN; the public Engine.generate() narrows to
  // 'length' | 'stop' | 'cancelled'.
  // requestId is an opaque per-call id the SDK generates; native echoes it
  // back on every BitnetToken event so listeners can filter out stale
  // tokens from a just-cancelled run.
  generate(
    handle: number,
    requestId: number,
    prompt: string,
    maxTokens: number,
    temperature: number,
    topK: number,
    topP: number,
    seed: number,
    stopSequencesJson: string,
    repeatPenalty: number,
    repeatLastN: number,
    frequencyPenalty: number,
    presencePenalty: number
  ): Promise<{
    text: string;
    finishReason: string;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    wallTimeMs: number;
  }>;

  cancelGeneration(handle: number): void;

  // Chat templating — uses the model's GGUF metadata template
  applyChatTemplate(
    handle: number,
    rolesJson: string, // JSON array of {role, content}
    addAssistantHeader: boolean
  ): Promise<string>;

  // Model introspection
  getModelInfo(handle: number): Promise<{
    architecture: string;
    nVocab: number;
    nCtxTrain: number;
    nEmbd: number;
    modelSizeBytes: number;
  }>;

  // ---- Model lifecycle (download + cache) ----
  // Streams progress via the "BitnetDownloadProgress" event keyed by cacheKey.
  // expectedSizeBytes / expectedSha256: pass -1 / "" when unknown.
  startDownload(
    cacheKey: string,
    modelRef: string,
    url: string,
    authHeader: string,
    expectedSizeBytes: number,
    expectedSha256: string
  ): Promise<{
    localPath: string;
    sizeBytes: number;
    sha256: string;
    resumed: boolean;
  }>;

  cancelDownload(cacheKey: string): void;

  // Returns a JSON-encoded array of CachedModelEntry (matches the rolesJson
  // pattern of applyChatTemplate — codegen support for arrays-of-objects is
  // inconsistent, so we stringify on the native side).
  listModels(): Promise<string>;

  deleteModel(modelRef: string): Promise<boolean>;

  getCacheSize(): Promise<number>;

  getCacheDir(): Promise<string>;

  isModelCached(modelRef: string): Promise<boolean>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Bitnet');
