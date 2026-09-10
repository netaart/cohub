import type { SpaceFsFileResponse } from "@neta-art/cohub";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { CodeBlock } from "@/src/components/CodeBlock";
import { CodeEditor } from "@/src/components/CodeEditor";
import { detectCodeLanguage } from "@/src/data/code-language";
import { classifySaveConflict, isEditableTextFile, isFileConflictError, MAX_EDITABLE_CODE_BYTES } from "@/src/data/code-file";
import { useApp } from "@/src/data/context";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, DetailTopBar, IconButton, LoadingRows, PrimaryButton, Screen } from "@/src/ui";

type Params = { spaceId?: string | string[]; path?: string | string[] };

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default function FileScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const spaceId = firstParam(params.spaceId);
  const path = Array.isArray(params.path) ? params.path.join("/") : params.path ?? "";
  const theme = useAppTheme();
  const { t } = useTranslation();
  const { client } = useApp();
  const [file, setFile] = useState<SpaceFsFileResponse | null>(null);
  const requestIdRef = useRef(0);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryToken, setRetryToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const loadFile = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!client || !spaceId || !path) {
      setFile(null);
      setUrl(null);
      setLoading(false);
      setError(!spaceId ? t("file.spaceUnavailable") : !path ? t("file.pathMissing") : t("file.connect"));
      return;
    }

    setLoading(true);
    setError(null);
    setFile(null);
    setUrl(null);
    setDraft(null);
    setSaveError(null);
    setConflict(false);
    try {
      const result = await client.space(spaceId).files.read(path);
      if (requestId !== requestIdRef.current) return;
      if ("content" in result) {
        setFile(result);
        if (result.delivery === "url" && result.url) setUrl(result.url);
      } else {
        setError(t("file.preparing"));
      }
    } catch (caught) {
      if (requestId === requestIdRef.current) setError(caught instanceof Error ? caught.message : t("file.openError"));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [client, path, spaceId, t]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void loadFile();
    });
    return () => {
      active = false;
      requestIdRef.current += 1;
    };
  }, [loadFile, retryToken]);

  const language = detectCodeLanguage(path);
  const inlineContent = file && file.kind === "text" && file.delivery !== "url" ? file.content : null;
  const editing = draft !== null;
  const dirty = editing && file !== null && draft !== file.content;
  const editable = isEditableTextFile(file);

  const exitEditing = useCallback(() => {
    setDraft(null);
    setSaveError(null);
    setConflict(false);
  }, []);

  const handleBack = useCallback(() => {
    if (saving) return;
    if (!editing) {
      router.back();
      return;
    }
    if (!dirty) {
      exitEditing();
      return;
    }
    Alert.alert(t("file.discard.title"), t("file.discard.body"), [
      { text: t("file.discard.keep"), style: "cancel" },
      { text: t("file.discard.confirm"), style: "destructive", onPress: exitEditing },
    ]);
  }, [dirty, editing, exitEditing, router, saving, t]);

  const save = useCallback(async (force = false) => {
    if (!client || !spaceId || !path || !file || draft === null) return;
    const content = draft;
    setSaving(true);
    setSaveError(null);
    try {
      const write = (expected?: { mtimeMs: number; size: number }) => client.space(spaceId).files.write({
        path,
        content,
        encoding: "utf-8",
        ...(expected ? { expected } : null),
      });
      let saved: { size: number; mtimeMs: number } | null = null;
      try {
        saved = await write(force ? undefined : { mtimeMs: file.mtimeMs, size: file.size });
      } catch (caught) {
        if (force || !isFileConflictError(caught)) throw caught;
        const fresh = await client.space(spaceId).files.read(path);
        if (!("content" in fresh)) throw caught;
        const resolution = classifySaveConflict(fresh, file.content, content);
        if (resolution === "already-saved") {
          saved = { size: fresh.size, mtimeMs: fresh.mtimeMs };
        } else if (resolution === "retry") {
          saved = await write({ mtimeMs: fresh.mtimeMs, size: fresh.size });
        } else {
          setConflict(true);
          setSaveError(t("file.conflict"));
          return;
        }
      }
      if (!saved) throw new Error(t("file.saveIncomplete"));
      const { size, mtimeMs } = saved;
      setFile((current) => current ? { ...current, content, size, mtimeMs } : current);
      // Keep editing if the draft advanced while the write was in flight.
      setDraft((current) => current === content ? null : current);
      setConflict(false);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : t("file.saveError"));
    } finally {
      setSaving(false);
    }
  }, [client, draft, file, path, spaceId, t]);

  const reloadForConflict = useCallback(async () => {
    if (!client || !spaceId || !path) return;
    setSaving(true);
    setSaveError(null);
    try {
      const fresh = await client.space(spaceId).files.read(path);
      if (!("content" in fresh)) throw new Error(t("file.preparing"));
      setFile(fresh);
      setDraft(fresh.kind === "text" && fresh.delivery !== "url" ? fresh.content : null);
      setConflict(false);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : t("file.reloadError"));
    } finally {
      setSaving(false);
    }
  }, [client, path, spaceId, t]);

  const title = path.split("/").pop() || t("file.title");
  const subtitle = editing ? (dirty ? t("file.unsaved") : t("file.editing")) : path || t("files.workspace");
  const showWebView = Boolean(file && url && inlineContent === null);

  return (
    <Screen keyboard={editing}>
      <DetailTopBar
        title={title}
        subtitle={subtitle}
        onBack={handleBack}
        actions={
          editing ? (
            <>
              <IconButton name="x" label={t("file.cancelEditing")} size={40} onPress={handleBack} disabled={saving} />
              {saving ? (
                <View style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
                  <ActivityIndicator size="small" color={theme.colors.accent} />
                </View>
              ) : (
                <IconButton name="check" label={t("file.save")} size={40} tone="accent" onPress={() => void save()} disabled={!dirty} />
              )}
            </>
          ) : editable ? (
            <IconButton name="square-pen" label={t("file.edit")} size={40} onPress={() => setDraft(file?.content ?? "")} />
          ) : url ? (
            <IconButton name="external-link" label={t("file.openExternally")} size={40} onPress={() => void Linking.openURL(url)} />
          ) : undefined
        }
      />
      {saveError ? (
        <SaveBanner
          message={saveError}
          conflict={conflict}
          saving={saving}
          onReload={() => void reloadForConflict()}
          onOverwrite={() => void save(true)}
        />
      ) : null}
      {loading ? (
        <LoadingRows count={5} />
      ) : error ? (
        <FileError
          message={error}
          onRetry={() => setRetryToken((value) => value + 1)}
          onBack={() => router.back()}
        />
      ) : showWebView && url ? (
        <WebView
          source={{ uri: url }}
          style={{ flex: 1, backgroundColor: theme.colors.background }}
          startInLoadingState
        />
      ) : file ? (
        editing && draft !== null ? (
          <ScrollView
            contentContainerStyle={{ flexGrow: 1 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            <CodeEditor
              value={draft}
              onChangeText={setDraft}
              language={language}
              highlightTheme={theme.mode === "dark" ? "github-dark" : "github-light"}
            />
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
            {file.kind === "text" && file.size > MAX_EDITABLE_CODE_BYTES ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <AppIcon name="alert" size={14} color={theme.colors.textMuted} />
                <Text style={[typography.caption, { color: theme.colors.textMuted, flex: 1 }]}>
                  {t("file.tooLarge")}
                </Text>
              </View>
            ) : null}
            <CodeBlock code={inlineContent ?? ""} language={language} showLineNumbers />
          </ScrollView>
        )
      ) : null}
    </Screen>
  );
}

