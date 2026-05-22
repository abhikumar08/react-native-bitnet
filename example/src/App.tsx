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

// Manual renderer for microsoft/bitnet-b1.58-2B-4T-gguf's training format.
// The GGUF does ship a tokenizer.chat_template, but it's a custom Jinja
// string that llama.cpp's pattern-matcher doesn't recognize, so
// applyChatTemplate produces a broken approximation. The template's actual
// shape, decoded from the model's metadata, is:
//
//   {bos_token}Human: {user}\n\nBITNETAssistant: {assistant}{eos_token}...
//
// (Literally "BITNETAssistant" — not "Assistant". This is what the model
// was trained on; deviating produces gibberish.) The template has no system
// role; we prepend system content to the first user turn so it still
// reaches the context window.
function renderBitnetPrompt(messages: ChatMessage[]): string {
  const BOS = '<s>'; // bos_token for the model's Llama tokenizer
  let out = BOS;
  let pendingSystem = '';
  let lastWasUser = false;
  for (const m of messages) {
    if (m.role === 'system') {
      pendingSystem += m.content + '\n\n';
    } else if (m.role === 'user') {
      const content = pendingSystem
        ? `${pendingSystem}${m.content}`
        : m.content;
      out += `Human: ${content}\n\nBITNETAssistant: `;
      pendingSystem = '';
      lastWasUser = true;
    } else if (m.role === 'assistant') {
      // No eos here — keeps the trailing prompt open for the model to
      // continue from "BITNETAssistant: " on the next turn.
      out += m.content;
      lastWasUser = false;
    }
  }
  // If the conversation ends on an assistant turn (e.g. regenerating), the
  // upstream template appends another "Human:" prefix; we mirror that by
  // ending on an open prompt only when we just appended a user turn. When
  // we just appended an assistant turn (replay case), open a fresh turn.
  if (!lastWasUser) {
    out += '\n\nHuman: \n\nBITNETAssistant: ';
  }
  return out;
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
  const [repeatPenaltyText, setRepeatPenaltyText] = useState<string>('1.15');
  const [showAdvanced, setShowAdvanced] = useState(false);
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
      // BitNet b1.58 2B-4T ships a custom chat template in its GGUF metadata,
      // but llama.cpp's pattern-matcher can't recognize the Jinja format and
      // produces a broken approximation that the model interprets as OOD —
      // generation degenerates to '@@@@@…'. We render the model's actual
      // training format manually instead. See renderBitnetPrompt above for
      // the full explanation. engine.applyChatTemplate() remains useful for
      // models whose templates llama.cpp DOES recognize (chatml, llama3,
      // mistral, etc.) — switch to that branch when loading those models.
      const prompt = renderBitnetPrompt(turns);
      const stopList = stopText
        .split(',')
        .map((s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').trim())
        .filter((s) => s.length > 0);
      const repeatPenalty = Number.parseFloat(repeatPenaltyText);
      // Dogfood the async-iterator surface. The for-await loop is exactly
      // what an OpenAI-API caller would write; tokens render incrementally
      // via the same appendToLastAssistant. Tap Stop → engine.cancel() →
      // stream loop exits naturally → stream.result resolves with
      // finishReason: 'cancelled'.
      const stream = engine.stream(prompt, {
        maxTokens: 256,
        temperature: 0.8,
        seed: 0,
        stop: stopList,
        repeatPenalty: Number.isFinite(repeatPenalty) ? repeatPenalty : 1.1,
      });
      for await (const chunk of stream) {
        appendToLastAssistant(chunk.delta);
      }
      const result = await stream.result;
      if (mountedRef.current) setLastResult(result);
      console.log('[generate]', JSON.stringify(result));
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
    repeatPenaltyText,
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
          <Text style={[styles.systemLabel, styles.advancedLabelGap]}>
            Repeat penalty (1.0 = off, 1.1 default)
          </Text>
          <TextInput
            style={styles.advancedInput}
            defaultValue={repeatPenaltyText}
            onEndEditing={(e) => setRepeatPenaltyText(e.nativeEvent.text)}
            placeholder="1.15"
            placeholderTextColor="#666"
            keyboardType="decimal-pad"
          />
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
