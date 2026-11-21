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

-- Chapter summaries the Assistant wrote before this release stored a
-- fingerprint for them. Its upgrade (migration 0094) gave the ones that were
-- current a stand-in fingerprint of the chapter title and its scene summaries,
-- and left the out-of-date ones without one. Nets: current, still under its
-- stand-in. Storm: out of date.
insert into chapters (id, story_id, position, title, summary_md, summary_generated_at, summary_input, updated_at) values
	('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000c1', 2, 'Nets', 'The nets are mended.', now() - interval '2 days', 'at-upgrade:' || md5('Nets' || chr(31) || 'Nets dry on the wall.'), now() - interval '2 days'),
	('00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000c1', 3, 'Storm', 'A storm is coming.', now() - interval '2 days' - interval '1 millisecond', null, now() - interval '2 days');

-- A: CRLF line endings, from an archive import before the import fix, with a
-- summary the Assistant wrote while the text was current. B: the writer's own
-- summary (no stamp). C: no summary yet. D: in the trashed universe. E and F:
-- the scenes of the two chapters with summaries.
insert into scenes (id, story_id, chapter_id, position_in_chapter, global_position, title, body_md, word_count, summary_md, summary_generated_at, updated_at, mentions_indexed_at) values
	('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1', 1, 1, 'Quay', E'Mara reached the quay.\r\n\r\nThe tide was out.', 8, 'Mara arrives at low tide.', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day'),
	('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1', 2, 2, 'Sale', 'Mara sold the boat to Tam.', 6, 'My own summary.', null, now() - interval '1 day', now() - interval '1 day'),
	('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1', 3, 3, 'Wait', 'Nobody came.', 2, null, null, now() - interval '1 day', now() - interval '1 day'),
	('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000c2', null, null, 1, 'Long ago', 'An older story.', 3, null, null, now() - interval '3 days', now() - interval '3 days'),
	('00000000-0000-4000-8000-0000000000e5', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d2', 1, 4, 'Mending', 'The nets dried on the wall.', 6, 'Nets dry on the wall.', now() - interval '3 days', now() - interval '3 days', now() - interval '3 days'),
	('00000000-0000-4000-8000-0000000000e6', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d3', 1, 5, 'The mole', 'The storm broke the mole.', 5, 'My storm summary.', null, now() - interval '3 days', now() - interval '3 days');

-- What the Assistant read, as this release stored it: the time of the read
-- with a fingerprint of the request (the enrich one covers the entry's aliases
-- and details), and a time fifty years back once something the read drew on
-- had changed. The fingerprints are of the requests this release built from
-- the rows in this file.
-- Mara: arc and read both current. Tam: both out of date. The Quay: read by a
-- release from before fingerprints, and nothing that mentions it has changed.
-- Each arc lists the stories it read.
insert into characters (id, universe_id, owner_id, name, aliases, details, body_md, arc_summary_md, arc_summary_at, arc_summary_input, arc_summary_stories, assistant_enriched_at, assistant_enriched_input) values
	('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'Mara', '{"The Sailor"}', '[{"label":"Trade","value":"fishing"}]', 'A sailor.', 'Mara gives up the sea.', now() - interval '1 hour', 'c3ab852a2e2f47f1e103a4e98ccaa30dec3f43132e40cb695b5e5e52badd087c', '{00000000-0000-4000-8000-0000000000c1}', now() - interval '1 hour', 'd23cd1eaa1e9dc92f834b585d5466342ab5cd42858a91216aa94fdd73be27606'),
	('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'Tam', '{}', '[]', 'A buyer.', 'Tam wants a boat.', now() - interval '50 years', repeat('a', 64), '{00000000-0000-4000-8000-0000000000c1}', now() - interval '50 years', repeat('b', 64));

insert into places (id, universe_id, owner_id, name, assistant_enriched_at) values
	('00000000-0000-4000-8000-0000000000f3', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'The Quay', now() - interval '1 hour');

insert into entity_mentions (source_type, source_id, target_type, target_id, position, surrounding_text) values
	('scene', '00000000-0000-4000-8000-0000000000e1', 'character', '00000000-0000-4000-8000-0000000000f1', 0, 'Mara reached the quay.'),
	('scene', '00000000-0000-4000-8000-0000000000e2', 'character', '00000000-0000-4000-8000-0000000000f1', 0, 'Mara sold the boat.'),
	('scene', '00000000-0000-4000-8000-0000000000e2', 'character', '00000000-0000-4000-8000-0000000000f2', 22, 'Mara sold the boat to Tam.'),
	('scene', '00000000-0000-4000-8000-0000000000e1', 'place', '00000000-0000-4000-8000-0000000000f3', 17, 'Mara reached the quay.');

-- A whole-story review of prose and mechanics that hit the spend cap after two scenes, saved under
-- the scope key from before the categories were part of it and not continued since.
insert into assistant_review_runs (job_id, user_id, state) values
	('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000a1', '{"phase":"scenes","scope":"full:00000000-0000-4000-8000-0000000000c1","total":3,"completed":["00000000-0000-4000-8000-0000000000e1","00000000-0000-4000-8000-0000000000e2"],"reviewed":2,"failed":0,"notes":4,"failures":[],"capped":true,"spentUsd":0.5}');
