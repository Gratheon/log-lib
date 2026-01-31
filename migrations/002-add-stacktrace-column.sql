-- Add stacktrace column to existing logs table
ALTER TABLE `logs`.`logs` ADD COLUMN `stacktrace` TEXT AFTER `meta`;
