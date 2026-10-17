-- Hand-edited: drizzle-kit's table rebuild would DROP `projects`, and on D1 (foreign keys always on,
-- `PRAGMA foreign_keys=OFF` ignored) that cascades and deletes every task and run. Swap the column instead.
ALTER TABLE `projects` ADD `repo_url_new` text;--> statement-breakpoint
UPDATE `projects` SET `repo_url_new` = `repo_url`;--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `repo_url`;--> statement-breakpoint
ALTER TABLE `projects` RENAME COLUMN `repo_url_new` TO `repo_url`;
