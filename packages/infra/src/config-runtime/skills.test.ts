import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bindModSkillsConfig,
  bindSpaceModSkillsConfig,
  createSkillLoader,
  formatSkillExpansion,
  mergeSkillsConfigs,
  nativeHarnessSkillLocation,
  reachableSkillScopes,
  resolveSkillExecutionTarget,
  toSkillCatalog,
  unreachableSkillMessage,
  type Skill,
} from "./skills.js";

function createSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "example",
    description: "Example skill",
    content: "---\nname: example\n---\nExample",
    filePath: "/cache/mod/.agents/skills/example/SKILL.md",
    sandboxFilePath: "/mods/old/.agents/skills/example/SKILL.md",
    baseDir: "/cache/mod/.agents/skills/example",
    sandboxBaseDir: "/mods/old/.agents/skills/example",
    scope: "mod",
    disableModelInvocation: false,
    ...overrides,
  };
}

test("bindModSkillsConfig binds provenance and current mount paths", () => {
  const bound = bindModSkillsConfig(
    { skills: [createSkill()] },
    {
      skillsDir: "/cache/mod/.agents/skills",
      sandboxDir: "/mods/current/.agents/skills",
      modSpaceId: "mod-space-id",
      mountSlug: "current",
    },
  );

  assert.deepEqual(bound.skills[0]?.source, {
    type: "mod",
    modSpaceId: "mod-space-id",
    mountSlug: "current",
  });
  assert.equal(bound.skills[0]?.sandboxFilePath, "/mods/current/.agents/skills/example/SKILL.md");
  assert.equal(bound.skills[0]?.sandboxBaseDir, "/mods/current/.agents/skills/example");
});

test("bindModSkillsConfig rebases cache entries created under another host root", () => {
  const bound = bindModSkillsConfig(
    { skills: [createSkill()] },
    {
      skillsDir: "/worker-cache/mod/.agents/skills",
      sandboxDir: "/mods/current/.agents/skills",
      modSpaceId: "mod-space-id",
      mountSlug: "current",
    },
  );

  assert.equal(bound.skills[0]?.sandboxFilePath, "/mods/current/.agents/skills/example/SKILL.md");
  assert.equal(bound.skills[0]?.sandboxBaseDir, "/mods/current/.agents/skills/example");
});

test("bindSpaceModSkillsConfig validates and rebinds aggregate cache entries", () => {
  const rebound = bindSpaceModSkillsConfig(
    {
      skills: [createSkill({
        source: {
          type: "mod",
          modSpaceId: "mod-space-id",
          mountSlug: "current",
        },
      })],
    },
    [{
      skillsDir: "/worker-cache/mod/.agents/skills",
      sandboxDir: "/mods/current/.agents/skills",
      modSpaceId: "mod-space-id",
      mountSlug: "current",
    }],
  );

  assert.equal(rebound.skills[0]?.sandboxFilePath, "/mods/current/.agents/skills/example/SKILL.md");
});

test("toSkillCatalog preserves mod provenance", () => {
  const [entry] = toSkillCatalog([
    createSkill({
      source: {
        type: "mod",
        modSpaceId: "mod-space-id",
        mountSlug: "current",
      },
    }),
  ]);

  assert.deepEqual(entry, {
    name: "example",
    description: "Example skill",
    scope: "mod",
    source: {
      type: "mod",
      modSpaceId: "mod-space-id",
      mountSlug: "current",
    },
  });
});

test("mergeSkillsConfigs keeps the source of the effective skill", () => {
  const merged = mergeSkillsConfigs(
    {
      skills: [createSkill({ source: { type: "mod", modSpaceId: "first", mountSlug: "first" } })],
    },
    {
      skills: [createSkill({ source: { type: "mod", modSpaceId: "second", mountSlug: "second" } })],
    },
  );

  assert.equal(merged.skills[0]?.source?.modSpaceId, "second");
  assert.equal(merged.skills[0]?.source?.mountSlug, "second");
});

