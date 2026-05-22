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

  // One-shot generation (the streaming version uses events; see below)
  generate(
    handle: number,
    prompt: string,
    maxTokens: number,
    temperature: number,
    topK: number,
    topP: number,
    seed: number
  ): Promise<string>;

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
