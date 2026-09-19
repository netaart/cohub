import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useToast } from "@/src/components/Toast";
import { useApp } from "@/src/data/context";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";
import { PrimaryButton, Screen, TopBar } from "@/src/ui";

export default function EditSpaceScreen() {
  const { spaceId } = useLocalSearchParams<{ spaceId: string }>();
  const router = useRouter();
  const theme = useAppTheme();
  const { t } = useTranslation();
  const toast = useToast();
  const { client, state } = useApp();
  
  const space = state.spaces.find((s) => s.id === spaceId);
  
  const [name, setName] = useState(space?.name || "");
  const [description, setDescription] = useState(space?.description || "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!client || !spaceId) return;
    
    if (!name.trim()) {
      Alert.alert(t("space.edit.error"), t("space.edit.nameRequired"));
      return;
    }

    setSaving(true);
    try {
      const spaceClient = client.space(spaceId);
      
      // Update name if changed
      if (name !== space?.name) {
        await spaceClient.update({ name: name.trim() });
      }
      
      // Update description if changed
      if (description !== (space?.description || "")) {
        await spaceClient.profile({ description: description.trim() || null });
      }
      
      toast({ title: t("space.edit.saved") });
      router.back();
    } catch (error) {
      Alert.alert(
        t("space.edit.error"),
        error instanceof Error ? error.message : t("space.edit.saveFailed")
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

  return (
    <Screen>
      <TopBar title={t("space.edit.title")} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 8 }}>
          <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>
            {t("space.edit.name")}
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t("space.edit.namePlaceholder")}
            placeholderTextColor={theme.colors.textFaint}
            autoCapitalize="words"
            autoCorrect={false}
            style={inputStyle}
          />
        </View>

        <View style={{ gap: 8 }}>
          <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>
            {t("space.edit.description")}
          </Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder={t("space.edit.descriptionPlaceholder")}
            placeholderTextColor={theme.colors.textFaint}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            style={[inputStyle, { minHeight: 120 }]}
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
});
