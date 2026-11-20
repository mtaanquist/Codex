-- One-off: keep the chapter summaries the Assistant wrote before fingerprints
-- were stored (0092), so the first summaries pass after the upgrade does not
-- pay to write each of them again. A chapter the previous rule counted as
-- current (summary_generated_at at or after updated_at) is given a stand-in
-- fingerprint of what its summary reads as things stand: its title and the
-- usable summaries of its live scenes in order. The app works out the same
-- value (chapterInputAtUpgrade in chapter-summary-request.ts) and reads the
-- summary as current while they match, so any later change puts it out of
-- date as usual. Left alone, and so rewritten once: a chapter the previous
-- rule counted as out of date, and one with a scene whose own summary is out
-- of date, since the chapter summary was written from that older text.
-- Only this derived column is written.
UPDATE "chapters" c SET "summary_input" = 'at-upgrade:' || md5(
	coalesce(c."title", '') || chr(31) || coalesce((
		SELECT string_agg(s."summary_md", chr(31) ORDER BY s."global_position")
		FROM "scenes" s
		WHERE s."chapter_id" = c."id" AND s."deleted_at" IS NULL AND s."summary_md" ~ '\S'
	), '')
)
WHERE c."summary_input" IS NULL
	AND c."summary_md" IS NOT NULL
	AND c."summary_generated_at" IS NOT NULL
	AND date_trunc('milliseconds', c."summary_generated_at") >= date_trunc('milliseconds', c."updated_at")
	AND NOT EXISTS (
		SELECT 1 FROM "scenes" s
		WHERE s."chapter_id" = c."id" AND s."deleted_at" IS NULL
			AND s."summary_generated_at" IS NOT NULL
			AND date_trunc('milliseconds', s."summary_generated_at") < date_trunc('milliseconds', s."updated_at")
	);
