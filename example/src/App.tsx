import { useEffect, useState } from 'react';
import { Text, View, StyleSheet, ScrollView } from 'react-native';
import { Engine } from 'react-native-bitnet';

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const addLog = (s: string) => {
    console.log('[APP]', s);                 // ← always log to console/logcat
    setLog((prev) => [...prev, `[${new Date().toISOString().slice(11, 19)}] ${s}`]);
  };

  useEffect(() => {
    addLog('useEffect fired');
    (async () => {
      addLog('async block entered');
      try {
        addLog('about to call Engine.load');
        const engine = await Engine.load({
          modelPath: '/data/data/bitnet.example/files/model.gguf',
          threads: 4,
        });
        addLog('Engine.load resolved');

        addLog('calling modelInfo()');
        const info = await engine.modelInfo();
        addLog(`Model: ${info.architecture} vocab=${info.nVocab}`);

        addLog('calling generate()');
        const result = await engine.generate('Hello, my name is', {
          maxTokens: 30,
          temperature: 0.8,
          seed: 42,
          onToken: (t) => addLog(`token: "${t}"`),
        });
        addLog(`generate() returned: "${result.slice(0, 100)}"`);

        engine.dispose();
        addLog('disposed');
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        const stack = e?.stack ?? '';
        addLog(`ERROR: ${msg}`);
        if (stack) addLog(`STACK: ${stack.slice(0, 500)}`);
      }
    })();
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>react-native-bitnet test</Text>
      <ScrollView style={styles.log}>
        {log.map((line, i) => <Text key={i} style={styles.line}>{line}</Text>)}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#0a0a0a' },
  title: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  log: { flex: 1, backgroundColor: '#1a1a1a', padding: 12 },
  line: { color: '#0f0', fontFamily: 'monospace', fontSize: 11, marginVertical: 1 },
});