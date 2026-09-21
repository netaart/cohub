import type { CohubClient, CronJobRecord, SandboxSpecId, SpaceMember, SpaceModListItem, SpaceRole, SpaceSandboxConfig } from "@neta-art/cohub";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@/src/i18n";

export type SpaceEnvironmentItem = { name: string; value: string };
type InvitationItem = { token: string; role: SpaceRole; status: string };
export type SpaceSettingsResourceState = { loading: boolean; loaded: boolean; error: string | null };
const RESOURCE_KEYS = ["env", "config", "ports", "allowedSpec", "members", "invitations", "mods", "schedules"] as const;
type ResourceKey = (typeof RESOURCE_KEYS)[number];

export function useSpaceSettings(client: CohubClient | null, spaceId: string) {
  const { t } = useTranslation();
  const [env, setEnv] = useState<SpaceEnvironmentItem[]>([]);
  const [config, setConfig] = useState<SpaceSandboxConfig | null>(null);
  const [ports, setPorts] = useState<Record<string, { url?: string; port?: number }>>({});
  const [allowedSpec, setAllowedSpec] = useState<SandboxSpecId>("standard");
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [invitations, setInvitations] = useState<InvitationItem[]>([]);
  const [mods, setMods] = useState<SpaceModListItem[]>([]);
  const [schedules, setSchedules] = useState<CronJobRecord[]>([]);
  const [resources, setResources] = useState<Record<ResourceKey, SpaceSettingsResourceState>>(() =>
    Object.fromEntries(RESOURCE_KEYS.map((key) => [key, { loading: true, loaded: false, error: null }])) as Record<ResourceKey, SpaceSettingsResourceState>,
  );
  const requests = useRef<Record<ResourceKey, number>>({ env: 0, config: 0, ports: 0, allowedSpec: 0, members: 0, invitations: 0, mods: 0, schedules: 0 });

  const loadResource = useCallback(async (key: ResourceKey): Promise<void> => {
    const token = ++requests.current[key];
    setResources((current) => ({ ...current, [key]: { ...current[key], loading: true, error: null } }));
    const fail = (error: unknown) => {
      if (requests.current[key] !== token) return;
      setResources((current) => ({ ...current, [key]: { ...current[key], loading: false, error: error instanceof Error ? error.message : t("space.settings.loadFailed") } }));
    };
    if (!client || !spaceId) {
      fail(new Error(t(spaceId ? "data.stillConnecting" : "space.unavailable")));
      return;
    }
    const space = client.space(spaceId);
    async function read<T>(operation: () => Promise<T>, apply: (result: T) => void) {
      try {
        const result = await operation();
        if (requests.current[key] !== token) return;
        apply(result);
        setResources((current) => ({ ...current, [key]: { loading: false, loaded: true, error: null } }));
      } catch (error) {
        fail(error);
      }
    }
    // Independent sections settle immediately; a failed port or permission read cannot hide the rest.
    await {
      env: () => read(() => space.env.list(), (result) => setEnv(result.env)),
      config: () => read(() => space.getConfig(), (result) => setConfig(result.config.sandbox)),
      ports: () => read(() => space.sandbox.ports(), (result) => setPorts(result.endpoints)),
      allowedSpec: () => read(
        () => Promise.all([client.billing.getFeatureEntitlement("sandbox.spec.boost"), client.billing.getFeatureEntitlement("sandbox.spec.ultra")]),
        ([boost, ultra]) => setAllowedSpec(ultra.enabled ? "ultra" : boost.enabled ? "boost" : "standard"),
      ),
      members: () => read(() => space.members.list(), (result) => setMembers(result.items)),
      invitations: () => read(() => space.invitations.list(), (result) => setInvitations(result.items)),
      mods: () => read(() => space.mods.list(), (result) => setMods(result.items)),
      schedules: () => read(() => client.cronJobs.list(spaceId), (result) => setSchedules(result.jobs)),
    }[key]();
  }, [client, spaceId, t]);

  useEffect(() => {
    let active = true;
    const generations = requests.current;
    void Promise.resolve().then(() => {
      if (active) for (const key of RESOURCE_KEYS) void loadResource(key);
    });
    return () => {
      active = false;
      for (const key of RESOURCE_KEYS) generations[key] += 1;
    };
  }, [loadResource]);

  return { env, setEnv, config, setConfig, ports, allowedSpec, members, setMembers, invitations, setInvitations, mods, setMods, schedules, setSchedules, resources, loadResource };
}
