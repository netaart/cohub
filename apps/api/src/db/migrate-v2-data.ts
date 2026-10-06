import "dotenv/config";
import postgres from "postgres";
import { createLogger } from "@cohub/infra/logging";


const logger = createLogger({ serviceName: "cohub-api" });
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const sql = postgres(connectionString, {
  prepare: false,
  connect_timeout: 10,
  idle_timeout: 30,
});

const mapRuntimeResourceType = (type: string | null): "space" | "session" | null => {
  if (type === "runtime") return "space";
  if (type === "session") return "session";
  return null;
};

async function migrateV2Data() {
  logger.info("[V2 Data Migration] Starting...");

  try {
    await sql`CREATE SCHEMA IF NOT EXISTS v2`;

    logger.info("[V2 Data Migration] Migrating user git accounts...");
    await sql`
      INSERT INTO v2.user_git_accounts (
        id,
        user_uuid,
        provider,
        gitea_user_id,
        gitea_username,
        gitea_password_encrypted,
        gitea_access_token_encrypted,
        status,
        last_verified_at,
        meta,
        created_at,
        updated_at
      )
      SELECT
        id,
        user_uuid,
        provider,
        gitea_user_id,
        gitea_username,
        gitea_password_encrypted,
        gitea_access_token_encrypted,
        status,
        last_verified_at,
        meta,
        created_at,
        updated_at
      FROM public.user_git_accounts
      ON CONFLICT DO NOTHING
    `;

    logger.info("[V2 Data Migration] Migrating user channels...");
    await sql`
      INSERT INTO v2.user_channels (
        id,
        user_uuid,
        provider,
        name,
        credentials,
        status,
        created_at,
        updated_at
      )
      SELECT
        id,
        user_uuid,
        provider,
        name,
        credentials,
        status,
        created_at,
        updated_at
      FROM public.user_channels
      ON CONFLICT DO NOTHING
    `;

    logger.info("[V2 Data Migration] Migrating runtimes as spaces...");
    await sql`
      WITH runtime_candidates AS (
        SELECT
          r.id,
          r.user_uuid,
          COALESCE(r.title, w.name, 'Untitled Space') AS base_name,
          w.description,
          CONCAT('space-', r.id::text) AS storage_repo_name,
          jsonb_strip_nulls(jsonb_build_object(
            'legacyRuntimeId', r.id,
            'legacyWorkspaceId', r.workspace_id,
            'legacyWorkspaceCommitHash', r.workspace_commit_hash,
            'legacyAgentId', r.agent_id,
            'legacyAgentCommitHash', r.agent_commit_hash,
            'legacyRuntimeMeta', r.meta,
            'legacyWorkspaceDefaultBranch', w.default_branch,
            'legacyWorkspaceVisibility', w.visibility,
            'legacyWorkspaceForkCount', w.fork_count,
            'legacyRepoName', w.gitea_repo_name,
            'legacyOriginalName', COALESCE(r.title, w.name, 'Untitled Space')
          )) AS meta,
          r.created_at,
          r.updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY r.user_uuid, COALESCE(r.title, w.name, 'Untitled Space')
            ORDER BY r.created_at ASC, r.id ASC
          ) AS name_rank
        FROM public.runtimes r
        LEFT JOIN public.workspaces w ON w.id = r.workspace_id
      )
      INSERT INTO v2.spaces (
        id,
        user_uuid,
        name,
        description,
        storage_repo_name,
        base_checkpoint_id,
        head_checkpoint_id,
        meta,
        created_at,
        updated_at
      )
      SELECT
        id,
        user_uuid,
        CASE
          WHEN name_rank = 1 THEN base_name
          ELSE CONCAT(base_name, '-', (name_rank - 1)::text)
        END,
        description,
        storage_repo_name,
        NULL,
        NULL,
        meta,
        created_at,
        updated_at
      FROM runtime_candidates
      ON CONFLICT DO NOTHING
    `;

    logger.info("[V2 Data Migration] Migrating runtime sandboxes as space sandboxes...");
    await sql`
      INSERT INTO v2.space_sandboxes (
        space_id,
        status,
        pod_name,
        last_heartbeat_at,
        meta,
        created_at,
        updated_at
      )
      SELECT
        r.id,
        CASE
          WHEN r.status = 'starting' THEN 'provisioning'
          WHEN r.status = 'running' THEN 'ready'
          WHEN r.status = 'hibernated' THEN 'stopped'
          WHEN r.status = 'error' THEN 'error'
          WHEN r.status = 'deleted' THEN 'terminated'
          ELSE 'pending'
        END,
        CONCAT('sandbox-', r.id::text),
        NULL,
        jsonb_strip_nulls(jsonb_build_object(
          'legacyRuntimeStatus', r.status,
          'legacyWorkspaceId', r.workspace_id,
          'legacyRuntimeMeta', r.meta
        )),
        r.created_at,
        r.updated_at
      FROM public.runtimes r
      ON CONFLICT DO NOTHING
    `;

    logger.info("[V2 Data Migration] Migrating space channels...");
    await sql`
      INSERT INTO v2.space_channels (
        id,
        space_id,
        channel_id,
        config,
        created_at
      )
      SELECT
        id,
        runtime_id,
        channel_id,
        config,
        created_at
      FROM public.runtime_channels
      ON CONFLICT DO NOTHING
    `;

    logger.info("[V2 Data Migration] Migrating space sessions...");
    await sql`
      INSERT INTO v2.space_sessions (
        id,
        space_id,
        title,
        source,
        status,
        cwd,
        protocol,
        external_session_id,
        meta,
        parent_session_id,
        forked_from_message_id,
        lineage_root_session_id,
        fork_depth,
        latest_message_text,
        last_message_at,
        last_message_id,
        created_at,
        updated_at
      )
      SELECT
        id,
        runtime_id,
        title,
        source,
        status,
        cwd,
        protocol,
        external_session_id,
        meta,
        parent_session_id,
        forked_from_message_id,
        lineage_root_session_id,
        fork_depth,
        latest_message_text,
        last_message_at,
        last_message_id,
        created_at,
        updated_at
      FROM public.runtime_sessions
      ON CONFLICT DO NOTHING
    `;

    logger.info("[V2 Data Migration] Migrating space session bindings...");
    await sql`
      INSERT INTO v2.space_session_bindings (
        id,
        space_id,
        space_session_id,
        space_channel_id,
        provider,
        binding_key,
        external_chat_id,
        status,
        meta,
        created_at,
        updated_at,
        last_message_at
      )
      SELECT
        id,
        runtime_id,
        runtime_session_id,
        runtime_channel_id,
        provider,
        binding_key,
        external_chat_id,
        status,
        meta,
        created_at,
        updated_at,
        last_message_at
      FROM public.runtime_session_bindings
      ON CONFLICT DO NOTHING
    `;

    logger.info("[V2 Data Migration] Migrating provider message refs...");
    await sql`
      INSERT INTO v2.provider_message_refs (
        id,
        provider,
        space_id,
        space_session_id,
        space_channel_id,
        session_message_id,
        direction,
        external_conversation_id,
        external_message_id,
        parent_external_conversation_id,
        parent_external_message_id,
        external_author_id,
        external_author_name,
        meta,
        created_at,
        updated_at
      )
      SELECT
        id,
        provider,
        runtime_id,
        runtime_session_id,
        runtime_channel_id,
        session_message_id,
        direction,
        external_conversation_id,
        external_message_id,
        parent_external_conversation_id,
        parent_external_message_id,
        external_author_id,
        external_author_name,
        meta,
        created_at,
        updated_at
      FROM public.provider_message_refs
      ON CONFLICT DO NOTHING
    `;

    logger.info("[V2 Data Migration] Migrating session messages...");
    await sql`
      INSERT INTO v2.session_messages (
        id,
        session_id,
        role,
        content,
        text,
        provider,
        model,
        stop_reason,
        error_message,
        sequence,
        idempotency_key,
        usage_input,
        usage_output,
        cost_total,
        meta,
        created_at
      )
      SELECT
        id,
        session_id,
        role,
        content,
        text,
        provider,
        model,
        stop_reason,
        error_message,
        sequence,
        idempotency_key,
        usage_input,
        usage_output,
        cost_total,
        meta,
        created_at
      FROM public.session_messages
      ON CONFLICT DO NOTHING
    `;

    logger.info("[V2 Data Migration] Migrating runtime/session permissions into space members and access policies...");
    const permissions = await sql<{
      resource_type: string;
      resource_id: string;
      grantee_uuid: string | null;
      level: string;
      created_by: string;
      created_at: Date | null;
    }[]>`
      SELECT resource_type, resource_id, grantee_uuid, level, created_by, created_at
      FROM public.resource_permissions
    `;

    for (const permission of permissions) {
      const resourceType = mapRuntimeResourceType(permission.resource_type);
      if (!resourceType) continue;

      if (resourceType === "space" && permission.grantee_uuid) {
        await sql`
          INSERT INTO v2.space_members (
            space_id,
            user_id,
            role,
            created_by,
            updated_by,
            created_at,
            updated_at
          )
          VALUES (
            ${permission.resource_id},
            ${permission.grantee_uuid},
            ${permission.level === "write" ? "builder" : "guest"},
            ${permission.created_by},
            ${permission.created_by},
            coalesce(${permission.created_at}::timestamptz, now()),
            ${permission.created_at}
          )
          ON CONFLICT (space_id, user_id) DO NOTHING
        `;
      }

      if (permission.grantee_uuid === null) {
        await sql`
          INSERT INTO v2.access_policies (
            resource_type,
            resource_id,
            signed_in_user_role,
            anonymous_user_role,
            created_by,
            updated_by,
            created_at,
            updated_at
          )
          VALUES (
            ${resourceType},
            ${permission.resource_id},
            ${permission.level === "private" ? null : "guest"},
            ${permission.level === "private" ? null : "guest"},
            ${permission.created_by},
            ${permission.created_by},
            ${permission.created_at},
            ${permission.created_at}
          )
          ON CONFLICT (resource_type, resource_id) DO NOTHING
        `;
      }
    }

    logger.info("[V2 Data Migration] Migrating public runtime permissions from public workspace visibility...");
    await sql`
      INSERT INTO v2.access_policies (
        resource_type,
        resource_id,
        signed_in_user_role,
        anonymous_user_role,
        created_by,
        updated_by,
        created_at,
        updated_at
      )
      SELECT
        'space',
        r.id,
        'guest',
        'guest',
        r.user_uuid,
        r.user_uuid,
        COALESCE(w.updated_at, w.created_at, r.updated_at, r.created_at, NOW()),
        COALESCE(w.updated_at, w.created_at, r.updated_at, r.created_at, NOW())
      FROM public.runtimes r
      JOIN public.workspaces w ON w.id = r.workspace_id
      WHERE w.visibility = 'public'
      ON CONFLICT DO NOTHING
    `;

    logger.info("[V2 Data Migration] Migrating gateway logs...");
    await sql`
      INSERT INTO v2.gateway_logs (
        id,
        direction,
        provider,
        channel_id,
        external_chat_id,
        raw_payload,
        normalized_payload,
        status,
        error_message,
        created_at
      )
      SELECT
        id,
        direction,
        provider,
        channel_id,
        external_chat_id,
        raw_payload,
        normalized_payload,
        status,
        error_message,
        created_at
      FROM public.gateway_logs
      ON CONFLICT DO NOTHING
    `;

    logger.info("[V2 Data Migration] Migrating cron jobs...");
    await sql`
      INSERT INTO v2.cron_jobs (
        id,
        user_uuid,
        title,
        task_type,
        payload,
        cron_expression,
        timezone,
        bull_job_key,
        space_id,
        session_id,
        enabled,
        deleted_at,
        created_at,
        updated_at
      )
      SELECT
        id,
        user_uuid,
        title,
        task_type,
        payload,
        cron_expression,
        timezone,
        bull_job_key,
        runtime_id,
        session_id,
        enabled,
        deleted_at,
        created_at,
        updated_at
      FROM public.cron_jobs
      ON CONFLICT DO NOTHING
    `;

    logger.info("[V2 Data Migration] Migrating task runs...");
    await sql`
      INSERT INTO v2.task_runs (
        id,
        job_id,
        cron_job_id,
        task_type,
        status,
        payload,
        result,
        error_message,
        attempt_count,
        space_id,
        session_id,
        user_uuid,
        scheduled_at,
        started_at,
        finished_at,
        created_at,
        updated_at
      )
      SELECT
        id,
        job_id,
        cron_job_id,
        task_type,
        status,
        payload,
        result,
        error_message,
        attempt_count,
        runtime_id,
        session_id,
        user_uuid,
        scheduled_at,
        started_at,
        finished_at,
        created_at,
        updated_at
      FROM public.task_runs
      ON CONFLICT DO NOTHING
    `;

    logger.info("[V2 Data Migration] Completed successfully.");
  } catch (error) {
    logger.error("[V2 Data Migration] Failed:", error);
    throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

migrateV2Data();
