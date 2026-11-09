import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceModListItem } from "@cohub/core/space-mods";

const root = await mkdtemp(join(tmpdir(), "cohub-system-prompt-"));
const workspaceRoot = join(root, "spaces");
const checkpointCacheRoot = join(root, "checkpoints");
process.env.PLATFORM_CONFIG_ROOT = join(root, "configs");
process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.CHECKPOINT_CACHE_ROOT = checkpointCacheRoot;

const userId = "11111111-1111-4111-8111-111111111111";
const workspace = join(root, "workspace");
const userConfig = join(process.env.PLATFORM_CONFIG_ROOT, "users", userId);
const platformAgent = join(process.env.PLATFORM_CONFIG_ROOT, "platform", ".cohub");

await mkdir(workspace, { recursive: true });
await mkdir(userConfig, { recursive: true });
await mkdir(platformAgent, { recursive: true });
await writeFile(join(platformAgent, "SYSTEM.md"), "You are a Cohub test assistant.");
await writeFile(join(userConfig, "AGENTS.md"), "Always prefer concise answers.");
await mkdir(join(userConfig, ".agents", "skills", "owner-skill"), { recursive: true });
await writeFile(join(userConfig, ".agents", "skills", "owner-skill", "SKILL.md"), "---\nname: owner-skill\ndescription: Owner-only skill\n---\nOwner skill body.");
await writeFile(join(workspace, "AGENTS.md"), "Project rule: run typecheck.");

const { buildCohubSystemPrompt } = await import("../runtime/system-prompt-builder.js");

const prompt = await buildCohubSystemPrompt({
  cwd: workspace,
  userId,
  selectedTools: [],
});

assert.ok(prompt.includes("# User Context"), "should include user context section");
assert.ok(!prompt.includes("/configs/user/AGENTS.md"), "should not expose sandbox user rule path");
assert.ok(prompt.includes("Always prefer concise answers."), "should include user rules content");
assert.ok(prompt.includes("# Project Context"), "should include project context section");
assert.ok(prompt.includes("Project rule: run typecheck."), "should include project rules content");
assert.ok(
  prompt.indexOf("# User Context") < prompt.indexOf("# Project Context"),
  "user context should be rendered before project context",
);

const promptWithoutUser = await buildCohubSystemPrompt({
  cwd: workspace,
  selectedTools: [],
});
assert.ok(!promptWithoutUser.includes("# User Context"), "should not include user context without userId");
assert.ok(promptWithoutUser.includes("# Project Context"), "should still include project context without userId");

// Test YAML block scalar frontmatter parsing
await mkdir(join(workspace, ".agents", "skills", "test-folded"), { recursive: true });
await mkdir(join(workspace, ".agents", "skills", "test-literal"), { recursive: true });
await writeFile(
  join(workspace, ".agents", "skills", "test-folded", "SKILL.md"),
  "---\nname: test-folded\ndescription: >\n  This is a folded\n  multi-line description.\n---\nFolded skill body.",
);
await writeFile(
  join(workspace, ".agents", "skills", "test-literal", "SKILL.md"),
  "---\nname: test-literal\ndescription: |\n  This is a literal\n  multi-line description.\n---\nLiteral skill body.",
);

// Skill with disable-model-invocation should be hidden from the model prompt
await mkdir(join(workspace, ".agents", "skills", "manual-only"), { recursive: true });
await writeFile(
  join(workspace, ".agents", "skills", "manual-only", "SKILL.md"),
  "---\nname: manual-only\ndescription: A side-effecting skill invocable only via /skill:name\ndisable-model-invocation: true\n---\nManual-only skill body.",
);

const promptWithSkills = await buildCohubSystemPrompt({
  cwd: workspace,
  userId,
  selectedTools: ["read"],
});

