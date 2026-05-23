import {
  type ComponentRef,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import {
  Engine,
  Models,
  type ChatCompletionFinishReason,
  type ChatMessage,
  type DownloadProgress,
  type GenerationResult,
  type ModelRef,
} from 'react-native-bitnet';
import { ModelsPanel } from './ModelsPanel';

export type CatalogEntry = { ref: ModelRef; name: string; note?: string };

// Curated list shown in the model picker. Add more entries here as needed —
// the picker also has a freeform input for arbitrary hf:// / https:// refs.
export const CATALOG: CatalogEntry[] = [
  {
    ref: 'hf://microsoft/bitnet-b1.58-2B-4T-gguf/ggml-model-i2_s.gguf',
    name: 'BitNet b1.58 2B-4T · i2_s',
    note: '~1.18 GB · 2-bit quantized',
  },
];

const DEFAULT_REF: ModelRef = CATALOG[0]!.ref;
const DEFAULT_SYSTEM = 'You are a helpful assistant.';

type LoadState =
  | { phase: 'downloading'; progress: DownloadProgress | null }
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; message: string };

// Manual renderer for microsoft/bitnet-b1.58-2B-4T's training format.
// BitNet-b1.58-2B-4T is a Llama-3 architecture model and was trained on the
// standard Llama-3 chat template — the same markup the validated engine test
// harness uses to produce correct output:
//
//   <|begin_of_text|><|start_header_id|>{role}<|end_header_id|>\n\n
//   {content}<|eot_id|>...<|start_header_id|>assistant<|end_header_id|>\n\n
//
// We render it manually rather than calling engine.applyChatTemplate (which
// routes through llama.cpp's GGUF-metadata template path) so the format is
// pinned and can't drift if the metadata template fails to pattern-match.
// Llama-3 has a native system role, so system turns get their own header
// instead of being folded into the first user message.
function renderBitnetPrompt(messages: ChatMessage[]): string {
  let out = '<|begin_of_text|>';
  for (const m of messages) {
    out += `<|start_header_id|>${m.role}<|end_header_id|>\n\n`;
    out += `${m.content}<|eot_id|>`;
  }
  // Open the assistant turn so the model generates a response (mirrors the
  // engine harness's add_assistant_header=true). The trailing header has no
  // content and no <|eot_id|>, leaving the prompt open for continuation.
  out += '<|start_header_id|>assistant<|end_header_id|>\n\n';
  return out;
}

// Parse a text input as a finite float; fall back if blank/NaN. Used by the
// Advanced panel inputs so a partially-edited field doesn't propagate NaN
// into the engine.
function parseFloatOr(s: string, fallback: number): number {
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}

