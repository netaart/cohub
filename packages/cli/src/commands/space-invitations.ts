import {
  buildSpaceInvitePath,
  type CreateInvitationInput,
  type CreateInvitationResponse,
  type SpaceInvitationListResponse,
  type SpaceRole,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { webUrl } from "../web.js";
import {
  error,
  handleHttp,
  json as outJson,
  jsonRequested,
  ok,
  table,
} from "../output.js";
import { resolveSpace } from "../space.js";

const SPACE_ROLES: SpaceRole[] = ["host", "builder", "guest"];
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const MAX_USES = 10_000;

export type SpaceInvitationCreateCliOptions = {
  role?: string;
  days?: string;
  maxUses?: string;
  json?: boolean;
};

type SpaceInvitationCommandClient = {
  space(spaceId: string): {
    invitations: {
      list(): Promise<SpaceInvitationListResponse>;
      create(input: CreateInvitationInput): Promise<CreateInvitationResponse>;
      revoke(token: string): Promise<{ ok: true }>;
    };
  };
};

export class InvalidSpaceInvitationCliOptionsError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "InvalidSpaceInvitationCliOptionsError";
  }
}

function parseInteger(
  value: string,
  label: string,
  min: number,
  max: number,
): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new InvalidSpaceInvitationCliOptionsError(
      `Invalid ${label}`,
      `${label} must be an integer from ${min} to ${max}`,
    );
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new InvalidSpaceInvitationCliOptionsError(
      `Invalid ${label}`,
      `${label} must be an integer from ${min} to ${max}`,
    );
  }
  return parsed;
}

export function parseSpaceInvitationCreateOptions(
  options: SpaceInvitationCreateCliOptions,
): Required<Pick<CreateInvitationInput, "role" | "ttlSeconds" | "maxUses">> {
  const role = (options.role ?? "builder") as SpaceRole;
  if (!SPACE_ROLES.includes(role)) {
    throw new InvalidSpaceInvitationCliOptionsError(
      "Invalid role",
      `Use one of: ${SPACE_ROLES.join(", ")}`,
    );
  }
  const days = parseInteger(options.days ?? String(DEFAULT_DAYS), "days", 1, MAX_DAYS);
  const maxUses = parseInteger(options.maxUses ?? "0", "max uses", 0, MAX_USES);
  return { role, ttlSeconds: days * 24 * 60 * 60, maxUses };
}

function invitationUrl(
  invitation: {
    token: string;
    spaceId: string;
    ownerUsername: string | null;
    spaceSlug: string | null;
  },
) {
  return webUrl(buildSpaceInvitePath({
    spaceId: invitation.spaceId,
    ownerUsername: invitation.ownerUsername,
    spaceSlug: invitation.spaceSlug,
    inviteCode: invitation.token,
  }));
}

async function confirmRevoke(options: { yes?: boolean }): Promise<void> {
  if (options.yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return error("Confirmation required", "Pass --yes to revoke the invite link.");
  }
  process.stdout.write("This invite link will stop working. Continue? [y/N] ");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    break;
  }
  const answer = Buffer.concat(chunks).toString().trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") return error("Cancelled");
}

export function registerSpaceInvitations(
  spacesCommand: Command,
  dependencies: { createClient: () => SpaceInvitationCommandClient } = {
    createClient,
  },
): Command {
  const invitations = spacesCommand
    .command("invites")
    .description("Create and manage space invite links");

  invitations
    .command("create")
    .description("Create an invite link")
    .option("--role <role>", "Member role: host, builder, or guest", "builder")
    .option("--days <days>", "Validity in days, from 1 to 30", String(DEFAULT_DAYS))
    .option("--max-uses <count>", "Usage limit, or 0 for unlimited", "0")
    .option("--json", "Output as JSON")
    .action(async (options: SpaceInvitationCreateCliOptions) => {
      const spaceId = await resolveSpace(spacesCommand);
      let input: ReturnType<typeof parseSpaceInvitationCreateOptions>;
      try {
        input = parseSpaceInvitationCreateOptions(options);
      } catch (cause) {
        if (cause instanceof InvalidSpaceInvitationCliOptionsError) {
          return error(cause.message, cause.detail);
        }
        throw cause;
      }

      try {
        const created = await dependencies
          .createClient()
          .space(spaceId)
          .invitations.create(input);
        const output = {
          ...created,
          url: invitationUrl({
            ...created,
            spaceId: created.spaceId || spaceId,
            ownerUsername: created.ownerUsername ?? null,
            spaceSlug: created.spaceSlug ?? null,
          }),
        };
        if (jsonRequested(options)) return outJson(output);
        ok(`Invite link created: ${output.url}`);
      } catch (cause: unknown) {
        handleHttp(cause);
      }
    });

  invitations
    .command("ls")
    .alias("list")
    .description("List invite links")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      const spaceId = await resolveSpace(spacesCommand);
      try {
        const result = await dependencies
          .createClient()
          .space(spaceId)
          .invitations.list();
        const items = result.items.map((item) => ({
          ...item,
          url: invitationUrl({
            ...result,
            token: item.token,
            spaceId: result.spaceId || spaceId,
            ownerUsername: result.ownerUsername ?? null,
            spaceSlug: result.spaceSlug ?? null,
          }),
          uses: item.maxUses ? `${item.useCount}/${item.maxUses}` : String(item.useCount),
        }));
        if (jsonRequested(options)) return outJson({ ...result, items });
        table(items, [
          { key: "token", label: "Code" },
          { key: "role", label: "Role" },
          { key: "status", label: "Status" },
          { key: "uses", label: "Uses" },
          { key: "expiresInSeconds", label: "Expires in" },
          { key: "url", label: "URL" },
        ]);
      } catch (cause: unknown) {
        handleHttp(cause);
      }
    });

  invitations
    .command("revoke <code>")
    .description("Revoke an invite link")
    .option("-y, --yes", "Confirm revocation")
    .option("--json", "Output as JSON")
    .action(async (code: string, options: { yes?: boolean; json?: boolean }) => {
      await confirmRevoke(options);
      const spaceId = await resolveSpace(spacesCommand);
      try {
        const result = await dependencies
          .createClient()
          .space(spaceId)
          .invitations.revoke(code);
        if (jsonRequested(options)) return outJson(result);
        ok("Invite link revoked");
      } catch (cause: unknown) {
        handleHttp(cause);
      }
    });

  return invitations;
}