function SaveBanner({
  message,
  conflict,
  saving,
  onReload,
  onOverwrite,
}: {
  message: string;
  conflict: boolean;
  saving: boolean;
  onReload: () => void;
  onOverwrite: () => void;
}) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  return (
    <View style={{ backgroundColor: theme.colors.dangerSoft, borderBottomWidth: 1, borderBottomColor: theme.colors.border, paddingHorizontal: 14, paddingVertical: 10, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AppIcon name="alert" size={15} color={theme.colors.danger} />
        <Text style={[typography.caption, { color: theme.colors.danger, flex: 1 }]}>{message}</Text>
      </View>
      {conflict ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 23 }}>
          <PrimaryButton label={t("file.reload")} icon="refresh" onPress={onReload} disabled={saving} style={{ minHeight: 36, paddingHorizontal: 12 }} />
          <Pressable accessibilityRole="button" accessibilityLabel={t("file.overwriteA11y")} disabled={saving} onPress={onOverwrite} style={({ pressed }) => ({ opacity: pressed || saving ? 0.6 : 1 })}>
            <Text style={[typography.bodyMedium, { color: theme.colors.danger }]}>{t("file.overwrite")}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function FileError({ message, onRetry, onBack }: { message: string; onRetry: () => void; onBack: () => void }) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const isDirectory = /not a file|directory|folder/i.test(message);
  return (
    <View style={styles.errorState}>
      <View style={[styles.errorIcon, { backgroundColor: theme.colors.dangerSoft }]}>
        <AppIcon name={isDirectory ? "folder" : "cloud-off"} size={24} color={theme.colors.danger} />
      </View>
      <Text style={[typography.heading, { color: theme.colors.text, textAlign: "center", marginTop: 14 }]}>
        {isDirectory ? t("file.folder.title") : t("file.error.title")}
      </Text>
      <Text selectable style={[typography.body, { color: theme.colors.textMuted, textAlign: "center", marginTop: 6, maxWidth: 320 }]}>
        {isDirectory ? t("file.folder.body") : message}
      </Text>
      <View style={styles.errorActions}>
        <PrimaryButton label={t("files.backToFiles")} icon="arrow-left" onPress={onBack} style={{ minHeight: 44, paddingHorizontal: 14 }} />
        {!isDirectory ? <Pressable accessibilityRole="button" accessibilityLabel={t("common.retry")} onPress={onRetry} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, opacity: pressed ? 0.6 : 1 })}><Text style={[typography.bodyMedium, { color: theme.colors.accent }]}>{t("common.retry")}</Text></Pressable> : null}
      </View>
    </View>
  );
}

const styles = {
  errorState: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: 24,
  },
  errorIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  errorActions: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    marginTop: 18,
  },
} satisfies Record<string, object>;
