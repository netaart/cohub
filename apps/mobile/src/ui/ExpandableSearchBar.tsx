import { useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, TextInput } from "react-native";
import { IconButton, TopBar } from "@/src/ui";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";

type ExpandableSearchBarProps = {
  title: string;
  query: string;
  onQueryChange: (value: string) => void;
  placeholder?: string;
  queryRef?: React.RefObject<TextInput | null>;
  account: ReactNode;
  onCreate: () => void;
  createLabel: string;
};

export function ExpandableSearchBar({ title, query, onQueryChange, placeholder, queryRef, account, onCreate, createLabel }: ExpandableSearchBarProps) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const inputRef = useRef<TextInput>(null);
  const [expanded, setExpanded] = useState(Boolean(query));

  useEffect(() => {
    if (!queryRef) return;
    queryRef.current = inputRef.current;
    return () => { queryRef.current = null; };
  }, [expanded, queryRef]);

  const closeSearch = () => {
    Keyboard.dismiss();
    onQueryChange("");
    setExpanded(false);
  };

  return (
    <TopBar
      title={title}
      leading={account}
      onBack={expanded ? closeSearch : undefined}
      backLabel={t("ui.search.close")}
      actions={expanded
        ? query ? <IconButton name="x" label={t("ui.search.clear")} onPress={() => { onQueryChange(""); inputRef.current?.focus(); }} /> : undefined
        : <>
          <IconButton name="search" label={placeholder ?? t("ui.search.placeholder")} onPress={() => setExpanded(true)} />
          <IconButton name="plus" label={createLabel} tone="accent" onPress={onCreate} />
        </>}
    >
      {expanded ? <TextInput
        ref={inputRef}
        autoFocus
        accessibilityLabel={placeholder ?? t("ui.search.placeholder")}
        value={query}
        onChangeText={onQueryChange}
        placeholder={placeholder ?? t("ui.search.placeholder")}
        placeholderTextColor={theme.colors.textFaint}
        style={[typography.body, { color: theme.colors.text, minHeight: 44, paddingVertical: 8, paddingHorizontal: 0 }]}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
      /> : undefined}
    </TopBar>
  );
}
