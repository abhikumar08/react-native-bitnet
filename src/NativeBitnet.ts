import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  // Engine lifecycle
  loadModel(
    modelPath: string,
    nCtx: number,
    nThreads: number,
    nBatch: number
  ): Promise<number>;  // returns engine handle

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
    rolesJson: string,         // JSON array of {role, content}
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
}

export default TurboModuleRegistry.getEnforcing<Spec>('Bitnet');