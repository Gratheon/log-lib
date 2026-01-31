-- Create the logs database
CREATE DATABASE IF NOT EXISTS `logs`;

-- Create the logs table within the 'logs' database
CREATE TABLE IF NOT EXISTS `logs`.`logs` (
    `id`        int auto_increment primary key,
    `level`     varchar(16)   not null,
    `message`   varchar(2048) not null,
    `meta`      varchar(2048) not null,
    `timestamp` datetime      not null
);
