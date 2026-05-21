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
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Engine, type ChatMessage } from 'react-native-bitnet';

const MODEL_PATH = '/data/data/bitnet.example/files/model.gguf';
const DEFAULT_SYSTEM = 'You are a helpful assistant.';

type LoadState = 'loading' | 'ready' | { error: string };

export default function App() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [system, setSystem] = useState(DEFAULT_SYSTEM);
  const [showSystem, setShowSystem] = useState(false);
  const [streaming, setStreaming] = useState(false);

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

    (async () => {
      try {
        const engine = await Engine.load({
          modelPath: MODEL_PATH,
          threads: 4,
        });
        if (!mountedRef.current) {
          engine.dispose();
          return;
        }
        engineRef.current = engine;
        setLoadState('ready');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (mountedRef.current) setLoadState({ error: msg });
      }
    })();

    return () => {
      mountedRef.current = false;
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
  }, []);

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
    if (!engine || loadState !== 'ready' || streaming || text.length === 0) {
      return;
    }

    const userMsg: ChatMessage = { role: 'user', content: text };
    const placeholder: ChatMessage = { role: 'assistant', content: '' };
    const history = messagesRef.current;
    setMessages([...history, userMsg, placeholder]);
    setInput('');
    setStreaming(true);
    cancelRequestedRef.current = false;

    try {
      const prompt = await engine.applyChatTemplate(
        [{ role: 'system', content: system }, ...history, userMsg],
        true
      );
      await engine.generate(prompt, {
        maxTokens: 256,
        temperature: 0.8,
        seed: 0,
        onToken: appendToLastAssistant,
      });
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
  }, [appendToLastAssistant, input, loadState, streaming, system]);

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
      { text: 'Reset', style: 'destructive', onPress: () => setMessages([]) },
    ]);
  }, [streaming]);

  const canSend =
    loadState === 'ready' && !streaming && input.trim().length > 0;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>BitNet chat</Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => setShowSystem((v) => !v)}
            style={styles.headerBtn}
          >
            <Text style={styles.headerBtnText}>
              {showSystem ? 'Hide system' : 'System'}
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

      {loadState !== 'ready' && (
        <View
          style={[
            styles.banner,
            typeof loadState === 'object' && styles.bannerError,
          ]}
        >
          {loadState === 'loading' ? (
            <>
              <ActivityIndicator color="#fff" />
              <Text style={styles.bannerText}>Loading model…</Text>
            </>
          ) : (
            <Text style={styles.bannerText}>
              Failed to load: {loadState.error}
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
                </View>
              );
            })
          )}
        </ScrollView>

        <View style={styles.footer}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Message"
            placeholderTextColor="#666"
            editable={loadState === 'ready' && !streaming}
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
    </SafeAreaView>
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
  title: { color: '#fff', fontSize: 16, fontWeight: '600' },
  headerActions: { flexDirection: 'row', gap: 8 },
  headerBtn: {
    paddingHorizontal: 10,
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