assert.ok(
  promptWithSkills.includes("This is a folded multi-line description."),
  "folded block scalar (>) should be joined with spaces",
);
assert.ok(
  promptWithSkills.includes("This is a literal\nmulti-line description."),
  "literal block scalar (|) should preserve newlines",
);
assert.ok(
  !promptWithSkills.includes("<description>></description>") && !promptWithSkills.includes("<description>|</description>"),
  "block scalar indicators should not appear as description text",
);
assert.ok(
  promptWithSkills.includes("test-folded"),
  "model-invocable skills should appear in the available_skills block",
);
assert.ok(
  !promptWithSkills.includes("manual-only"),
  "disable-model-invocation skills should be hidden from the available_skills block",
);

const modSpaceId = "22222222-2222-4222-8222-222222222222";
const liveModRoot = join(workspaceRoot, modSpaceId, "workspace");
const modSnapshotRoot = join(checkpointCacheRoot, modSpaceId, "latest");
const liveSkillDir = join(liveModRoot, ".agents", "skills", "shared-mod-skill");
const snapshotSkillDir = join(modSnapshotRoot, ".agents", "skills", "shared-mod-skill");
await Promise.all([
  mkdir(liveSkillDir, { recursive: true }),
  mkdir(snapshotSkillDir, { recursive: true }),
  mkdir(join(liveModRoot, ".agents", "skills", "live-only-skill"), { recursive: true }),
  mkdir(join(modSnapshotRoot, ".cohub"), { recursive: true }),
  mkdir(join(liveModRoot, ".cohub"), { recursive: true }),
]);
await Promise.all([
  writeFile(join(liveSkillDir, "SKILL.md"), "---\nname: shared-mod-skill\ndescription: Live workspace skill description\n---\nLive workspace body."),
  writeFile(join(snapshotSkillDir, "SKILL.md"), "---\nname: shared-mod-skill\ndescription: Latest checkpoint skill description\n---\nCheckpoint body."),
  writeFile(join(liveModRoot, ".agents", "skills", "live-only-skill", "SKILL.md"), "---\nname: live-only-skill\ndescription: Live-only skill description\n---\nLive-only body."),
  writeFile(join(liveModRoot, "AGENTS.md"), "Live workspace Mod context."),
  writeFile(join(modSnapshotRoot, "AGENTS.md"), "Latest checkpoint Mod context."),
  writeFile(join(liveModRoot, ".cohub", "APPEND_SYSTEM.md"), "Live workspace append prompt."),
  writeFile(join(modSnapshotRoot, ".cohub", "APPEND_SYSTEM.md"), "Latest checkpoint append prompt."),
]);

const spaceMod = {
  id: "33333333-3333-4333-8333-333333333333",
  spaceId: "44444444-4444-4444-8444-444444444444",
  modSpaceId,
  name: "Shared Mod",
  mountSlug: "shared-mod",
  enabled: true,
  sortOrder: 0,
  createdBy: userId,
  createdAt: null,
  updatedAt: null,
  modSpaceName: "Shared Mod Space",
  modSpaceDescription: null,
  mountPath: "/mods/shared-mod",
} satisfies SpaceModListItem;

const promptWithMod = await buildCohubSystemPrompt({
  cwd: workspace,
  userId,
  selectedTools: ["read"],
  spaceMods: [spaceMod],
});
assert.ok(promptWithMod.includes("Latest checkpoint skill description"), "should load Mod skills from the latest checkpoint");
assert.ok(promptWithMod.includes("Latest checkpoint Mod context."), "should load Mod context from the latest checkpoint");
assert.ok(promptWithMod.includes("Latest checkpoint append prompt."), "should load Mod append prompts from the latest checkpoint");
assert.ok(promptWithMod.includes("<location>/mods/shared-mod/.agents/skills/shared-mod-skill/SKILL.md</location>"), "should expose the mounted checkpoint skill path");
assert.ok(!promptWithMod.includes("Live workspace skill description"), "should not load Mod skills from the live workspace");
assert.ok(!promptWithMod.includes("live-only-skill"), "should not expose live-only Mod skills");
assert.ok(!promptWithMod.includes("Live workspace Mod context."), "should not load Mod context from the live workspace");
assert.ok(!promptWithMod.includes("Live workspace append prompt."), "should not load Mod append prompts from the live workspace");