test("bindModSkillsConfig rejects paths outside the cached mod directory", () => {
  const binding = {
    skillsDir: "/cache/mod/.agents/skills",
    sandboxDir: "/mods/current/.agents/skills",
    modSpaceId: "mod-space-id",
    mountSlug: "current",
  };

  assert.throws(
    () => bindModSkillsConfig(
      { skills: [createSkill({ filePath: "/cache/other/SKILL.md" })] },
      binding,
    ),
    /outside its source directory/,
  );
  assert.throws(
    () => bindModSkillsConfig(
      {
        skills: [createSkill({
          filePath: "/other-root/.agents/skills/example/../../../../workspace/secret",
        })],
      },
      binding,
    ),
    /outside its source directory/,
  );
});

test("reachableSkillScopes grades scopes by execution target", () => {
  assert.deepEqual(reachableSkillScopes("cloud_sandbox"), ["platform", "mod", "user", "project"]);
  assert.deepEqual(reachableSkillScopes("local_sandbox"), ["project"]);
  assert.deepEqual(reachableSkillScopes("native_harness"), ["project"]);
});

test("formatSkillExpansion honors a workspace-relative location override", () => {
  const withOverride = formatSkillExpansion({
    name: "example",
    sandboxFilePath: "/workspace/.agents/skills/example/SKILL.md",
    sandboxBaseDir: "/workspace/.agents/skills/example",
    content: "Example body",
    location: nativeHarnessSkillLocation({
      sandboxFilePath: "/workspace/.agents/skills/example/SKILL.md",
      sandboxBaseDir: "/workspace/.agents/skills/example",
    }),
  });
  assert.match(withOverride, /location="\.agents\/skills\/example\/SKILL\.md"/);
  assert.match(withOverride, /References are relative to \.agents\/skills\/example\./);

  const withoutOverride = formatSkillExpansion({
    name: "example",
    sandboxFilePath: "/workspace/.agents/skills/example/SKILL.md",
    sandboxBaseDir: "/workspace/.agents/skills/example",
    content: "Example body",
  });
  assert.match(withoutOverride, /location="\/workspace\/\.agents\/skills\/example\/SKILL\.md"/);
});

test("nativeHarnessSkillLocation keeps non-workspace paths absolute", () => {
  const location = nativeHarnessSkillLocation({
    sandboxFilePath: "/configs/user/.agents/skills/other/SKILL.md",
    sandboxBaseDir: "/configs/user/.agents/skills/other",
  });
  assert.equal(location.filePath, "/configs/user/.agents/skills/other/SKILL.md");
});

test("resolveSkillExecutionTarget maps harness, provider, and lookup failure", async () => {
  assert.equal(await resolveSkillExecutionTarget({ harness: "pi" }), "native_harness");
  assert.equal(await resolveSkillExecutionTarget({ harness: "codex", spaceId: "s1" }), "native_harness");
  assert.equal(await resolveSkillExecutionTarget({}), "cloud_sandbox");
  assert.equal(await resolveSkillExecutionTarget({ harness: "cohub", spaceId: "s1", getSandboxProvider: async () => "local" }), "local_sandbox");
  assert.equal(await resolveSkillExecutionTarget({ harness: "cohub", spaceId: "s1", getSandboxProvider: async () => "cloud" }), "cloud_sandbox");
  // A missing sandbox record is the cloud default: cloud spaces register
  // their sandbox lazily, so no record must not lock out platform/user/Mod skills.
  assert.equal(await resolveSkillExecutionTarget({ spaceId: "s1", getSandboxProvider: async () => null }), "cloud_sandbox");
  // A failed provider lookup fails closed to workspace-only scopes.
  assert.equal(
    await resolveSkillExecutionTarget({ spaceId: "s1", getSandboxProvider: async () => { throw new Error("db down"); } }),
    "unverified_sandbox",
  );
  assert.equal(await resolveSkillExecutionTarget({ spaceId: "s1" }), "unverified_sandbox");
  assert.deepEqual(reachableSkillScopes("unverified_sandbox"), ["project"]);
});

