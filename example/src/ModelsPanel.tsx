import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Models,
  type CachedModelEntry,
  type ModelRef,
} from 'react-native-bitnet';
import { fmtBytes, type CatalogEntry } from './App';

type Props = {
  visible: boolean;
  activeRef: ModelRef;
  catalog: CatalogEntry[];
  onClose: () => void;
  onSwitch: (ref: ModelRef) => void;
};

function shortRef(ref: string): string {
  if (ref.startsWith('hf://')) return ref.slice('hf://'.length);
  return ref;
}

function statusFor(entry: CachedModelEntry): {
  label: string;
  tone: 'ok' | 'warn' | 'progress';
} {
  if (entry.complete) return { label: '✓ complete', tone: 'ok' };
  if (entry.lastError) return { label: `⚠ ${entry.lastError}`, tone: 'warn' };
  return { label: '↻ downloading', tone: 'progress' };
}

export function ModelsPanel({
  visible,
  activeRef,
  catalog,
  onClose,
  onSwitch,
}: Props) {
  const insets = useSafeAreaInsets();
  const [entries, setEntries] = useState<CachedModelEntry[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [customRef, setCustomRef] = useState('');
  const [customError, setCustomError] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, size] = await Promise.all([
        Models.list(),
        Models.cacheSize(),
      ]);
      setEntries(list);
      setTotalBytes(size);
    } catch (e) {
      console.warn('[ModelsPanel] refresh failed', e);
    }
  }, []);

  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  const activeKey = useMemo(() => {
    try {
      return Models.resolve(activeRef).cacheKey;
    } catch {
      return '';
    }
  }, [activeRef]);

  const cachedKeys = useMemo(() => {
    const s = new Set<string>();
    for (const e of entries) if (e.complete) s.add(e.cacheKey);
    return s;
  }, [entries]);

  const handleSwitch = useCallback(
    (ref: ModelRef) => {
      try {
        Models.resolve(ref);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setCustomError(msg);
        return;
      }
      setCustomError('');
      setCustomRef('');
      onSwitch(ref);
      onClose();
    },
    [onSwitch, onClose]
  );

  const handleDelete = useCallback(
    (entry: CachedModelEntry) => {
      Alert.alert(
        'Delete model?',
        `${shortRef(entry.modelRef)}\n\n${fmtBytes(entry.sizeBytes)} will be freed.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              setBusyKey(entry.cacheKey);
              try {
                await Models.delete(entry.modelRef);
                await refresh();
              } catch (e) {
                console.warn('[ModelsPanel] delete failed', e);
              } finally {
                setBusyKey(null);
              }
            },
          },
        ]
      );
    },
    [refresh]
  );

  return (
    <Modal
      visible={visible}
      onRequestClose={onClose}
      animationType="slide"
      presentationStyle="pageSheet"
    >
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
          <Text style={styles.title}>Models</Text>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>Done</Text>
          </Pressable>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: 16 + insets.bottom },
          ]}
        >
          <Text style={styles.sectionTitle}>Switch model</Text>
          {catalog.map((c) => {
            const key = (() => {
              try {
                return Models.resolve(c.ref).cacheKey;
              } catch {
                return c.ref;
              }
            })();
            const isActive = key === activeKey;
            const isCached = cachedKeys.has(key);
            return (
              <Pressable
                key={c.ref}
                onPress={() => !isActive && handleSwitch(c.ref)}
                style={[styles.row, isActive && styles.rowActive]}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>
                    {isActive ? '✓ ' : ''}
                    {c.name}
                  </Text>
                  {c.note && <Text style={styles.rowNote}>{c.note}</Text>}
                  <Text style={styles.rowRef} numberOfLines={1}>
                    {shortRef(c.ref)}
                  </Text>
                </View>
                <View
                  style={[
                    styles.badge,
                    isCached ? styles.badgeOk : styles.badgeMuted,
                  ]}
                >
                  <Text style={styles.badgeText}>
                    {isCached ? 'cached' : 'download'}
                  </Text>
                </View>
              </Pressable>
            );
          })}

          <View style={styles.customBlock}>
            <Text style={styles.customLabel}>Or paste a ref</Text>
            <TextInput
              style={styles.customInput}
              value={customRef}
              onChangeText={(t) => {
                setCustomRef(t);
                if (customError) setCustomError('');
              }}
              placeholder="hf://owner/repo/file.gguf or https://…"
              placeholderTextColor="#666"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {customError ? (
              <Text style={styles.customErr}>{customError}</Text>
            ) : null}
            <Pressable
              onPress={() => handleSwitch(customRef.trim())}
              disabled={customRef.trim().length === 0}
              style={[
                styles.switchBtn,
                customRef.trim().length === 0 && styles.disabled,
              ]}
            >
              <Text style={styles.switchBtnText}>Switch to ref</Text>
            </Pressable>
          </View>

          <View style={styles.divider} />

          <Text style={styles.sectionTitle}>Manage cache</Text>
          <Text style={styles.cacheTotal}>
            Total on disk: {fmtBytes(totalBytes)}
          </Text>

          {entries.length === 0 ? (
            <Text style={styles.hint}>No cached models.</Text>
          ) : (
            entries.map((e) => {
              const s = statusFor(e);
              return (
                <View key={e.cacheKey} style={styles.row}>
                  <View style={styles.rowMain}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {shortRef(e.modelRef)}
                    </Text>
                    <Text style={styles.rowNote}>
                      {fmtBytes(e.sizeBytes)}
                      {e.expectedSizeBytes > 0 && !e.complete
                        ? ` / ${fmtBytes(e.expectedSizeBytes)}`
                        : ''}
                    </Text>
                    <Text
                      style={[
                        styles.rowStatus,
                        s.tone === 'ok' && styles.toneOk,
                        s.tone === 'warn' && styles.toneWarn,
                        s.tone === 'progress' && styles.toneProgress,
                      ]}
                    >
                      {s.label}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => handleDelete(e)}
                    disabled={busyKey === e.cacheKey}
                    style={[
                      styles.deleteBtn,
                      busyKey === e.cacheKey && styles.disabled,
                    ]}
                  >
                    {busyKey === e.cacheKey ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.deleteBtnText}>Delete</Text>
                    )}
                  </Pressable>
                </View>
              );
            })
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#222',
  },
  title: { color: '#fff', fontSize: 17, fontWeight: '600' },
  closeBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  closeBtnText: { color: '#2f9fff', fontSize: 15, fontWeight: '500' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, gap: 8 },
  sectionTitle: {
    color: '#aaa',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#161616',
  },
  rowActive: { backgroundColor: '#1d2a3a' },
  rowMain: { flex: 1, gap: 2 },
  rowTitle: { color: '#fff', fontSize: 14, fontWeight: '600' },
  rowNote: { color: '#999', fontSize: 12 },
  rowRef: { color: '#666', fontSize: 11 },
  rowStatus: { fontSize: 11, marginTop: 2 },
  toneOk: { color: '#4caf50' },
  toneWarn: { color: '#e57373' },
  toneProgress: { color: '#64b5f6' },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  badgeOk: { backgroundColor: '#1f3a2a' },
  badgeMuted: { backgroundColor: '#2a2a2a' },
  badgeText: { color: '#ddd', fontSize: 11, fontWeight: '500' },
  customBlock: {
    marginTop: 8,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#141414',
    gap: 8,
  },
  customLabel: { color: '#888', fontSize: 12 },
  customInput: {
    color: '#fff',
    backgroundColor: '#1f1f1f',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  customErr: { color: '#e57373', fontSize: 12 },
  switchBtn: {
    backgroundColor: '#2f6fbf',
    borderRadius: 6,
    paddingVertical: 10,
    alignItems: 'center',
  },
  switchBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#222',
    marginVertical: 16,
  },
  cacheTotal: { color: '#bbb', fontSize: 13, marginBottom: 4 },
  hint: { color: '#666', fontSize: 13, paddingVertical: 12 },
  deleteBtn: {
    backgroundColor: '#a13838',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    minWidth: 70,
    alignItems: 'center',
  },
  deleteBtnText: { color: '#fff', fontSize: 13, fontWeight: '500' },
  disabled: { opacity: 0.4 },
});