const hostRoot = "/Users/me/project";
const modHostPath = "/Users/me/.cache/cohub/spaces/s/mods/shared-mod";
const localSkill = { name: "local-skill", description: "Local skill description", content: "", filePath: "", baseDir: "", sandboxFilePath: "/workspace/.agents/skills/local-skill/SKILL.md", sandboxBaseDir: "/workspace/.agents/skills/local-skill", scope: "project", disableModelInvocation: false } as const;
const buildLocalPrompt = (mounts: { hostPaths: Record<string, string>; files: ReadonlySet<string> } | null) => buildCohubSystemPrompt({
  cwd: workspace,
  userId,
  selectedTools: ["read"],
  spaceMods: [spaceMod],
  localWorkspace: { hostRoot, files: { "AGENTS.md": "Local project rule." }, skills: [localSkill], mounts },
});
const localPrompt = await buildLocalPrompt({
  hostPaths: { "/mods/shared-mod": modHostPath, "/configs/user/.agents": "/Users/me/.cache/cohub/spaces/s/user-agents" },
  files: new Set(["/mods/shared-mod/.agents/skills/shared-mod-skill/SKILL.md", "/configs/user/.agents/skills/owner-skill/SKILL.md"]),
});
assert.ok(localPrompt.includes("Local project rule.") && !localPrompt.includes("Project rule: run typecheck."), "local Spaces should use the Runtime's project files, not the cloud copy");
assert.ok(localPrompt.includes(`<location>${hostRoot}/.agents/skills/local-skill/SKILL.md</location>`), "local project skills should be listed at their host path");
assert.ok(localPrompt.includes(`<location>${modHostPath}/.agents/skills/shared-mod-skill/SKILL.md</location>`) && localPrompt.includes("owner-skill"), "mounted skills are listed at the host path shell commands can use");
assert.ok(!localPrompt.includes("<location>/configs/") && !localPrompt.includes("<location>/mods/"), "no sandbox-only skill paths on a POSIX host");
assert.ok(localPrompt.includes(`- /workspace → ${hostRoot}`) && localPrompt.includes(`- /mods/shared-mod → ${modHostPath}`), "host paths should be mapped for shell commands");

const unmountedPrompt = await buildLocalPrompt(null);
assert.ok(unmountedPrompt.includes("local-skill") && !unmountedPrompt.includes("owner-skill") && !unmountedPrompt.includes("# Mods"), "a Runtime without mounts should list only project skills");

const platformSkillDir = join(process.env.PLATFORM_CONFIG_ROOT, "platform", ".agents", "skills", "owner-skill");
await mkdir(platformSkillDir, { recursive: true });
await writeFile(join(platformSkillDir, "SKILL.md"), "---\nname: owner-skill\ndescription: Platform fallback\n---\nPlatform body.");
const fallbackPrompt = await buildLocalPrompt({
  hostPaths: { "/configs/platform/.agents": "/host/platform-agents", "/configs/user/.agents": "/host/user-agents" },
  files: new Set(["/configs/platform/.agents/skills/owner-skill/SKILL.md"]),
});
assert.ok(fallbackPrompt.includes("Platform fallback"), "a skill that was not mirrored must not hide a mirrored lower-priority one");

const windowsPrompt = await buildCohubSystemPrompt({
  cwd: workspace,
  selectedTools: ["read"],
  localWorkspace: { hostRoot: "C:\\Users\\me\\proj", files: {}, skills: [localSkill], mounts: null },
});
assert.ok(windowsPrompt.includes("<location>/workspace/.agents/skills/local-skill/SKILL.md</location>"), "Windows hosts keep sandbox paths, which file tools accept");
