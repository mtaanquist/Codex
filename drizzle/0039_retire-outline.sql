DROP TABLE "outline_nodes" CASCADE;--> statement-breakpoint
DELETE FROM "revisions" WHERE "entity_type" = 'outline_node';
