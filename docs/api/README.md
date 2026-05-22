# API reference

Detailed reference for every public symbol exported by `react-native-bitnet`. For a getting-started narrative, installation, and integration patterns, see the main [README.md](../../README.md).

> Source of truth: the TypeScript types in [src/index.tsx](../../src/index.tsx) and [src/models.ts](../../src/models.ts). When these docs disagree with the source, the source wins — please file the doc bug.

## Quick links

- [Engine](./engine.md) — the inference class
- [Engine.chat.completions.create](./chat-completions.md) — OpenAI-shaped facade
- [Models](./models.md) — download + cache namespace
- [Types](./types.md) — every exported type
- [Errors](./errors.md) — every `E_*` code and `AbortError`
- [Events](./events.md) — raw `BitnetToken` / `BitnetDownloadProgress` payloads
- [Streaming patterns](./streaming.md) — when to use `onToken`, `stream()`, or `chat.completions.create({ stream: true })`

## Engine

The `Engine` class is the inference primitive. One engine wraps one loaded model on the native side; multiple engines can coexist as long as memory permits.

| Method | Returns | Description |
|---|---|---|
| [`Engine.load(config)`](./engine.md#engineloadconfig) | `Promise<Engine>` | Load a model from disk or download via `modelRef`. |
| [`engine.generate(prompt, params?)`](./engine.md#enginegenerateprompt-params) | `Promise<GenerationResult>` | Generate text. Optional streaming via `params.onToken`. |
| [`engine.stream(prompt, params?)`](./engine.md#enginestreamprompt-params) | `GenerationStream` | Generate text as an async iterable. |
| [`engine.chat.completions.create(params, options?)`](./chat-completions.md) | `Promise<ChatCompletion \| ChatCompletionStream>` | OpenAI-shaped facade. |
| [`engine.cancel()`](./engine.md#enginecancel) | `void` | Cancel an in-flight generation. Resolves with `finishReason: 'cancelled'`. |
| [`engine.applyChatTemplate(messages, addAssistantHeader?)`](./engine.md#engineapplychattemplatemessages-addassistantheader) | `Promise<string>` | Render messages via the model's chat template. |
| [`engine.modelInfo()`](./engine.md#enginemodelinfo) | `Promise<ModelInfo>` | Get model metadata. |
| [`engine.dispose()`](./engine.md#enginedispose) | `void` | Release native engine resources. |

## Models

The `Models` namespace owns the download + cache layer. Most consumers use `Engine.load({ modelRef })` and never touch `Models` directly.

| Method | Returns | Description |
|---|---|---|
| [`Models.download(ref, opts?)`](./models.md#modelsdownloadref-opts) | `Promise<CachedModelEntry>` | Download (or return cached) GGUF file. |
| [`Models.list()`](./models.md#modelslist) | `Promise<CachedModelEntry[]>` | All cache entries including incomplete. |
| [`Models.cacheSize()`](./models.md#modelscachesize) | `Promise<number>` | Total bytes used by the cache. |
| [`Models.delete(ref)`](./models.md#modelsdeleteref) | `Promise<boolean>` | Remove a cached model. |
| [`Models.isCached(ref)`](./models.md#modelsiscachedref) | `Promise<boolean>` | Whether `ref` resolves to a complete cached file. |
| [`Models.cacheDir()`](./models.md#modelscachedir) | `Promise<string>` | Absolute path of the cache directory. |
| [`Models.resumeAll(opts?)`](./models.md#modelsresumealloptions) | `Promise<ResumeAllResult>` | Bulk-resume interrupted downloads. |
| [`Models.resolve(ref)`](./models.md#modelsresolveref) | `{ url, cacheKey }` | Canonicalize a `modelRef` synchronously. |

## Convenience alias

```ts
import { Bitnet } from 'react-native-bitnet';

// Bitnet.load is the same function as Engine.load.
const engine = await Bitnet.load({ modelRef: 'hf://owner/repo/file.gguf' });
```

`Bitnet` is a thin namespace alias — currently just `{ load: Engine.load }`. Future versions may add more entry points here.

## Errors

Errors carry a `.code` property (a string starting with `E_`) for typed pattern-matching:

```ts
try {
  await engine.generate('Hello');
} catch (e: any) {
  if (e.code === 'E_ENGINE_BUSY') { /* … */ }
}
```

`AbortError` is the one exception — it follows the Web `AbortController` convention and uses `name === 'AbortError'`, not `.code`.

See [errors.md](./errors.md) for the full catalog.

## Events

The SDK emits two events through React Native's event system. Most consumers don't subscribe to these directly — `Engine.generate(params.onToken)`, `Engine.stream()`, and `Models.download({ onProgress })` are the higher-level surfaces.

| Event | Payload |
|---|---|
| `BitnetToken` | `{ handle, requestId, token }` |
| `BitnetDownloadProgress` | `{ cacheKey, bytesDownloaded, totalBytes, bytesPerSecond }` |

See [events.md](./events.md) for the shapes and when to subscribe directly.

## Versioning

This SDK follows [Semantic Versioning](https://semver.org/):

- **MAJOR** — public API breaking change (removed export, renamed export, signature change, error-code rename).
- **MINOR** — new public surface (new method, new optional parameter, new error code).
- **PATCH** — bugfixes that don't change the public contract.

The contract is everything in this reference. Internal helpers (e.g. anything not exported from [src/index.tsx](../../src/index.tsx)) may change at any time.

## Updating these docs

When `src/index.tsx` or `src/models.ts` changes, this reference must be updated in lockstep. See [.claude/skills/update-api-reference/SKILL.md](../../.claude/skills/update-api-reference/SKILL.md) for the procedure.
