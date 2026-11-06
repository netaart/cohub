import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpaceModListItem } from "@cohub/core/space-mods";
import {
  bindModSkillsConfig,
  loadSkillsFromDirectory,
  mergeSkillsConfigs,
  type Skill,
  type SkillDirectoryReader,
  type SkillScope,
} from "@cohub/infra/config-runtime/skills";
import {
  getAgentPlatformAgentPath,
  getAgentModSnapshotPath,
  getAgentPlatformSkillsPath,
  getAgentUserAgentsPath,
  getAgentUserConfigPath,
  getAgentUserSkillsPath,
  SANDBOX_PLATFORM_AGENTS_PATH,
  SANDBOX_PLATFORM_SKILLS_PATH,
  SANDBOX_USER_AGENTS_PATH,
  SANDBOX_USER_CONFIG_PATH,
  SANDBOX_USER_SKILLS_PATH,
  SANDBOX_WORKSPACE_PATH,
  SANDBOX_WORKSPACE_SKILLS_PATH,
} from "./paths.js";

const FALLBACK_SYSTEM_PROMPT = "You are a helpful assistant.";

type LoadedContextFile = {
  sandboxPath: string;
  content: string;
};

/** Project files of a Local Runtime folder, read from the user's machine through `/workspace` paths. */
export type LocalPromptWorkspace = {
  /** Host path of the folder, or null when the Local Runtime could not be reached. */
  hostRoot: string | null;
  /** Host path of each read-only mount on the machine, by sandbox path; null when it holds none. */
  mounts: Record<string, string> | null;
  /** Workspace-relative file text; undefined when missing or unreadable. */
  readText(relativePath: string): Promise<string | undefined>;
  skillReader: SkillDirectoryReader;
};

type ProjectFiles = {
  readText(relativePath: string): Promise<string | undefined>;
  loadSkills(): Promise<Skill[]>;
};

