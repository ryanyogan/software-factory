ALTER TABLE `runs` ADD `prompt` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `open_pr` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `claimed_by` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `claimed_at` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `pr_url` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `cost_usd` real;--> statement-breakpoint
ALTER TABLE `runs` ADD `ended_at` integer;