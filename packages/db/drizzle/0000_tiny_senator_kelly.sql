CREATE TABLE `keywords` (
	`keyword_id` integer PRIMARY KEY NOT NULL,
	`keyword` text NOT NULL,
	`competition_index` integer,
	`competition` text,
	`avg_monthly_searches` integer,
	`last_synced` integer,
	`created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `keywords_keyword_unique` ON `keywords` (`keyword`);--> statement-breakpoint
CREATE TABLE `site_date_analytics` (
	`site_id` integer NOT NULL,
	`date` text NOT NULL,
	`clicks` integer DEFAULT 0,
	`impressions` integer DEFAULT 0,
	`ctr` integer DEFAULT 0,
	`position` integer DEFAULT 0,
	`mobile_clicks` integer,
	`mobile_impressions` integer,
	`desktop_clicks` integer,
	`desktop_impressions` integer,
	`tablet_clicks` integer,
	`tablet_impressions` integer,
	`keywords` integer,
	`pages` integer,
	`created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`site_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `site_date_analytics_date_idx` ON `site_date_analytics` (`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `site_date_analytics_site_id_date_unique` ON `site_date_analytics` (`site_id`,`date`);--> statement-breakpoint
CREATE TABLE `site_date_country_analytics` (
	`site_id` integer NOT NULL,
	`date` text NOT NULL,
	`country` text NOT NULL,
	`clicks` integer DEFAULT 0,
	`impressions` integer DEFAULT 0,
	`ctr` integer DEFAULT 0,
	`position` integer DEFAULT 0,
	`created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`site_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `site_date_country_analytics_date_idx` ON `site_date_country_analytics` (`date`);--> statement-breakpoint
CREATE INDEX `site_date_country_analytics_country_idx` ON `site_date_country_analytics` (`country`);--> statement-breakpoint
CREATE UNIQUE INDEX `site_date_country_analytics_site_id_date_country_unique` ON `site_date_country_analytics` (`site_id`,`date`,`country`);--> statement-breakpoint
CREATE TABLE `site_date_device_analytics` (
	`site_id` integer NOT NULL,
	`date` text NOT NULL,
	`device` text NOT NULL,
	`clicks` integer DEFAULT 0,
	`impressions` integer DEFAULT 0,
	`ctr` integer DEFAULT 0,
	`position` integer DEFAULT 0,
	`created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`site_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `site_date_device_analytics_date_idx` ON `site_date_device_analytics` (`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `site_date_device_analytics_site_id_date_device_unique` ON `site_date_device_analytics` (`site_id`,`date`,`device`);--> statement-breakpoint
CREATE TABLE `site_keyword_date_analytics` (
	`site_id` integer NOT NULL,
	`date` text NOT NULL,
	`keyword` text NOT NULL,
	`clicks` integer DEFAULT 0,
	`impressions` integer DEFAULT 0,
	`ctr` integer DEFAULT 0,
	`position` integer DEFAULT 0,
	`created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`site_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `site_keyword_date_analytics_date_idx` ON `site_keyword_date_analytics` (`date`);--> statement-breakpoint
CREATE INDEX `site_keyword_date_analytics_keyword_idx` ON `site_keyword_date_analytics` (`keyword`);--> statement-breakpoint
CREATE UNIQUE INDEX `site_keyword_date_analytics_site_id_date_keyword_unique` ON `site_keyword_date_analytics` (`site_id`,`date`,`keyword`);--> statement-breakpoint
CREATE TABLE `site_keyword_path_date_analytics` (
	`site_id` integer NOT NULL,
	`date` text NOT NULL,
	`keyword` text NOT NULL,
	`path` text NOT NULL,
	`clicks` integer DEFAULT 0,
	`impressions` integer DEFAULT 0,
	`ctr` integer DEFAULT 0,
	`position` integer DEFAULT 0,
	`created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`site_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `site_keyword_path_date_analytics_date_idx` ON `site_keyword_path_date_analytics` (`date`);--> statement-breakpoint
CREATE INDEX `site_keyword_path_date_analytics_keyword_idx` ON `site_keyword_path_date_analytics` (`keyword`);--> statement-breakpoint
CREATE INDEX `site_keyword_path_date_analytics_path_idx` ON `site_keyword_path_date_analytics` (`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `site_keyword_path_date_analytics_site_id_date_keyword_path_unique` ON `site_keyword_path_date_analytics` (`site_id`,`date`,`keyword`,`path`);--> statement-breakpoint
CREATE TABLE `site_path_date_analytics` (
	`site_id` integer NOT NULL,
	`date` text NOT NULL,
	`path` text NOT NULL,
	`clicks` integer DEFAULT 0,
	`impressions` integer DEFAULT 0,
	`ctr` integer DEFAULT 0,
	`position` integer DEFAULT 0,
	`created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`site_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `site_path_date_analytics_date_idx` ON `site_path_date_analytics` (`date`);--> statement-breakpoint
CREATE INDEX `site_path_date_analytics_path_idx` ON `site_path_date_analytics` (`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `site_path_date_analytics_site_id_date_path_unique` ON `site_path_date_analytics` (`site_id`,`date`,`path`);--> statement-breakpoint
CREATE TABLE `site_paths` (
	`site_id` integer NOT NULL,
	`path` text NOT NULL,
	`last_seen` integer,
	`created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`site_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `site_paths_path_idx` ON `site_paths` (`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `site_paths_site_id_path_unique` ON `site_paths` (`site_id`,`path`);--> statement-breakpoint
CREATE TABLE `sites` (
	`site_id` integer PRIMARY KEY NOT NULL,
	`property` text NOT NULL,
	`domain` text,
	`sitemaps` text,
	`last_synced` integer,
	`created_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sites_property_unique` ON `sites` (`property`);