export type BuildCohubSystemPromptOptions = {
  cwd: string;
  userId?: string | null;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  spaceMods?: SpaceModListItem[];
  includeUserSkills?: boolean;
  /** Set for local Spaces, whose project files live on the user's machine. */
  localWorkspace?: LocalPromptWorkspace;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    const content = (await readFile(path, "utf-8")).trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

async function loadFirstExisting(reads: Array<() => Promise<string | undefined>>): Promise<string | undefined> {
  for (const read of reads) {
    const content = await read();
    if (content) return content;
  }
  return undefined;
}

async function loadContextFiles(readText: (name: string) => Promise<string | undefined>, sandboxRoot: string): Promise<LoadedContextFile[]> {
  const files: LoadedContextFile[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const content = await readText(name);
    if (content) files.push({ sandboxPath: `${sandboxRoot}/${name}`, content });
  }
  return files;
}

function loadContextFilesFromRoot(root: string, sandboxRoot: string): Promise<LoadedContextFile[]> {
  return loadContextFiles((name) => readTextIfExists(join(root, name)), sandboxRoot);
}

async function loadSkillsFromDir(input: {
  agentDir: string;
  sandboxDir: string;
  scope: SkillScope;
}): Promise<Skill[]> {
  if (!(await pathExists(input.agentDir))) return [];
  const { content } = await loadSkillsFromDirectory({
    dir: input.agentDir,
    sandboxDir: input.sandboxDir,
    scope: input.scope,
  });
  return content.skills;
}

async function loadModSkills(mod: SpaceModListItem): Promise<Skill[]> {
  const skillsDir = join(getAgentModSnapshotPath(mod.modSpaceId), ".agents", "skills");
  const skills = await loadSkillsFromDir({
    agentDir: skillsDir,
    sandboxDir: `${mod.mountPath}/.agents/skills`,
    scope: "mod",
  });
  return bindModSkillsConfig(
    { skills },
    {
      skillsDir,
      sandboxDir: `${mod.mountPath}/.agents/skills`,
      modSpaceId: mod.modSpaceId,
      mountSlug: mod.mountSlug,
    },
  ).skills;
}

function cloudProjectFiles(cwd: string): ProjectFiles {
  return {
    readText: (relativePath) => readTextIfExists(join(cwd, relativePath)),
    loadSkills: () => loadSkillsFromDir({
      agentDir: join(cwd, ".agents", "skills"),
      sandboxDir: SANDBOX_WORKSPACE_SKILLS_PATH,
      scope: "project",
    }),
  };
}

function localProjectFiles(workspace: LocalPromptWorkspace): ProjectFiles {
  return {
    readText: (relativePath) => workspace.readText(relativePath),
    loadSkills: async () => (await loadSkillsFromDirectory({
      dir: SANDBOX_WORKSPACE_SKILLS_PATH,
      sandboxDir: SANDBOX_WORKSPACE_SKILLS_PATH,
      scope: "project",
      reader: workspace.skillReader,
    })).content.skills,
  };
}

async function loadMergedSkills(project: ProjectFiles, userId?: string | null, spaceMods: SpaceModListItem[] = [], options: { includePlatformSkills?: boolean; includeUserSkills?: boolean } = {}): Promise<Skill[]> {
  const modSkillGroups = await Promise.all(spaceMods.map(loadModSkills));

  const [platformSkills, userSkills, workspaceSkills] = await Promise.all([
    options.includePlatformSkills !== false
      ? loadSkillsFromDir({
          agentDir: getAgentPlatformSkillsPath(),
          sandboxDir: SANDBOX_PLATFORM_SKILLS_PATH,
          scope: "platform",
        })
      : Promise.resolve([]),
    userId && options.includeUserSkills !== false
      ? loadSkillsFromDir({
          agentDir: getAgentUserSkillsPath(userId),
          sandboxDir: SANDBOX_USER_SKILLS_PATH,
          scope: "user",
        })
      : Promise.resolve([]),
    project.loadSkills(),
  ]);

  // Priority (later overrides earlier): platform < mods < user < workspace
  return mergeSkillsConfigs(
    { skills: platformSkills },
    ...modSkillGroups.map((skills) => ({ skills })),
    { skills: userSkills },
    { skills: workspaceSkills },
  ).skills;
}

function formatSkillsForPrompt(skills: Skill[]): string {
  // Skills with disableModelInvocation are hidden from the model; they remain
  // invocable explicitly via `/skill:name`.
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";

  let out = "The following skills provide specialized instructions for specific tasks.\n";
  out += "Use the read tool to load a skill's file when the task matches its description.\n";
  out += "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n";
  out += "<available_skills>\n";
  for (const skill of visible) {
    out += "  <skill>\n";
    out += `    <name>${skill.name}</name>\n`;
    out += `    <description>${skill.description}</description>\n`;
    out += `    <location>${skill.sandboxFilePath}</location>\n`;
    out += "  </skill>\n";
  }
  out += "</available_skills>";
  return out;
}

function formatLocalWorkspace(workspace: LocalPromptWorkspace): string {
  const mappings = [[SANDBOX_WORKSPACE_PATH, workspace.hostRoot], ...Object.entries(workspace.mounts ?? {})]
    .filter((entry): entry is [string, string] => Boolean(entry[1]));
  let out = `This Space runs on the user's own machine through Cohub Local. File tools take sandbox paths; shell commands run directly on the host, start in the ${SANDBOX_WORKSPACE_PATH} folder, and need host paths or paths relative to it.`;
  if (mappings.length > 0) out += `\nSandbox path → host path:\n${mappings.map(([sandboxPath, hostPath]) => `- ${sandboxPath} → ${hostPath}`).join("\n")}`;
  return out;
}

export async function buildCohubSystemPrompt(options: BuildCohubSystemPromptOptions): Promise<string> {
  const {
    cwd,
    userId,
    selectedTools = ["read", "bash", "edit", "write"],
    toolSnippets = {},
    promptGuidelines = [],
    includeUserSkills = true,
    localWorkspace,
  } = options;
  // A Local Runtime reaches only the mounts it holds; a cloud Pod holds them all.
  const mounted = (path: string) => !localWorkspace || Boolean(localWorkspace.mounts?.[path]);
  const spaceMods = (options.spaceMods ?? []).filter((mod) => mounted(mod.mountPath));
  const project = localWorkspace ? localProjectFiles(localWorkspace) : cloudProjectFiles(cwd);

  const userAgentDir = userId ? getAgentUserAgentsPath(userId) : null;
  const systemPrompt = await loadFirstExisting([
    () => project.readText(".agents/SYSTEM.md"),
    ...(userAgentDir ? [() => readTextIfExists(join(userAgentDir, "SYSTEM.md"))] : []),
    () => readTextIfExists(join(getAgentPlatformAgentPath(), "SYSTEM.md")),
  ]) ?? FALLBACK_SYSTEM_PROMPT;

  const appendSystemPrompts = (await Promise.all([
    readTextIfExists(join(getAgentPlatformAgentPath(), "APPEND_SYSTEM.md")),
    ...spaceMods.map((mod) => readTextIfExists(join(getAgentModSnapshotPath(mod.modSpaceId), ".cohub", "APPEND_SYSTEM.md"))),
    ...(userAgentDir ? [readTextIfExists(join(userAgentDir, "APPEND_SYSTEM.md"))] : []),
    project.readText(".agents/APPEND_SYSTEM.md"),
  ])).filter((value): value is string => Boolean(value));

  const [userContextFiles, modContextGroups, projectContextFiles, skills] = await Promise.all([
    userId ? loadContextFilesFromRoot(getAgentUserConfigPath(userId), SANDBOX_USER_CONFIG_PATH) : Promise.resolve([]),
    Promise.all(spaceMods.map((mod) => loadContextFilesFromRoot(getAgentModSnapshotPath(mod.modSpaceId), mod.mountPath))),
    loadContextFiles((name) => project.readText(name), SANDBOX_WORKSPACE_PATH),
    selectedTools.includes("read")
      ? loadMergedSkills(project, userId, spaceMods, {
        includePlatformSkills: mounted(SANDBOX_PLATFORM_AGENTS_PATH),
        includeUserSkills: includeUserSkills && mounted(SANDBOX_USER_AGENTS_PATH),
      })
      : Promise.resolve([]),
  ]);

  const sections: string[] = [systemPrompt, ...appendSystemPrompts];

  if (userContextFiles.length > 0) {
    let userContext = "# User Context\n\nThe following are user-specific preferences and instructions. Follow them when they do not conflict with platform, safety, or project-specific instructions:";
    for (const file of userContextFiles) {
      userContext += `\n\n${file.content}`;
    }
    sections.push(userContext);
  }

  const modContextFiles = modContextGroups.flat();
  if (spaceMods.length > 0 || modContextFiles.length > 0) {
    let modContext = '# Mods\n\nMods are additional read-only resources mounted under /mods. Each list item is "name: path". Instruction priority: platform < mods < user < workspace.';
    for (const mod of spaceMods) {
      modContext += `\n- ${mod.modSpaceName ?? mod.modSpaceId}: ${mod.mountPath}`;
    }
    for (const file of modContextFiles) {
      modContext += `\n\n## ${file.sandboxPath}\n\n${file.content}`;
    }
    sections.push(modContext);
  }

  if (projectContextFiles.length > 0) {
    let projectContext = "# Project Context\n\nProject-specific instructions and guidelines:";
    for (const file of projectContextFiles) {
      projectContext += `\n\n## ${file.sandboxPath}\n\n${file.content}`;
    }
    sections.push(projectContext);
  }

  if (skills.length > 0) {
    sections.push(formatSkillsForPrompt(skills));
  }

  const visibleTools = selectedTools.filter((name) => toolSnippets[name]);
  const toolsList = visibleTools.length > 0
    ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n")
    : "";

  const guidelines = new Set<string>();
  if (selectedTools.includes("bash") && (selectedTools.includes("grep") || selectedTools.includes("find") || selectedTools.includes("ls"))) {
    guidelines.add("Prefer grep/find/ls tools over bash for file exploration when available");
  }
  for (const item of promptGuidelines) {
    const value = item.trim();
    if (value) guidelines.add(value);
  }

  if (systemPrompt === FALLBACK_SYSTEM_PROMPT) {
    if (toolsList) {
      sections.push(`Available tools:\n${toolsList}`);
    }
    if (guidelines.size > 0) {
      sections.push(`Guidelines:\n${Array.from(guidelines).map((line) => `- ${line}`).join("\n")}`);
    }
  }

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  sections.push(`Current date: ${date}`);
  sections.push(`Current working directory: ${SANDBOX_WORKSPACE_PATH}`);
  if (localWorkspace) sections.push(formatLocalWorkspace(localWorkspace));

  return sections.filter((section) => section.trim().length > 0).join("\n\n");
}
