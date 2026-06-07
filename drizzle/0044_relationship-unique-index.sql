-- Before the unique index can stand, remove any duplicate universe-wide
-- relationships the old check-then-insert race may have left: keep one row per
-- (relation_type_id, from_id, to_id) where story_id is null, dropping the rest.
DELETE FROM "entity_relationships" a
USING "entity_relationships" b
WHERE a.story_id IS NULL
	AND b.story_id IS NULL
	AND a.relation_type_id = b.relation_type_id
	AND a.from_id = b.from_id
	AND a.to_id = b.to_id
	AND a.ctid > b.ctid;
--> statement-breakpoint
CREATE UNIQUE INDEX "entity_relationships_universe_unique" ON "entity_relationships" USING btree ("relation_type_id","from_id","to_id") WHERE "entity_relationships"."story_id" is null;
