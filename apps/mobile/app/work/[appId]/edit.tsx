import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useToast } from "@/src/components/Toast";
import { useApp } from "@/src/data/context";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { LoadingRows, PrimaryButton, Screen, TopBar } from "@/src/ui";
import type { AppDetailResponse } from "@neta-art/cohub";

export default function EditAppScreen() {
  const { appId } = useLocalSearchParams<{ appId: string }>();
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const toast = useToast();
  const { client } = useApp();
  
  const [detail, setDetail] = useState<AppDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [published, setPublished] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!client || !appId) return;
    let active = true;
    
    void client.apps.get(appId).then((result) => {
      if (active) {
        setDetail(result);
        setTitle(result.app.meta?.title || result.app.meta?.name || "");
        setDescription(result.app.meta?.description || "");
        setPublished(result.app.status === "published");
        setLoading(false);
      }
    }).catch((caught) => {
      if (active) {
        setError(caught instanceof Error ? caught.message : t("work.error"));
        setLoading(false);
      }
    });
    
    return () => { active = false; };
  }, [appId, client, t]);

  const handleSave = async () => {
    if (!client || !appId || !detail) return;

    setSaving(true);
    try {
      await client.apps.update(appId, {
        status: published ? "published" : "disabled",
        meta: {
          ...detail.app.meta,
          title: title.trim() || undefined,
          description: description.trim() || undefined,
        },
      });
      
      toast({ title: t("app.edit.saved") });
      router.back();
    } catch (error) {
      Alert.alert(
        t("app.edit.error"),
        error instanceof Error ? error.message : t("app.edit.saveFailed")
      );
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = [
    typography.body,
    styles.input,
    {
      borderColor: theme.colors.border,
      color: theme.colors.text,
      backgroundColor: theme.colors.surface,
    },
  ];

  if (loading) {
    return (
      <Screen>
        <TopBar title={t("app.edit.title")} onBack={() => router.back()} />
        <LoadingRows count={4} />
      </Screen>
    );
  }

  if (error || !detail) {
    return (
      <Screen>
        <TopBar title={t("app.edit.title")} onBack={() => router.back()} />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Text style={[typography.body, { color: theme.colors.danger, textAlign: "center" }]}>
            {error || t("work.error")}
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar title={t("app.edit.title")} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 8 }}>
          <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>
            {t("app.edit.title.label")}
          </Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder={t("app.edit.titlePlaceholder")}
            placeholderTextColor={theme.colors.textFaint}
            autoCapitalize="words"
            autoCorrect={false}
            style={inputStyle}
          />
        </View>

        <View style={{ gap: 8 }}>
          <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>
            {t("app.edit.description")}
          </Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder={t("app.edit.descriptionPlaceholder")}
            placeholderTextColor={theme.colors.textFaint}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            style={[inputStyle, { minHeight: 120 }]}
          />
        </View>

        <View style={[styles.row, { borderBottomColor: theme.colors.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>
              {t("app.edit.published")}
            </Text>
            <Text style={[typography.caption, { color: theme.colors.textMuted, marginTop: 4 }]}>
              {t("app.edit.publishedDescription")}
            </Text>
          </View>
          <Switch
            value={published}
            onValueChange={setPublished}
            trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
            thumbColor={theme.colors.surface}
          />
        </View>

        <PrimaryButton
          label={t("common.save")}
          onPress={handleSave}
          loading={saving}
          disabled={saving}
          style={{ marginTop: 16 }}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 16,
    gap: 24,
  },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
});
