export type CodeLanguageId =
  | "bash"
  | "c"
  | "cpp"
  | "css"
  | "diff"
  | "dockerfile"
  | "go"
  | "graphql"
  | "html"
  | "ini"
  | "java"
  | "javascript"
  | "json"
  | "jsx"
  | "markdown"
  | "mermaid"
  | "protobuf"
  | "python"
  | "rust"
  | "shellscript"
  | "sql"
  | "toml"
  | "tsx"
  | "typescript"
  | "xml"
  | "yaml";

type CodeLanguageDefinition = {
  id: CodeLanguageId;
  label: string;
  fenceAliases: readonly string[];
  extensions: readonly string[];
  filenames?: readonly string[];
};

const CODE_LANGUAGES: readonly CodeLanguageDefinition[] = [
  { id: "bash", label: "Bash", fenceAliases: ["bash"], extensions: [] },
  { id: "c", label: "C", fenceAliases: ["c"], extensions: ["c", "h"] },
  { id: "cpp", label: "C++", fenceAliases: ["c++", "cpp", "cxx"], extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"] },
  { id: "css", label: "CSS", fenceAliases: ["css"], extensions: ["css"] },
  { id: "diff", label: "Diff", fenceAliases: ["diff"], extensions: ["diff", "patch"] },
  { id: "dockerfile", label: "Dockerfile", fenceAliases: ["docker", "dockerfile"], extensions: ["dockerfile"], filenames: ["dockerfile", "containerfile"] },
  { id: "go", label: "Go", fenceAliases: ["go", "golang"], extensions: ["go"] },
  { id: "graphql", label: "GraphQL", fenceAliases: ["graphql", "gql"], extensions: ["graphql", "gql"] },
  { id: "html", label: "HTML", fenceAliases: ["html"], extensions: ["html", "htm"] },
  { id: "ini", label: "INI", fenceAliases: ["ini"], extensions: ["ini", "cfg", "conf"] },
  { id: "java", label: "Java", fenceAliases: ["java"], extensions: ["java"] },
  { id: "javascript", label: "JavaScript", fenceAliases: ["javascript", "js"], extensions: ["js", "mjs", "cjs"] },
  { id: "json", label: "JSON", fenceAliases: ["json", "jsonc"], extensions: ["json", "jsonc", "json5"] },
  { id: "jsx", label: "JSX", fenceAliases: ["jsx"], extensions: ["jsx"] },
  { id: "markdown", label: "Markdown", fenceAliases: ["markdown", "md", "mdx"], extensions: ["md", "mdx", "markdown"] },
  { id: "mermaid", label: "Mermaid", fenceAliases: ["mermaid"], extensions: ["mmd", "mermaid"] },
  { id: "protobuf", label: "Protobuf", fenceAliases: ["proto", "protobuf"], extensions: ["proto"] },
  { id: "python", label: "Python", fenceAliases: ["python", "py"], extensions: ["py", "pyi"] },
  { id: "rust", label: "Rust", fenceAliases: ["rust", "rs"], extensions: ["rs"] },
  { id: "shellscript", label: "Shell", fenceAliases: ["shell", "shellscript", "sh"], extensions: ["sh", "bash", "zsh", "fish"], filenames: [".bashrc", ".zshrc", ".bash_profile", ".profile"] },
  { id: "sql", label: "SQL", fenceAliases: ["sql"], extensions: ["sql"] },
  { id: "toml", label: "TOML", fenceAliases: ["toml"], extensions: ["toml"] },
  { id: "tsx", label: "TSX", fenceAliases: ["tsx"], extensions: ["tsx"] },
  { id: "typescript", label: "TypeScript", fenceAliases: ["typescript", "ts"], extensions: ["ts", "mts", "cts"] },
  { id: "xml", label: "XML", fenceAliases: ["xml"], extensions: ["xml", "svg", "xsl", "xsd"] },
  { id: "yaml", label: "YAML", fenceAliases: ["yaml", "yml"], extensions: ["yaml", "yml"] },
];

const LANGUAGE_BY_ID = new Map<string, CodeLanguageDefinition>(CODE_LANGUAGES.map((language) => [language.id, language]));
const LANGUAGE_BY_FENCE = new Map<string, CodeLanguageDefinition>();
const LANGUAGE_BY_EXTENSION = new Map<string, CodeLanguageDefinition>();
const LANGUAGE_BY_FILENAME = new Map<string, CodeLanguageDefinition>();

for (const language of CODE_LANGUAGES) {
  for (const alias of language.fenceAliases) LANGUAGE_BY_FENCE.set(alias, language);
  LANGUAGE_BY_FENCE.set(language.id, language);
  for (const extension of language.extensions) LANGUAGE_BY_EXTENSION.set(extension, language);
  for (const filename of language.filenames ?? []) LANGUAGE_BY_FILENAME.set(filename, language);
}

function basename(value: string) {
  const trimmed = value.trim();
  const parts = trimmed.split("/");
  return (parts[parts.length - 1] ?? trimmed).toLowerCase();
}

/** Resolve a markdown fence language or shiki language id, e.g. `ts`, `TypeScript`, `c++`. */
export function resolveCodeLanguage(value: string | null | undefined): CodeLanguageId | null {
  if (!value) return null;
  return LANGUAGE_BY_FENCE.get(value.trim().toLowerCase())?.id ?? null;
}

/** Resolve a workspace file path or filename to a highlightable language. */
export function detectCodeLanguage(value: string | null | undefined): CodeLanguageId | null {
  if (!value) return null;
  const name = basename(value);
  if (!name) return null;
  const byFilename = LANGUAGE_BY_FILENAME.get(name);
  if (byFilename) return byFilename.id;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return LANGUAGE_BY_EXTENSION.get(name.slice(dot + 1))?.id ?? null;
}

export function codeLanguageLabel(value: CodeLanguageId | string | null | undefined): string | null {
  if (!value) return null;
  const language = LANGUAGE_BY_ID.get(value);
  if (language) return language.label;
  return LANGUAGE_BY_FENCE.get(value.trim().toLowerCase())?.label ?? null;
}
