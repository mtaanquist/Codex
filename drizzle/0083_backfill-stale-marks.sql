-- One-off backfill for the move from watermark staleness to marks (0082).
-- Before it, an arc or an entity read was out of date when a live scene that
-- mentions it changed after its watermark; now only a mark (a watermark before
-- 2000) says so. These statements mark what the old rule found stale, so the
-- re-reads pending at upgrade are not dropped. The conditions mirror the old
-- queries (arcIsStale in arc-summary.ts, entitiesToEnrich in enrich.ts); the
-- mark has the same form as markStale in scene-lifecycle.ts.
UPDATE "characters" c SET "arc_summary_at" = clock_timestamp() - interval '50 years'
WHERE c."arc_summary_at" >= '2000-01-01T00:00:00Z'
	AND EXISTS (
		SELECT 1 FROM "entity_mentions" m
		JOIN "scenes" s ON s."id" = m."source_id"
		JOIN "stories" st ON st."id" = s."story_id"
		WHERE m."source_type" = 'scene' AND m."target_type" = 'character' AND m."target_id" = c."id"
			AND st."universe_id" = c."universe_id"
			AND st."deleted_at" IS NULL AND s."deleted_at" IS NULL
			AND NOT (st."llm_config" @> '{"enabled": false}'::jsonb)
			-- The old check compared in JavaScript, at millisecond precision.
			AND date_trunc('milliseconds', s."updated_at") > c."arc_summary_at"
	);--> statement-breakpoint
UPDATE "characters" e SET "assistant_enriched_at" = clock_timestamp() - interval '50 years'
WHERE e."assistant_enriched_at" >= '2000-01-01T00:00:00Z'
	AND EXISTS (SELECT 1 FROM "universes" u WHERE u."id" = e."universe_id" AND u."deleted_at" IS NULL)
	AND EXISTS (
		SELECT 1 FROM "entity_mentions" m
		JOIN "scenes" s ON s."id" = m."source_id"
		JOIN "stories" st ON st."id" = s."story_id"
		WHERE m."source_type" = 'scene' AND m."target_type" = 'character' AND m."target_id" = e."id"
			AND st."universe_id" = e."universe_id"
			AND st."deleted_at" IS NULL AND s."deleted_at" IS NULL
			AND NOT (st."llm_config" @> '{"enabled": false}'::jsonb)
			AND s."updated_at" > e."assistant_enriched_at"
	);--> statement-breakpoint
UPDATE "places" e SET "assistant_enriched_at" = clock_timestamp() - interval '50 years'
WHERE e."assistant_enriched_at" >= '2000-01-01T00:00:00Z'
	AND EXISTS (SELECT 1 FROM "universes" u WHERE u."id" = e."universe_id" AND u."deleted_at" IS NULL)
	AND EXISTS (
		SELECT 1 FROM "entity_mentions" m
		JOIN "scenes" s ON s."id" = m."source_id"
		JOIN "stories" st ON st."id" = s."story_id"
		WHERE m."source_type" = 'scene' AND m."target_type" = 'place' AND m."target_id" = e."id"
			AND st."universe_id" = e."universe_id"
			AND st."deleted_at" IS NULL AND s."deleted_at" IS NULL
			AND NOT (st."llm_config" @> '{"enabled": false}'::jsonb)
			AND s."updated_at" > e."assistant_enriched_at"
	);--> statement-breakpoint
UPDATE "lore_entries" e SET "assistant_enriched_at" = clock_timestamp() - interval '50 years'
WHERE e."assistant_enriched_at" >= '2000-01-01T00:00:00Z'
	AND EXISTS (SELECT 1 FROM "universes" u WHERE u."id" = e."universe_id" AND u."deleted_at" IS NULL)
	AND EXISTS (
		SELECT 1 FROM "entity_mentions" m
		JOIN "scenes" s ON s."id" = m."source_id"
		JOIN "stories" st ON st."id" = s."story_id"
		WHERE m."source_type" = 'scene' AND m."target_type" = 'lore_entry' AND m."target_id" = e."id"
			AND st."universe_id" = e."universe_id"
			AND st."deleted_at" IS NULL AND s."deleted_at" IS NULL
			AND NOT (st."llm_config" @> '{"enabled": false}'::jsonb)
			AND s."updated_at" > e."assistant_enriched_at"
	);
