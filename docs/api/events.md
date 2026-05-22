# Events

The SDK emits two events through React Native's event system. Most consumers don't subscribe directly — the higher-level surfaces ([`Engine.generate({ onToken })`](./engine.md#enginegenerateprompt-params), [`Engine.stream`](./engine.md#enginestreamprompt-params), [`Models.download({ onProgress })`](./models.md#modelsdownloadref-opts)) wrap these events with the right routing and lifecycle.

Subscribe directly only when:
- Building telemetry that needs to see every token across every engine.
- Debugging streaming behavior at the raw bridge layer.
- Implementing a custom higher-level abstraction (uncommon).

## Subscribing

```ts
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

const emitter = new NativeEventEmitter(
  Platform.OS === 'ios' ? NativeModules.Bitnet : undefined
);

const sub = emitter.addListener('BitnetToken', (event) => {
  // event: { handle: number, requestId: number, token: string }
});

// Later:
sub.remove();
```

On iOS, `NativeEventEmitter` requires the native module reference (`NativeModules.Bitnet`). On Android, passing `undefined` makes it wrap `DeviceEventEmitter`. The conditional above handles both.

**Always pair `addListener` with `remove()`** in a finally block or on component unmount. Leaked subscriptions accumulate across re-mounts.

## `BitnetToken`

Fires once per generated token (after UTF-8 boundary buffering).

### Payload

| Field | Type | Description |
|---|---|---|
| `handle` | `number` | The engine instance that produced the token. Match against `engine.handle` (internal — not exposed publicly; use the higher-level surfaces to avoid this concern). |
| `requestId` | `number` | Monotonic per-generation id. Tokens from a cancelled/completed call may briefly continue arriving after a new generation starts; `requestId` lets you discard them. |
| `token` | `string` | The token text. Complete UTF-8 — never a partial multi-byte sequence. |

### Routing rules

The higher-level surfaces filter on **both** `handle` and `requestId`:

```ts
emitter.addListener('BitnetToken', (event) => {
  if (event.handle !== this.handle) return;            // wrong engine
  if (event.requestId !== thisCallRequestId) return;   // stale call
  consume(event.token);
});
```

Filtering on `handle` alone is insufficient — a just-cancelled generation can still emit a few tokens before the native cancel signal reaches the decode loop, and those tokens would leak into the next subscription on the same engine if `requestId` weren't checked.

### Lifecycle

- First event: usually within a few hundred ms of `engine.generate` (prompt eval time depends on `contextSize` and prompt length).
- Last event: when `finishReason` is determined; the native side emits its final token before the Promise resolves.
- Cancellation: events may briefly continue after `engine.cancel()` or `signal.abort()` until the decode loop sees the cancel flag. The higher-level surfaces filter these out via `requestId`.

## `BitnetDownloadProgress`

Fires periodically while a download is in flight (typically every ~250ms during transfer).

### Payload

Matches [`DownloadProgress`](./types.md#downloadprogress):

| Field | Type | Description |
|---|---|---|
| `cacheKey` | `string` | 16-char hex SHA-256 prefix identifying the download. Match against the key returned by [`Models.resolve`](./models.md#modelsresolveref). |
| `bytesDownloaded` | `number` | Bytes written to the `.part` file so far. |
| `totalBytes` | `number` | Server's `Content-Length`, or `-1` if not sent (rare; some CDNs strip it). |
| `bytesPerSecond` | `number` | Rolling average since the previous event. |

### Routing rules

Filter by `cacheKey` to scope to a specific download:

```ts
const { cacheKey } = Models.resolve(modelRef);

emitter.addListener('BitnetDownloadProgress', (event) => {
  if (event.cacheKey !== cacheKey) return;
  console.log(event.bytesDownloaded, '/', event.totalBytes);
});
```

### Lifecycle

- Fires only while data is actively being transferred. Paused/queued downloads emit nothing.
- The terminal value (final `bytesDownloaded === totalBytes`) is not guaranteed to fire as its own event — the `Models.download` Promise resolution is the canonical "done" signal.

## Why these events exist on the bridge

React Native's TurboModule API doesn't support multi-value return streams. To deliver per-token / per-progress updates, the native side fires events on the JS-side event emitter; the SDK's higher-level surfaces subscribe + filter + clean up automatically.

The events are part of the SDK's public surface — they're stable. But unless you have a specific reason to bypass the higher-level surfaces (`onToken`, `stream`, `onProgress`), prefer those — they correctly handle the routing and lifecycle that direct subscribers have to implement themselves.

## See also

- [streaming.md](./streaming.md) — when to use which streaming surface.
- [engine.md](./engine.md) — `generate({ onToken })` and `stream()` consume `BitnetToken`.
- [models.md](./models.md) — `Models.download({ onProgress })` consumes `BitnetDownloadProgress`.
- [Architectural notes](../architecture.md) — internal design context (handle lifecycle, token routing rationale).
