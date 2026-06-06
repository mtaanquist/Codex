-- suspended_at now means admin suspension only; a pending self-deletion
-- blocks sign-in through deletion_scheduled_at itself. Accounts mid-deletion
-- under the old code had suspended_at set by the scheduling write; clear it
-- so a later cancellation does not leave them wrongly suspended.
UPDATE "users" SET "suspended_at" = NULL WHERE "deletion_scheduled_at" IS NOT NULL;
