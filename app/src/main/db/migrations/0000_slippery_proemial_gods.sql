CREATE TABLE `change_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`source` text DEFAULT 'ai' NOT NULL,
	`source_command` text,
	`status` text NOT NULL,
	`changes` text,
	`changes_path` text,
	`remote_id` text,
	`etag` text,
	`sync_state` text DEFAULT 'local',
	`updated_by` text,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_change_sets_file_status` ON `change_sets` (`file_id`,`status`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`path` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`page_count` integer,
	`sheet_count` integer,
	`tags` text,
	`thumbnail` text,
	`current_version_id` text,
	`content_hash` text,
	`imported_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`modified_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`remote_id` text,
	`etag` text,
	`sync_state` text DEFAULT 'local',
	`updated_by` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_files_workspace_type` ON `files` (`workspace_id`,`type`);--> statement-breakpoint
CREATE TABLE `knowledge_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_file_id` text,
	`source_version_id` text,
	`category` text NOT NULL,
	`entry_type` text NOT NULL,
	`title` text NOT NULL,
	`content` text,
	`payload` text,
	`tags` text,
	`ref_count` integer DEFAULT 0 NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'suggested' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_knowledge_workspace_category` ON `knowledge_entries` (`workspace_id`,`category`,`entry_type`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text,
	`tool_calls` text,
	`change_set_id` text,
	`result_cards` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_messages_conversation` ON `messages` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `model_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`protocol` text NOT NULL,
	`base_url` text,
	`model` text NOT NULL,
	`api_key_ref` text,
	`is_default` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`call_count` integer DEFAULT 0 NOT NULL,
	`cost` integer DEFAULT 0 NOT NULL,
	`timestamp` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `model_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`rule` text NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`weight` integer DEFAULT 0 NOT NULL,
	`editable` integer DEFAULT true NOT NULL,
	`deletable` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`seq` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`trigger_command` text,
	`author` text,
	`change_summary` text,
	`storage_type` text NOT NULL,
	`snapshot_path` text,
	`change_set_id` text,
	`parent_version_id` text,
	`remote_id` text,
	`etag` text,
	`sync_state` text DEFAULT 'local',
	`updated_by` text,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_versions_file_seq` ON `versions` (`file_id`,`seq`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`settings` text
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `fts_files` USING fts5(
	file_id UNINDEXED,
	content,
	metadata,
	tokenize = 'trigram'
);