function parseIntOr(s: string, fallback: number): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const insets = useSafeAreaInsets();
  const [activeRef, setActiveRef] = useState<ModelRef>(DEFAULT_REF);
  const [showModels, setShowModels] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>({
    phase: 'downloading',
    progress: null,
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [system, setSystem] = useState(DEFAULT_SYSTEM);
  const [showSystem, setShowSystem] = useState(false);
  // Comma-separated stop sequences. Defaults stop the BitNet b1.58 chat
  // template on the next turn's role header so the assistant doesn't leak
  // into a fake user turn. Escapes (\n, \t, etc.) are honored.
  const [stopText, setStopText] = useState<string>('<|start_header_id|>');
  // Sampler/penalty knobs surfaced from the Advanced panel. Defaults match
  // the SDK's defaults at src/index.tsx (the values engine.generate /
  // engine.stream apply when the field is omitted). Stored as strings so
  // partially-edited inputs don't immediately propagate NaN.
  const [maxTokensText, setMaxTokensText] = useState<string>('256');
  const [temperatureText, setTemperatureText] = useState<string>('0.8');
  const [topKText, setTopKText] = useState<string>('40');
  const [topPText, setTopPText] = useState<string>('0.95');
  const [repeatPenaltyText, setRepeatPenaltyText] = useState<string>('1.15');
  const [repeatLastNText, setRepeatLastNText] = useState<string>('64');
  const [frequencyPenaltyText, setFrequencyPenaltyText] = useState<string>('0');
  const [presencePenaltyText, setPresencePenaltyText] = useState<string>('0');
  const [showAdvanced, setShowAdvanced] = useState(false);
  // When on, send() routes through `engine.chat.completions.create({
  // messages, stream: true })` instead of the renderBitnetPrompt + stream()
  // path. Default off because BitNet b1.58's chat template isn't recognized
  // by llama.cpp's pattern-matcher, so the facade path produces degenerate
  // output for this specific model — but it's the correct path for any
  // model whose GGUF metadata template IS recognized.
  const [useOpenAIApi, setUseOpenAIApi] = useState(false);
  const [streaming, setStreaming] = useState(false);
  // Last completed generation's metadata — rendered as a one-liner under
  // the most recent assistant bubble so the new structured-result fields
  // are visible on every chat turn.
  const [lastResult, setLastResult] = useState<GenerationResult | null>(null);

  const engineRef = useRef<Engine | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const streamingRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const mountedRef = useRef(true);
  const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  // Keep refs in sync so cleanup / async callbacks see current values.
  messagesRef.current = messages;
  streamingRef.current = streaming;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Re-runs whenever `activeRef` changes. Cleanup aborts the in-flight
  // download/load and disposes the previous engine, so switching is one-tap.
  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      setLoadState({ phase: 'downloading', progress: null });
      setMessages([]);
      try {
        const entry = await Models.download(activeRef, {
          signal: controller.signal,
          onProgress: (p) => {
            if (mountedRef.current && !controller.signal.aborted) {
              setLoadState({ phase: 'downloading', progress: p });
            }
          },
        });
        if (controller.signal.aborted) return;

        setLoadState({ phase: 'loading' });
        const engine = await Engine.load({
          modelPath: entry.localPath,
          threads: 4,
        });
        if (controller.signal.aborted) {
          engine.dispose();
          return;
        }
        engineRef.current = engine;
        setLoadState({ phase: 'ready' });
      } catch (e: unknown) {
        if (controller.signal.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (mountedRef.current) setLoadState({ phase: 'error', message: msg });
      }
    })();

    return () => {
      controller.abort();
      const engine = engineRef.current;
      engineRef.current = null;
      if (engine) {
        if (streamingRef.current) {
          try {
            engine.cancel();
          } catch {
            // engine may already be in a terminal state — swallow
          }
        }
        try {
          engine.dispose();
        } catch {
          // already disposed
        }
      }
    };
  }, [activeRef]);

  const handleSwitch = useCallback(
    (ref: ModelRef) => {
      if (ref === activeRef) return;
      cancelRequestedRef.current = true;
      setActiveRef(ref);
    },
    [activeRef]
  );

  const appendToLastAssistant = useCallback((token: string) => {
    if (!mountedRef.current) return;
    console.log('[token]', token);
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1]!;
      return [...prev.slice(0, -1), { ...last, content: last.content + token }];
    });
  }, []);

  const send = useCallback(async () => {
    const engine = engineRef.current;
    const text = input.trim();
    if (
      !engine ||
      loadState.phase !== 'ready' ||
      streaming ||
      text.length === 0
    ) {
      return;
    }

    const userMsg: ChatMessage = { role: 'user', content: text };
    const placeholder: ChatMessage = { role: 'assistant', content: '' };
    const history = messagesRef.current;
    setMessages([...history, userMsg, placeholder]);
    setInput('');
    setStreaming(true);
    setLastResult(null);
    cancelRequestedRef.current = false;

    try {
      const turns: ChatMessage[] = [
        { role: 'system', content: system },
        ...history,
        userMsg,
      ];
      const stopList = stopText
        .split(',')
        .map((s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').trim())
        .filter((s) => s.length > 0);
      const maxTokens = parseIntOr(maxTokensText, 256);
      const temperature = parseFloatOr(temperatureText, 0.8);
      const topK = parseIntOr(topKText, 40);
      const topP = parseFloatOr(topPText, 0.95);
      const repeatPenalty = parseFloatOr(repeatPenaltyText, 1.1);
      const repeatLastN = parseIntOr(repeatLastNText, 64);
      const frequencyPenalty = parseFloatOr(frequencyPenaltyText, 0);
      const presencePenalty = parseFloatOr(presencePenaltyText, 0);

      if (useOpenAIApi) {
        // OpenAI-shape facade route. Same Engine instance, but the call
        // shape is what a developer migrating from `openai.chat.completions
        // .create({...})` would write. We let applyChatTemplate (inside
        // the facade) render the prompt — for BitNet b1.58 that produces
        // a degenerate output because llama.cpp can't pattern-match
        // BitNet's custom template, but the OpenAI-shape envelope is the
        // thing being verified here.
        const stream = await engine.chat.completions.create({
          messages: turns,
          maxTokens,
          temperature,
          topK,
          topP,
          seed: 0,
          stop: stopList,
          repeatPenalty,
          repeatLastN,
          frequencyPenalty,
          presencePenalty,
          stream: true,
        });
        let lastFinishReason: ChatCompletionFinishReason = null;
        let completionTokens = 0;
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta.content;
          if (delta) {
            appendToLastAssistant(delta);
            completionTokens += 1;
          }
          if (chunk.choices[0]?.finish_reason) {
            lastFinishReason = chunk.choices[0].finish_reason;
          }
        }
        // The streaming chunks don't carry usage/timing — only the
        // non-stream create() response does. Show what we know.
        if (mountedRef.current) {
          setLastResult({
            text: '',
            finishReason: lastFinishReason ?? 'stop',
            usage: {
              promptTokens: 0,
              completionTokens,
              totalTokens: completionTokens,
            },
            wallTimeMs: 0,
          });
        }
        console.log('[generate-facade] finish_reason:', lastFinishReason);
      } else {
        // Direct engine.stream() route. Uses renderBitnetPrompt for the
        // BitNet-specific format (its GGUF chat_template isn't supported
        // by llama.cpp pattern-matching).
        const prompt = renderBitnetPrompt(turns);
        const stream = engine.stream(prompt, {
          maxTokens,
          temperature,
          topK,
          topP,
          seed: 0,
          stop: stopList,
          repeatPenalty,
          repeatLastN,
          frequencyPenalty,
          presencePenalty,
        });
        for await (const chunk of stream) {
          appendToLastAssistant(chunk.delta);
        }
        const result = await stream.result;
        if (mountedRef.current) setLastResult(result);
        console.log('[generate]', JSON.stringify(result));
      }
    } catch (e: unknown) {
      if (!cancelRequestedRef.current && mountedRef.current) {
        const msg = e instanceof Error ? e.message : String(e);
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1]!;
          if (last.role !== 'assistant') return prev;
          return [...prev.slice(0, -1), { ...last, content: `[error] ${msg}` }];
        });
      }
    } finally {
      if (mountedRef.current) setStreaming(false);
    }
  }, [
    appendToLastAssistant,
    input,
    loadState,
    streaming,
    system,
    stopText,
    maxTokensText,
    temperatureText,
    topKText,
    topPText,
    repeatPenaltyText,
    repeatLastNText,
    frequencyPenaltyText,
    presencePenaltyText,
    useOpenAIApi,
  ]);

  const stop = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !streaming) return;
    cancelRequestedRef.current = true;
    try {
      engine.cancel();
    } catch {
      // engine disposed — ignore
    }
  }, [streaming]);

  const reset = useCallback(() => {
    if (streaming) return;
    Alert.alert('Reset chat?', 'This clears the conversation transcript.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: () => {
          setMessages([]);
          setLastResult(null);
        },
      },
    ]);
  }, [streaming]);

  const canSend =
    loadState.phase === 'ready' && !streaming && input.trim().length > 0;

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.title} numberOfLines={1}>
          BitNet chat
        </Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => setShowModels(true)}
            style={styles.headerBtn}
          >
            <Text style={styles.headerBtnText}>Models</Text>
          </Pressable>
          <Pressable
            onPress={() => setShowSystem((v) => !v)}
            style={styles.headerBtn}
          >
            <Text style={styles.headerBtnText}>
              {showSystem ? 'Hide system' : 'System'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setShowAdvanced((v) => !v)}
            style={styles.headerBtn}
          >
            <Text style={styles.headerBtnText}>
              {showAdvanced ? 'Hide advanced' : 'Advanced'}
            </Text>
          </Pressable>
          <Pressable
            onPress={reset}
            disabled={streaming}
            style={[styles.headerBtn, streaming && styles.disabled]}
          >
            <Text style={styles.headerBtnText}>Reset</Text>
          </Pressable>
        </View>
      </View>

      {showSystem && (
        <View style={styles.systemBlock}>
          <Text style={styles.systemLabel}>System prompt</Text>
          <TextInput
            style={styles.systemInput}
            multiline
            defaultValue={system}
            onEndEditing={(e) => setSystem(e.nativeEvent.text)}
            placeholder="You are a helpful assistant."
            placeholderTextColor="#666"
          />
        </View>
      )}

      {showAdvanced && (
        <View style={styles.systemBlock}>
          <Text style={styles.systemLabel}>
            Stop sequences (comma-separated, \n for newline)
          </Text>
          <TextInput
            style={styles.advancedInput}
            defaultValue={stopText}
            onEndEditing={(e) => setStopText(e.nativeEvent.text)}
            placeholder="<|start_header_id|>, \nUser:"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.paramRow}>
            <View style={styles.paramCell}>
              <Text style={styles.systemLabel}>Max tokens</Text>
              <TextInput
                style={styles.advancedInput}
                defaultValue={maxTokensText}
                onEndEditing={(e) => setMaxTokensText(e.nativeEvent.text)}
                placeholder="256"
                placeholderTextColor="#666"
                keyboardType="number-pad"
              />
            </View>
            <View style={styles.paramCell}>
              <Text style={styles.systemLabel}>Temperature</Text>
              <TextInput
                style={styles.advancedInput}
                defaultValue={temperatureText}
                onEndEditing={(e) => setTemperatureText(e.nativeEvent.text)}
                placeholder="0.8"
                placeholderTextColor="#666"
                keyboardType="decimal-pad"
              />
            </View>
          </View>

          <View style={styles.paramRow}>
            <View style={styles.paramCell}>
              <Text style={styles.systemLabel}>Top-K</Text>
              <TextInput
                style={styles.advancedInput}
                defaultValue={topKText}
                onEndEditing={(e) => setTopKText(e.nativeEvent.text)}
                placeholder="40"
                placeholderTextColor="#666"
                keyboardType="number-pad"
              />
            </View>
            <View style={styles.paramCell}>
              <Text style={styles.systemLabel}>Top-P</Text>
              <TextInput
                style={styles.advancedInput}
                defaultValue={topPText}
                onEndEditing={(e) => setTopPText(e.nativeEvent.text)}
                placeholder="0.95"
                placeholderTextColor="#666"
                keyboardType="decimal-pad"
              />
            </View>
          </View>

          <View style={styles.paramRow}>
            <View style={styles.paramCell}>
              <Text style={styles.systemLabel}>Repeat penalty</Text>
              <TextInput
                style={styles.advancedInput}
                defaultValue={repeatPenaltyText}
                onEndEditing={(e) => setRepeatPenaltyText(e.nativeEvent.text)}
                placeholder="1.15"
                placeholderTextColor="#666"
                keyboardType="decimal-pad"
              />
            </View>
            <View style={styles.paramCell}>
              <Text style={styles.systemLabel}>Repeat last N</Text>
              <TextInput
                style={styles.advancedInput}
                defaultValue={repeatLastNText}
                onEndEditing={(e) => setRepeatLastNText(e.nativeEvent.text)}
                placeholder="64"
                placeholderTextColor="#666"
                keyboardType="number-pad"
              />
            </View>
          </View>

          <View style={styles.paramRow}>
            <View style={styles.paramCell}>
              <Text style={styles.systemLabel}>Frequency penalty</Text>
              <TextInput
                style={styles.advancedInput}
                defaultValue={frequencyPenaltyText}
                onEndEditing={(e) =>
                  setFrequencyPenaltyText(e.nativeEvent.text)
                }
                placeholder="0"
                placeholderTextColor="#666"
                keyboardType="decimal-pad"
              />
            </View>
            <View style={styles.paramCell}>
              <Text style={styles.systemLabel}>Presence penalty</Text>
              <TextInput
                style={styles.advancedInput}
                defaultValue={presencePenaltyText}
                onEndEditing={(e) => setPresencePenaltyText(e.nativeEvent.text)}
                placeholder="0"
                placeholderTextColor="#666"
                keyboardType="decimal-pad"
              />
            </View>
          </View>

          <Pressable
            onPress={() => setUseOpenAIApi((v) => !v)}
            style={[styles.toggleRow, styles.advancedLabelGap]}
          >
            <View
              style={[styles.toggleBox, useOpenAIApi && styles.toggleBoxOn]}
            >
              {useOpenAIApi && <Text style={styles.toggleCheck}>✓</Text>}
            </View>
            <View style={styles.toggleLabelCol}>
              <Text style={styles.toggleLabel}>OpenAI-style chat API</Text>
              <Text style={styles.toggleHelper}>
                Route send() through engine.chat.completions.create({'{'}…,
                stream: true{'}'}). Default off; the bundled BitNet model gives
                degenerate output via this path because llama.cpp can&apos;t
                match its custom chat template.
              </Text>
            </View>
          </Pressable>
        </View>
      )}

      {loadState.phase !== 'ready' && (
        <View
          style={[
            styles.banner,
            loadState.phase === 'error' && styles.bannerError,
          ]}
        >
          {loadState.phase === 'downloading' ? (
            <>
              <ActivityIndicator color="#fff" />
              <Text style={styles.bannerText}>
                {loadState.progress
                  ? `Downloading model… ${fmtBytes(loadState.progress.bytesDownloaded)}` +
                    (loadState.progress.totalBytes > 0
                      ? ` / ${fmtBytes(loadState.progress.totalBytes)} (${Math.round((loadState.progress.bytesDownloaded / loadState.progress.totalBytes) * 100)}%)`
                      : '')
                  : 'Preparing download…'}
              </Text>
            </>
          ) : loadState.phase === 'loading' ? (
            <>
              <ActivityIndicator color="#fff" />
              <Text style={styles.bannerText}>Loading model…</Text>
            </>
          ) : (
            <Text style={styles.bannerText}>
              Failed to load: {loadState.message}
            </Text>
          )}
        </View>
      )}

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.transcript}
          contentContainerStyle={styles.transcriptContent}
          onContentSizeChange={() =>
            scrollRef.current?.scrollToEnd({ animated: true })
          }
        >
          {messages.length === 0 ? (
            <Text style={styles.hint}>Send a message to start.</Text>
          ) : (
            messages.map((m, i) => {
              const isUser = m.role === 'user';
              const isLast = i === messages.length - 1;
              const showSpinner =
                !isUser && isLast && streaming && m.content.length === 0;
              const showStats =
                !isUser && isLast && !streaming && lastResult !== null;
              return (
                <View
                  key={i}
                  style={[
                    styles.bubble,
                    isUser ? styles.bubbleUser : styles.bubbleAssistant,
                  ]}
                >
                  {showSpinner ? (
                    <ActivityIndicator color="#bbb" />
                  ) : (
                    <Text style={styles.bubbleText}>{m.content}</Text>
                  )}
                  {showStats && lastResult && (
                    <Text style={styles.stats}>
                      {lastResult.finishReason} ·{' '}
                      {lastResult.usage.completionTokens}/
                      {lastResult.usage.totalTokens} tok ·{' '}
                      {lastResult.wallTimeMs} ms
                      {lastResult.wallTimeMs > 0
                        ? ` (${(
                            (lastResult.usage.completionTokens /
                              lastResult.wallTimeMs) *
                            1000
                          ).toFixed(1)} tok/s)`
                        : ''}
                    </Text>
                  )}
                </View>
              );
            })
          )}
        </ScrollView>

        <View
          style={[
            styles.footer,
            { paddingBottom: Math.max(insets.bottom, 10) },
          ]}
        >
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Message"
            placeholderTextColor="#666"
            editable={loadState.phase === 'ready' && !streaming}
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={send}
          />
          {streaming ? (
            <Pressable onPress={stop} style={[styles.sendBtn, styles.stopBtn]}>
              <Text style={styles.sendBtnText}>Stop</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={send}
              disabled={!canSend}
              style={[styles.sendBtn, !canSend && styles.disabled]}
            >
              <Text style={styles.sendBtnText}>Send</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>

      <ModelsPanel
        visible={showModels}
        activeRef={activeRef}
        catalog={CATALOG}
        onClose={() => setShowModels(false)}
        onSwitch={handleSwitch}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#222',
  },
  title: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
    marginRight: 8,
  },
  headerActions: { flexDirection: 'row', gap: 6, flexShrink: 0 },
  headerBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#1f1f1f',
  },
  headerBtnText: { color: '#ddd', fontSize: 13 },
  systemBlock: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#222',
  },
  systemLabel: { color: '#888', fontSize: 11, marginBottom: 4 },
  systemInput: {
    color: '#fff',
    backgroundColor: '#151515',
    borderRadius: 6,
    padding: 8,
    fontSize: 13,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  advancedInput: {
    color: '#fff',
    backgroundColor: '#151515',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
  },
  advancedLabelGap: { marginTop: 8 },
  paramRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  paramCell: { flex: 1 },
  toggleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  toggleBox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#444',
    backgroundColor: '#151515',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  toggleBoxOn: { backgroundColor: '#2f6fbf', borderColor: '#2f6fbf' },
  toggleCheck: { color: '#fff', fontSize: 14, lineHeight: 16 },
  toggleLabelCol: { flex: 1 },
  toggleLabel: { color: '#fff', fontSize: 13, fontWeight: '500' },
  toggleHelper: { color: '#888', fontSize: 11, marginTop: 2, lineHeight: 15 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#1a2b3a',
  },
  bannerError: { backgroundColor: '#3a1a1a' },
  bannerText: { color: '#fff', fontSize: 13 },
  transcript: { flex: 1 },
  transcriptContent: { padding: 12, gap: 8 },
  hint: { color: '#666', textAlign: 'center', marginTop: 32, fontSize: 13 },
  bubble: {
    maxWidth: '85%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
  },
  bubbleUser: {
    alignSelf: 'flex-end',
    backgroundColor: '#1f3a5c',
  },
  bubbleAssistant: {
    alignSelf: 'flex-start',
    backgroundColor: '#222',
  },
  bubbleText: { color: '#f0f0f0', fontSize: 14, lineHeight: 19 },
  stats: {
    color: '#888',
    fontSize: 10,
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#222',
    backgroundColor: '#0f0f0f',
  },
  input: {
    flex: 1,
    color: '#fff',
    backgroundColor: '#1a1a1a',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 14,
  },
  sendBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
    backgroundColor: '#2f6fbf',
  },
  stopBtn: { backgroundColor: '#a13838' },
  sendBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.4 },
});