test("createSkillLoader fetches only reachable scopes and ignores reachability for findScope", async () => {
  const loaded: string[] = [];
  const scopeLoader = (scope: string) => async () => {
    loaded.push(scope);
    return { skills: [createSkill({ name: `${scope}-skill`, scope: scope as Skill["scope"] })] };
  };
  const loader = createSkillLoader({
    scopes: {
      platform: scopeLoader("platform"),
      mod: scopeLoader("mod"),
      user: scopeLoader("user"),
      project: scopeLoader("project"),
    },
    getSandboxProvider: async () => "local",
  });

  const reachable = await loader.fetch({ userId: "u1", spaceId: "s1", harness: "cohub" });
  assert.deepEqual(loaded, ["project"]);
  assert.deepEqual(reachable.map((skill) => skill.name), ["project-skill"]);

  loaded.length = 0;
  const scope = await loader.findScope("user-skill", { userId: "u1", spaceId: "s1" });
  assert.equal(scope, "user");
  assert.deepEqual(loaded.sort(), ["mod", "platform", "project", "user"]);
});

test("unreachableSkillMessage names the skill and its scope", () => {
  assert.equal(
    unreachableSkillMessage("deploy", "user"),
    "Skill deploy (user scope) is not available in this execution environment",
  );
});

test("skillLoader.expand resolves one target for filtering, diagnosis, and location", async () => {
  const platformSkill = createSkill({ name: "deploy", scope: "platform", sandboxFilePath: "/configs/platform/.agents/skills/deploy/SKILL.md", sandboxBaseDir: "/configs/platform/.agents/skills/deploy", content: "Deploy body" });
  const projectSkill = createSkill({ name: "review", scope: "project", sandboxFilePath: "/workspace/.agents/skills/review/SKILL.md", sandboxBaseDir: "/workspace/.agents/skills/review", content: "Review body" });
  const byScope = new Map([["platform", [platformSkill]], ["project", [projectSkill]]]);
  const providerCalls: string[] = [];
  const loader = createSkillLoader({
    scopes: {
      platform: async () => ({ skills: byScope.get("platform") ?? [] }),
      mod: async () => null,
      user: async () => null,
      project: async (spaceId) => (spaceId ? { skills: byScope.get("project") ?? [] } : null),
    },
    getSandboxProvider: async (spaceId) => {
      providerCalls.push(spaceId);
      return "cloud";
    },
  });

  // Native harness: project skill expands with a workspace-relative location,
  // and a platform-only skill passes through as null (single DB resolution).
  providerCalls.length = 0;
  const expanded = await loader.expand("/skill:review args", { userId: "u1", spaceId: "s1", harness: "pi" });
  assert.equal(expanded?.skill.name, "review");
  assert.match(expanded?.renderedText ?? "", /location="\.agents\/skills\/review\/SKILL\.md"/);
  assert.equal(expanded?.argsText, "args");
  assert.equal(await loader.expand("/skill:deploy", { userId: "u1", spaceId: "s1", harness: "pi" }), null);
  assert.deepEqual(providerCalls, []); // native never queries the provider

  // Cohub on a cloud sandbox: platform skill expands with its absolute location.
  const cloud = await loader.expand("/skill:deploy", { userId: "u1", spaceId: "s1", harness: "cohub" });
  assert.equal(cloud?.skill.name, "deploy");
  assert.match(cloud?.renderedText ?? "", /location="\/configs\/platform\/\.agents\/skills\/deploy\/SKILL\.md"/);

  // Cohub on a local sandbox: a platform-only skill reports its unreachable scope.
  const localLoader = createSkillLoader({
    scopes: {
      platform: async () => ({ skills: [platformSkill] }),
      mod: async () => null,
      user: async () => null,
      project: async () => null,
    },
    getSandboxProvider: async () => "local",
  });
  await assert.rejects(
    localLoader.expand("/skill:deploy", { userId: "u1", spaceId: "s1", harness: "cohub" }),
    /Skill deploy \(platform scope\) is not available in this execution environment/,
  );

  // Unknown names keep failing explicitly on Cohub turns.
  await assert.rejects(
    localLoader.expand("/skill:ghost", { userId: "u1", spaceId: "s1", harness: "cohub" }),
    /Unknown skill: ghost/,
  );
});
