ALTER TABLE "stories" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "universes" ADD COLUMN "slug" text;--> statement-breakpoint
WITH named AS (
	SELECT id, owner_id,
		COALESCE(NULLIF(btrim(left(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), 60), '-'), ''), 'universe') AS base
	FROM "universes"
), ranked AS (
	SELECT named.id, named.base,
		row_number() OVER (PARTITION BY named.owner_id, named.base ORDER BY u.created_at, named.id) AS rn
	FROM named JOIN "universes" u ON u.id = named.id
)
UPDATE "universes" u
SET slug = ranked.base || CASE WHEN ranked.rn > 1 THEN '-' || ranked.rn::text ELSE '' END
FROM ranked WHERE ranked.id = u.id;--> statement-breakpoint
WITH named AS (
	SELECT id, owner_id,
		COALESCE(NULLIF(btrim(left(regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g'), 60), '-'), ''), 'story') AS base
	FROM "stories"
), ranked AS (
	SELECT named.id, named.base,
		row_number() OVER (PARTITION BY named.owner_id, named.base ORDER BY s.created_at, named.id) AS rn
	FROM named JOIN "stories" s ON s.id = named.id
)
UPDATE "stories" s
SET slug = ranked.base || CASE WHEN ranked.rn > 1 THEN '-' || ranked.rn::text ELSE '' END
FROM ranked WHERE ranked.id = s.id;--> statement-breakpoint
WITH dup AS (
	SELECT id, row_number() OVER (PARTITION BY owner_id, slug ORDER BY created_at, id) AS rn
	FROM "universes"
)
UPDATE "universes" u SET slug = u.slug || '-' || left(u.id::text, 4)
FROM dup WHERE dup.id = u.id AND dup.rn > 1;--> statement-breakpoint
WITH dup AS (
	SELECT id, row_number() OVER (PARTITION BY owner_id, slug ORDER BY created_at, id) AS rn
	FROM "stories"
)
UPDATE "stories" s SET slug = s.slug || '-' || left(s.id::text, 4)
FROM dup WHERE dup.id = s.id AND dup.rn > 1;--> statement-breakpoint
ALTER TABLE "universes" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "universes" ALTER COLUMN "slug" SET DEFAULT substr(md5(random()::text), 1, 12);--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "slug" SET DEFAULT substr(md5(random()::text), 1, 12);--> statement-breakpoint
CREATE UNIQUE INDEX "stories_owner_slug_idx" ON "stories" USING btree ("owner_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "universes_owner_slug_idx" ON "universes" USING btree ("owner_id","slug");