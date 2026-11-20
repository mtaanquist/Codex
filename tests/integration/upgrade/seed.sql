-- Rows as the previous release (see previous-release.json) left them, in the
-- shapes that later versions have tripped over. Plain SQL against that
-- release's schema; refresh it with the release when a column it uses moves.

insert into users (id, email, display_name, password_hash, role) values
	('00000000-0000-4000-8000-0000000000a1', 'upgrade@example.com', 'Upgrader', 'x', 'user');

insert into universes (id, owner_id, name, deleted_at) values
	('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'Harbour', null),
	-- Trashed before the upgrade, restored after it.
	('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000a1', 'Old World', now() - interval '2 days');

insert into stories (id, universe_id, owner_id, title) values
	('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'The Long Tide'),
	('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000a1', 'Before');

insert into chapters (id, story_id, position, title) values
	('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', 1, 'Arrival');

-- A: CRLF line endings, from an archive import before the import fix, with a
-- summary the Assistant wrote while the text was current. B: the writer's own
-- summary (no stamp). C: no summary yet. D: in the trashed universe.
insert into scenes (id, story_id, chapter_id, position_in_chapter, global_position, title, body_md, word_count, summary_md, summary_generated_at, updated_at, mentions_indexed_at) values
	('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1', 1, 1, 'Quay', E'Mara reached the quay.\r\n\r\nThe tide was out.', 8, 'Mara arrives at low tide.', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day'),
	('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1', 2, 2, 'Sale', 'Mara sold the boat to Tam.', 6, 'My own summary.', null, now() - interval '1 day', now() - interval '1 day'),
	('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1', 3, 3, 'Wait', 'Nobody came.', 2, null, null, now() - interval '1 day', now() - interval '1 day'),
	('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000c2', null, null, 1, 'Long ago', 'An older story.', 3, null, null, now() - interval '3 days', now() - interval '3 days');

-- Mara: read and retold after the scenes last changed. Tam: read and retold
-- before the scene that mentions him last changed, so both were out of date
-- under this release's rule and must still be after the upgrade.
insert into characters (id, universe_id, owner_id, name, body_md, arc_summary_md, arc_summary_at, assistant_enriched_at) values
	('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'Mara', 'A sailor.', 'Mara gives up the sea.', now() - interval '1 hour', now() - interval '1 hour'),
	('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'Tam', 'A buyer.', 'Tam wants a boat.', now() - interval '5 days', now() - interval '5 days');

insert into entity_mentions (source_type, source_id, target_type, target_id, position, surrounding_text) values
	('scene', '00000000-0000-4000-8000-0000000000e1', 'character', '00000000-0000-4000-8000-0000000000f1', 0, 'Mara reached the quay.'),
	('scene', '00000000-0000-4000-8000-0000000000e2', 'character', '00000000-0000-4000-8000-0000000000f1', 0, 'Mara sold the boat.'),
	('scene', '00000000-0000-4000-8000-0000000000e2', 'character', '00000000-0000-4000-8000-0000000000f2', 22, 'Mara sold the boat to Tam.');

-- A whole-story review of prose and mechanics that hit the spend cap after two scenes, saved under
-- the scope key this release used.
insert into assistant_review_runs (job_id, user_id, state) values
	('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000a1', '{"phase":"scenes","scope":"full:00000000-0000-4000-8000-0000000000c1","total":3,"completed":["00000000-0000-4000-8000-0000000000e1","00000000-0000-4000-8000-0000000000e2"],"reviewed":2,"failed":0,"notes":4,"failures":[],"capped":true,"spentUsd":0.5}');
