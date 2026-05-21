# react-native-bitnet

React Native TurboModule wrapper around a native BitNet engine (bitnet.cpp/llama.cpp) for on-device GGUF inference.

## Current status

- Android: implemented and usable
- iOS: TurboModule scaffold exists, native engine wiring is not implemented yet
- Native ABI: arm64-v8a only on Android

## Installation

```sh
yarn add react-native-bitnet
```

Then install native dependencies for your app as usual:

```sh
# React Native 0.60+ usually autolinks
# iOS users should run pod install in their ios directory
```

## Quick start

```ts
import { Engine } from 'react-native-bitnet';

async function run() {
	const engine = await Engine.load({
		modelPath: '/data/data/<your.app.id>/files/model.gguf',
		contextSize: 2048,
		threads: 4,
		batchSize: 512,
	});

	try {
		const text = await engine.generate('Hello, my name is', {
			maxTokens: 64,
			temperature: 0.8,
			topK: 40,
			topP: 0.95,
			seed: 42,
			onToken: (token) => {
				// Streaming token callback
				console.log(token);
			},
		});

		console.log('Final output:', text);
	} finally {
		engine.dispose();
	}
}
```

## Integration guide

### 1. Put a GGUF model on device

The native API expects an absolute file path (not an asset URI). A common Android path is:

`/data/data/<your.app.id>/files/model.gguf`

How you copy/download the model is app-specific. Typical flow:

- Download or ship the file
- Copy it into your app's writable files directory
- Pass the absolute path to `Engine.load`

### 2. Create an engine instance

Use `Engine.load(config)` once per model instance.

```ts
const engine = await Engine.load({
	modelPath,
	contextSize: 2048, // optional
	threads: 4,        // optional
	batchSize: 512,    // optional
});
```

### 3. Generate text (with optional streaming)

`engine.generate(prompt, params)` returns the final generated string.

If you pass `onToken`, partial tokens are streamed as they arrive.

```ts
const output = await engine.generate(prompt, {
	maxTokens: 256,
	temperature: 0.8,
	topK: 40,
	topP: 0.95,
	seed: 0,
	onToken: (token) => {
		// Append token to UI incrementally
	},
});
```

### 4. Use chat templates (recommended for chat models)

`applyChatTemplate` renders model-specific prompt formatting from GGUF metadata.

```ts
const renderedPrompt = await engine.applyChatTemplate(
	[
		{ role: 'system', content: 'You are a helpful assistant.' },
		{ role: 'user', content: 'Write a haiku about compilers.' },
	],
	true
);

const answer = await engine.generate(renderedPrompt, {
	maxTokens: 128,
});
```

### 5. Read model metadata

```ts
const info = await engine.modelInfo();
console.log(info.architecture, info.nVocab, info.nCtxTrain, info.nEmbd);
```

### 6. Cancel and dispose

- `engine.cancel()` asks native generation to stop
- `engine.dispose()` must be called when done to release native resources

```ts
const pending = engine.generate(longPrompt, { onToken: console.log });

// Later, based on user action:
engine.cancel();

const result = await pending;
engine.dispose();
```

## API reference

### `Engine.load(config: EngineConfig): Promise<Engine>`

Creates a native engine and loads the model.

`EngineConfig`:

- `modelPath: string` (required)
- `contextSize?: number` (default `2048`)
- `threads?: number` (default `4`)
- `batchSize?: number` (default `512`)

### `engine.generate(prompt: string, params?: GenerationParams): Promise<string>`

Generates text from a prompt.

`GenerationParams`:

- `maxTokens?: number` (default `256`)
- `temperature?: number` (default `0.8`)
- `topK?: number` (default `40`)
- `topP?: number` (default `0.95`)
- `seed?: number` (default `0`)
- `onToken?: (token: string) => void` (optional streaming callback)

### `engine.cancel(): void`

Cancels an in-flight generation.

### `engine.applyChatTemplate(messages: ChatMessage[], addAssistantHeader?: boolean): Promise<string>`

Renders a chat prompt using model metadata template.

`ChatMessage`:

- `role: 'system' | 'user' | 'assistant'`
- `content: string`

### `engine.modelInfo(): Promise<ModelInfo>`

Returns metadata:

- `architecture: string`
- `nVocab: number`
- `nCtxTrain: number`
- `nEmbd: number`
- `modelSizeBytes: number`

### `engine.dispose(): void`

Releases native engine resources. After dispose, calls throw an error.

### Convenience export

`Bitnet.load` is an alias of `Engine.load`.

## Behavior and platform notes

- Streaming tokens are emitted through the `BitnetToken` native event internally.
- Concurrent generation on the same engine instance is not supported.
- iOS currently still contains the initial scaffold implementation and does not run inference yet.
- Android build is configured for arm64-v8a only.

## Example app

See `example/src/App.tsx` for an end-to-end sample that:

- Loads a model
- Calls `modelInfo()`
- Streams tokens with `onToken`
- Reads final output from `generate`
- Disposes engine

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT
