-- Identify the user config Space by slug; keep any replaced slug in meta.previousSlug.
UPDATE "v2"."spaces" AS s
SET
  "slug" = 'config',
  "meta" = CASE
    WHEN s."slug" IS NULL THEN s."meta"
    ELSE coalesce(s."meta", '{}'::jsonb) || jsonb_build_object('previousSlug', s."slug")
  END
WHERE s."name" = 'config'
  AND s."slug" IS DISTINCT FROM 'config'
  AND NOT EXISTS (
    SELECT 1 FROM "v2"."spaces" AS o
    WHERE o."user_uuid" = s."user_uuid" AND o."slug" = 'config' AND o."id" <> s."id"
  );
