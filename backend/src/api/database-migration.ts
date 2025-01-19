import config from '../config';
import DB from '../database';
import logger from '../logger';
import { Common } from './common';
import blocksRepository from '../repositories/BlocksRepository';
import cpfpRepository from '../repositories/CpfpRepository';
import { RowDataPacket } from 'mysql2';

class DatabaseMigration {
  private static currentVersion = 95;
  private queryTimeout = 3600_000;
  private statisticsAddedIndexed = false;
  private uniqueLogs: string[] = [];

  private blocksTruncatedMessage = `'blocks' table has been truncated.`;
  private hashratesTruncatedMessage = `'hashrates' table has been truncated.`;

  /**
   * Avoid printing multiple time the same message
   */
  private uniqueLog(loggerFunction: any, msg: string) {
    if (this.uniqueLogs.includes(msg)) {
      return;
    }
    this.uniqueLogs.push(msg);
    loggerFunction(msg);
  }

  /**
   * Entry point
   */
  public async $initializeOrMigrateDatabase(): Promise<void> {
    logger.debug('MIGRATIONS: Running migrations');

    await this.$printDatabaseVersion();

    // First of all, if the `state` database does not exist, create it so we can track migration version
    if (!await this.$checkIfTableExists('state')) {
      logger.debug('MIGRATIONS: `state` table does not exist. Creating it.');
      try {
        await this.$createMigrationStateTable();
      } catch (e) {
        logger.err('MIGRATIONS: Unable to create `state` table, aborting in 10 seconds. ' + e);
        await Common.sleep$(10000);
        process.exit(-1);
      }
      logger.debug('MIGRATIONS: `state` table initialized.');
    }

    let databaseSchemaVersion = 0;
    try {
      databaseSchemaVersion = await this.$getSchemaVersionFromDatabase();
    } catch (e) {
      logger.err('MIGRATIONS: Unable to get current database migration version, aborting in 10 seconds. ' + e);
      await Common.sleep$(10000);
      process.exit(-1);
    }

    if (databaseSchemaVersion === 0) {
      logger.info('Initializing database (first run, clean install)');
    }

    if (databaseSchemaVersion <= 2) {
      // Disable some spam logs when they're not relevant
      this.uniqueLog(logger.notice, this.blocksTruncatedMessage);
      this.uniqueLog(logger.notice, this.hashratesTruncatedMessage);
    }

    logger.debug('MIGRATIONS: Current state.schema_version ' + databaseSchemaVersion);
    logger.debug('MIGRATIONS: Latest DatabaseMigration.version is ' + DatabaseMigration.currentVersion);
    if (databaseSchemaVersion >= DatabaseMigration.currentVersion) {
      logger.debug('MIGRATIONS: Nothing to do.');
      return;
    }

    // Now, create missing tables. Those queries cannot be wrapped into a transaction unfortunately
    try {
      await this.$createMissingTablesAndIndexes(databaseSchemaVersion);
    } catch (e) {
      logger.err('MIGRATIONS: Unable to create required tables, aborting in 10 seconds. ' + e);
      await Common.sleep$(10000);
      process.exit(-1);
    }

    if (DatabaseMigration.currentVersion > databaseSchemaVersion) {
      try {
        await this.$migrateTableSchemaFromVersion(databaseSchemaVersion);
        if (databaseSchemaVersion === 0) {
          logger.notice(`MIGRATIONS: OK. Database schema has been properly initialized to version ${DatabaseMigration.currentVersion} (latest version)`);
        } else {
          logger.notice(`MIGRATIONS: OK. Database schema have been migrated from version ${databaseSchemaVersion} to ${DatabaseMigration.currentVersion} (latest version)`);
        }
      } catch (e) {
        logger.err('MIGRATIONS: Unable to migrate database, aborting. ' + e);
      }
    }

    return;
  }

  /**
   * Create all missing tables
   */
  private async $createMissingTablesAndIndexes(databaseSchemaVersion: number) {
    await this.$setStatisticsAddedIndexedFlag(databaseSchemaVersion);

    const isBitcoin = ['mainnet', 'testnet', 'signet'].includes(config.MEMPOOL.NETWORK);

    await this.$executeQuery(this.getCreateElementsTableQuery(), await this.$checkIfTableExists('elements_pegs'));
    await this.$executeQuery(this.getCreateStatisticsQuery(), await this.$checkIfTableExists('statistics'));
    if (databaseSchemaVersion < 2 && this.statisticsAddedIndexed === false) {
      await this.$executeQuery(`CREATE INDEX added ON statistics (added);`);
      await this.updateToSchemaVersion(2);
    }
    if (databaseSchemaVersion < 3) {
      await this.$executeQuery(this.getCreatePoolsTableQuery(), await this.$checkIfTableExists('pools'));
      await this.updateToSchemaVersion(3);
    }
    if (databaseSchemaVersion < 4) {
      await this.$executeQuery('DROP table IF EXISTS blocks;');
      await this.$executeQuery(this.getCreateBlocksTableQuery(), await this.$checkIfTableExists('blocks'));
      await this.updateToSchemaVersion(4);
    }
    if (databaseSchemaVersion < 5 && isBitcoin === true) {
      this.uniqueLog(logger.notice, this.blocksTruncatedMessage);
      await this.$executeQuery('TRUNCATE blocks;'); // Need to re-index
      await this.$executeQuery('ALTER TABLE blocks ADD `reward` double unsigned NOT NULL DEFAULT "0"');
      await this.updateToSchemaVersion(5);
    }

    if (databaseSchemaVersion < 6 && isBitcoin === true) {
      this.uniqueLog(logger.notice, this.blocksTruncatedMessage);
      await this.$executeQuery('TRUNCATE blocks;');  // Need to re-index
      // Cleanup original blocks fields type
      await this.$executeQuery('ALTER TABLE blocks MODIFY `height` integer unsigned NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE blocks MODIFY `tx_count` smallint unsigned NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE blocks MODIFY `size` integer unsigned NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE blocks MODIFY `weight` integer unsigned NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE blocks MODIFY `difficulty` double NOT NULL DEFAULT "0"');
      // We also fix the pools.id type so we need to drop/re-create the foreign key
      await this.$executeQuery('ALTER TABLE blocks DROP FOREIGN KEY IF EXISTS `blocks_ibfk_1`');
      await this.$executeQuery('ALTER TABLE pools MODIFY `id` smallint unsigned AUTO_INCREMENT');
      await this.$executeQuery('ALTER TABLE blocks MODIFY `pool_id` smallint unsigned NULL');
      await this.$executeQuery('ALTER TABLE blocks ADD FOREIGN KEY (`pool_id`) REFERENCES `pools` (`id`)');
      // Add new block indexing fields
      await this.$executeQuery('ALTER TABLE blocks ADD `version` integer unsigned NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE blocks ADD `bits` integer unsigned NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE blocks ADD `nonce` bigint unsigned NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE blocks ADD `merkle_root` varchar(65) NOT NULL DEFAULT ""');
      await this.$executeQuery('ALTER TABLE blocks ADD `previous_block_hash` varchar(65) NULL');
      await this.updateToSchemaVersion(6);
    }

    if (databaseSchemaVersion < 7 && isBitcoin === true) {
      await this.$executeQuery('DROP table IF EXISTS hashrates;');
      await this.$executeQuery(this.getCreateDailyStatsTableQuery(), await this.$checkIfTableExists('hashrates'));
      await this.updateToSchemaVersion(7);
    }

    if (databaseSchemaVersion < 8 && isBitcoin === true) {
      this.uniqueLog(logger.notice, this.blocksTruncatedMessage);
      await this.$executeQuery('TRUNCATE hashrates;'); // Need to re-index
      await this.$executeQuery('ALTER TABLE `hashrates` DROP INDEX `PRIMARY`');
      await this.$executeQuery('ALTER TABLE `hashrates` ADD `id` int NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST');
      await this.$executeQuery('ALTER TABLE `hashrates` ADD `share` float NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `hashrates` ADD `type` enum("daily", "weekly") DEFAULT "daily"');
      await this.updateToSchemaVersion(8);
    }

    if (databaseSchemaVersion < 9 && isBitcoin === true) {
      this.uniqueLog(logger.notice, this.hashratesTruncatedMessage);
      await this.$executeQuery('TRUNCATE hashrates;'); // Need to re-index
      await this.$executeQuery('ALTER TABLE `state` CHANGE `name` `name` varchar(100)');
      await this.$executeQuery('ALTER TABLE `hashrates` ADD UNIQUE `hashrate_timestamp_pool_id` (`hashrate_timestamp`, `pool_id`)');
      await this.updateToSchemaVersion(9);
    }

    if (databaseSchemaVersion < 10 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `blocks` ADD INDEX `blockTimestamp` (`blockTimestamp`)');
      await this.updateToSchemaVersion(10);
    }

    if (databaseSchemaVersion < 11 && isBitcoin === true) {
      this.uniqueLog(logger.notice, this.blocksTruncatedMessage);
      await this.$executeQuery('TRUNCATE blocks;'); // Need to re-index
      await this.$executeQuery(`ALTER TABLE blocks
        ADD avg_fee INT UNSIGNED NULL,
        ADD avg_fee_rate INT UNSIGNED NULL
      `);
      await this.$executeQuery('ALTER TABLE blocks MODIFY `reward` BIGINT UNSIGNED NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE blocks MODIFY `median_fee` INT UNSIGNED NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE blocks MODIFY `fees` INT UNSIGNED NOT NULL DEFAULT "0"');
      await this.updateToSchemaVersion(11);
    }

    if (databaseSchemaVersion < 12 && isBitcoin === true) {
      // No need to re-index because the new data type can contain larger values
      await this.$executeQuery('ALTER TABLE blocks MODIFY `fees` BIGINT UNSIGNED NOT NULL DEFAULT "0"');
      await this.updateToSchemaVersion(12);
    }

    if (databaseSchemaVersion < 13 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE blocks MODIFY `difficulty` DOUBLE UNSIGNED NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE blocks MODIFY `median_fee` BIGINT UNSIGNED NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE blocks MODIFY `avg_fee` BIGINT UNSIGNED NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE blocks MODIFY `avg_fee_rate` BIGINT UNSIGNED NOT NULL DEFAULT "0"');
      await this.updateToSchemaVersion(13);
    }

    if (databaseSchemaVersion < 14 && isBitcoin === true) {
      this.uniqueLog(logger.notice, this.hashratesTruncatedMessage);
      await this.$executeQuery('TRUNCATE hashrates;'); // Need to re-index
      await this.$executeQuery('ALTER TABLE `hashrates` DROP FOREIGN KEY `hashrates_ibfk_1`');
      await this.$executeQuery('ALTER TABLE `hashrates` MODIFY `pool_id` SMALLINT UNSIGNED NOT NULL DEFAULT "0"');
      await this.updateToSchemaVersion(14);
    }

    if (databaseSchemaVersion < 16 && isBitcoin === true) {
      this.uniqueLog(logger.notice, this.hashratesTruncatedMessage);
      await this.$executeQuery('TRUNCATE hashrates;'); // Need to re-index because we changed timestamps
      await this.updateToSchemaVersion(16);
    }

    if (databaseSchemaVersion < 17 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `pools` ADD `slug` CHAR(50) NULL');
      await this.updateToSchemaVersion(17);
    }

    if (databaseSchemaVersion < 18 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `blocks` ADD INDEX `hash` (`hash`);');
      await this.updateToSchemaVersion(18);
    }

    if (databaseSchemaVersion < 19) {
      await this.$executeQuery(this.getCreateRatesTableQuery(), await this.$checkIfTableExists('rates'));
      await this.updateToSchemaVersion(19);
    }

    if (databaseSchemaVersion < 20 && isBitcoin === true) {
      await this.$executeQuery(this.getCreateBlocksSummariesTableQuery(), await this.$checkIfTableExists('blocks_summaries'));
      await this.updateToSchemaVersion(20);
    }

    if (databaseSchemaVersion < 21) {
      await this.$executeQuery('DROP TABLE IF EXISTS `rates`');
      await this.$executeQuery(this.getCreatePricesTableQuery(), await this.$checkIfTableExists('prices'));
      await this.updateToSchemaVersion(21);
    }

    if (databaseSchemaVersion < 22 && isBitcoin === true) {
      await this.$executeQuery('DROP TABLE IF EXISTS `difficulty_adjustments`');
      await this.$executeQuery(this.getCreateDifficultyAdjustmentsTableQuery(), await this.$checkIfTableExists('difficulty_adjustments'));
      await this.updateToSchemaVersion(22);
    }

    if (databaseSchemaVersion < 23) {
      await this.$executeQuery('TRUNCATE `prices`');
      await this.$executeQuery('ALTER TABLE `prices` DROP `avg_prices`');
      await this.$executeQuery('ALTER TABLE `prices` ADD `USD` float DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `EUR` float DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `GBP` float DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `CAD` float DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `CHF` float DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `AUD` float DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `JPY` float DEFAULT "0"');
      await this.updateToSchemaVersion(23);
    }

    if (databaseSchemaVersion < 24 && isBitcoin == true) {
      await this.$executeQuery('DROP TABLE IF EXISTS `blocks_audits`');
      await this.$executeQuery(this.getCreateBlocksAuditsTableQuery(), await this.$checkIfTableExists('blocks_audits'));
      await this.updateToSchemaVersion(24);
    }

    if (databaseSchemaVersion < 25 && isBitcoin === true) {
      await this.$executeQuery(this.getCreateLightningStatisticsQuery(), await this.$checkIfTableExists('lightning_stats'));
      await this.$executeQuery(this.getCreateNodesQuery(), await this.$checkIfTableExists('nodes'));
      await this.$executeQuery(this.getCreateChannelsQuery(), await this.$checkIfTableExists('channels'));
      await this.$executeQuery(this.getCreateNodesStatsQuery(), await this.$checkIfTableExists('node_stats'));
      await this.updateToSchemaVersion(25);
    }

    if (databaseSchemaVersion < 26 && isBitcoin === true) {
      if (config.LIGHTNING.ENABLED) {
        this.uniqueLog(logger.notice, `'lightning_stats' table has been truncated.`);
      }
      await this.$executeQuery(`TRUNCATE lightning_stats`);
      await this.$executeQuery('ALTER TABLE `lightning_stats` ADD tor_nodes int(11) NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `lightning_stats` ADD clearnet_nodes int(11) NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `lightning_stats` ADD unannounced_nodes int(11) NOT NULL DEFAULT "0"');
      await this.updateToSchemaVersion(26);
    }

    if (databaseSchemaVersion < 27 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `lightning_stats` ADD avg_capacity bigint(20) unsigned NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `lightning_stats` ADD avg_fee_rate int(11) unsigned NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `lightning_stats` ADD avg_base_fee_mtokens bigint(20) unsigned NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `lightning_stats` ADD med_capacity bigint(20) unsigned NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `lightning_stats` ADD med_fee_rate int(11) unsigned NOT NULL DEFAULT "0"');
      await this.$executeQuery('ALTER TABLE `lightning_stats` ADD med_base_fee_mtokens bigint(20) unsigned NOT NULL DEFAULT "0"');
      await this.updateToSchemaVersion(27);
    }

    if (databaseSchemaVersion < 28 && isBitcoin === true) {
      if (config.LIGHTNING.ENABLED) {
        this.uniqueLog(logger.notice, `'lightning_stats' and 'node_stats' tables have been truncated.`);
      }
      await this.$executeQuery(`TRUNCATE lightning_stats`);
      await this.$executeQuery(`TRUNCATE node_stats`);
      await this.$executeQuery(`ALTER TABLE lightning_stats MODIFY added DATE`);
      await this.updateToSchemaVersion(28);
    }

    if (databaseSchemaVersion < 29 && isBitcoin === true) {
      await this.$executeQuery(this.getCreateGeoNamesTableQuery(), await this.$checkIfTableExists('geo_names'));
      await this.$executeQuery('ALTER TABLE `nodes` ADD as_number int(11) unsigned NULL DEFAULT NULL');
      await this.$executeQuery('ALTER TABLE `nodes` ADD city_id int(11) unsigned NULL DEFAULT NULL');
      await this.$executeQuery('ALTER TABLE `nodes` ADD country_id int(11) unsigned NULL DEFAULT NULL');
      await this.$executeQuery('ALTER TABLE `nodes` ADD accuracy_radius int(11) unsigned NULL DEFAULT NULL');
      await this.$executeQuery('ALTER TABLE `nodes` ADD subdivision_id int(11) unsigned NULL DEFAULT NULL');
      await this.$executeQuery('ALTER TABLE `nodes` ADD longitude double NULL DEFAULT NULL');
      await this.$executeQuery('ALTER TABLE `nodes` ADD latitude double NULL DEFAULT NULL');
      await this.updateToSchemaVersion(29);
    }

    if (databaseSchemaVersion < 30 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `geo_names` CHANGE `type` `type` enum("city","country","division","continent","as_organization") NOT NULL');
      await this.updateToSchemaVersion(30);
    }

    if (databaseSchemaVersion < 31 && isBitcoin == true) { // Link blocks to prices
      await this.$executeQuery('ALTER TABLE `prices` ADD `id` int NULL AUTO_INCREMENT UNIQUE');
      await this.$executeQuery('DROP TABLE IF EXISTS `blocks_prices`');
      await this.$executeQuery(this.getCreateBlocksPricesTableQuery(), await this.$checkIfTableExists('blocks_prices'));
      await this.updateToSchemaVersion(31);
    }

    if (databaseSchemaVersion < 32 && isBitcoin == true) {
      await this.$executeQuery('ALTER TABLE `blocks_summaries` ADD `template` JSON DEFAULT "[]"');
      await this.updateToSchemaVersion(32);
    }

    if (databaseSchemaVersion < 33 && isBitcoin == true) {
      await this.$executeQuery('ALTER TABLE `geo_names` CHANGE `type` `type` enum("city","country","division","continent","as_organization", "country_iso_code") NOT NULL');
      await this.updateToSchemaVersion(33);
    }

    if (databaseSchemaVersion < 34 && isBitcoin == true) {
      await this.$executeQuery('ALTER TABLE `lightning_stats` ADD clearnet_tor_nodes int(11) NOT NULL DEFAULT "0"');
      await this.updateToSchemaVersion(34);
    }

    if (databaseSchemaVersion < 35 && isBitcoin == true) {
      await this.$executeQuery('DELETE from `lightning_stats` WHERE added > "2021-09-19"');
      await this.$executeQuery('ALTER TABLE `lightning_stats` ADD CONSTRAINT added_unique UNIQUE (added);');
      await this.updateToSchemaVersion(35);
    }

    if (databaseSchemaVersion < 36 && isBitcoin == true) {
      await this.$executeQuery('ALTER TABLE `nodes` ADD status TINYINT NOT NULL DEFAULT "1"');
      await this.updateToSchemaVersion(36);
    }

    if (databaseSchemaVersion < 37 && isBitcoin == true) {
      await this.$executeQuery(this.getCreateLNNodesSocketsTableQuery(), await this.$checkIfTableExists('nodes_sockets'));
      await this.updateToSchemaVersion(37);
    }

    if (databaseSchemaVersion < 38 && isBitcoin == true) {
      if (config.LIGHTNING.ENABLED) {
        this.uniqueLog(logger.notice, `'lightning_stats' and 'node_stats' tables have been truncated.`);
      }
      await this.$executeQuery(`TRUNCATE lightning_stats`);
      await this.$executeQuery(`TRUNCATE node_stats`);
      await this.$executeQuery('ALTER TABLE `lightning_stats` CHANGE `added` `added` timestamp NULL');
      await this.$executeQuery('ALTER TABLE `node_stats` CHANGE `added` `added` timestamp NULL');
      await this.updateToSchemaVersion(38);
    }

    if (databaseSchemaVersion < 39 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `nodes` ADD alias_search TEXT NULL DEFAULT NULL AFTER `alias`');
      await this.$executeQuery('ALTER TABLE nodes ADD FULLTEXT(alias_search)');
      await this.updateToSchemaVersion(39);
    }

    if (databaseSchemaVersion < 40 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `nodes` ADD capacity bigint(20) unsigned DEFAULT NULL');
      await this.$executeQuery('ALTER TABLE `nodes` ADD channels int(11) unsigned DEFAULT NULL');
      await this.$executeQuery('ALTER TABLE `nodes` ADD INDEX `capacity` (`capacity`);');
      await this.updateToSchemaVersion(40);
    }

    if (databaseSchemaVersion < 41 && isBitcoin === true) {
      await this.$executeQuery('UPDATE channels SET closing_reason = NULL WHERE closing_reason = 1');
      await this.updateToSchemaVersion(41);
    }

    if (databaseSchemaVersion < 42 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `channels` ADD closing_resolved tinyint(1) DEFAULT 0');
      await this.updateToSchemaVersion(42);
    }

    if (databaseSchemaVersion < 43 && isBitcoin === true) {
      await this.$executeQuery(this.getCreateLNNodeRecordsTableQuery(), await this.$checkIfTableExists('nodes_records'));
      await this.updateToSchemaVersion(43);
    }

    if (databaseSchemaVersion < 44 && isBitcoin === true) {
      await this.$executeQuery('UPDATE blocks_summaries SET template = NULL');
      await this.updateToSchemaVersion(44);
    }

    if (databaseSchemaVersion < 45 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `blocks_audits` ADD fresh_txs JSON DEFAULT "[]"');
      await this.updateToSchemaVersion(45);
    }

    if (databaseSchemaVersion < 46) {
      await this.$executeQuery(`ALTER TABLE blocks MODIFY blockTimestamp timestamp NOT NULL DEFAULT 0`);
      await this.updateToSchemaVersion(46);
    }

    if (databaseSchemaVersion < 47) {
      await this.$executeQuery('ALTER TABLE `blocks` ADD cpfp_indexed tinyint(1) DEFAULT 0');
      await this.$executeQuery(this.getCreateCPFPTableQuery(), await this.$checkIfTableExists('cpfp_clusters'));
      await this.$executeQuery(this.getCreateTransactionsTableQuery(), await this.$checkIfTableExists('transactions'));
      await this.updateToSchemaVersion(47);
    }

    if (databaseSchemaVersion < 48 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `channels` ADD source_checked tinyint(1) DEFAULT 0');
      await this.$executeQuery('ALTER TABLE `channels` ADD closing_fee bigint(20) unsigned DEFAULT 0');
      await this.$executeQuery('ALTER TABLE `channels` ADD node1_funding_balance bigint(20) unsigned DEFAULT 0');
      await this.$executeQuery('ALTER TABLE `channels` ADD node2_funding_balance bigint(20) unsigned DEFAULT 0');
      await this.$executeQuery('ALTER TABLE `channels` ADD node1_closing_balance bigint(20) unsigned DEFAULT 0');
      await this.$executeQuery('ALTER TABLE `channels` ADD node2_closing_balance bigint(20) unsigned DEFAULT 0');
      await this.$executeQuery('ALTER TABLE `channels` ADD funding_ratio float unsigned DEFAULT NULL');
      await this.$executeQuery('ALTER TABLE `channels` ADD closed_by varchar(66) DEFAULT NULL');
      await this.$executeQuery('ALTER TABLE `channels` ADD single_funded tinyint(1) DEFAULT 0');
      await this.$executeQuery('ALTER TABLE `channels` ADD outputs JSON DEFAULT "[]"');
      await this.updateToSchemaVersion(48);
    }

    if (databaseSchemaVersion < 49 && isBitcoin === true) {
      await this.$executeQuery('TRUNCATE TABLE `blocks_audits`');
      await this.updateToSchemaVersion(49);
    }

    if (databaseSchemaVersion < 50) {
      await this.$executeQuery('ALTER TABLE `blocks` DROP COLUMN `cpfp_indexed`');
      await this.updateToSchemaVersion(50);
    }

    if (databaseSchemaVersion < 51) {
      await this.$executeQuery('ALTER TABLE `cpfp_clusters` ADD INDEX `height` (`height`)');
      await this.updateToSchemaVersion(51);
    }

    if (databaseSchemaVersion < 52) {
      await this.$executeQuery(this.getCreateCompactCPFPTableQuery(), await this.$checkIfTableExists('compact_cpfp_clusters'));
      await this.$executeQuery(this.getCreateCompactTransactionsTableQuery(), await this.$checkIfTableExists('compact_transactions'));
      try {
        await this.$convertCompactCpfpTables();
        await this.$executeQuery('DROP TABLE IF EXISTS `transactions`');
        await this.$executeQuery('DROP TABLE IF EXISTS `cpfp_clusters`');
        await this.updateToSchemaVersion(52);
      } catch (e) {
        logger.warn('' + (e instanceof Error ? e.message : e));
      }
    }

    if (databaseSchemaVersion < 53) {
      await this.$executeQuery('ALTER TABLE statistics MODIFY mempool_byte_weight bigint(20) UNSIGNED NOT NULL');
      await this.updateToSchemaVersion(53);
    }

    if (databaseSchemaVersion < 54) {
      this.uniqueLog(logger.notice, `'prices' table has been truncated`);
      await this.$executeQuery(`TRUNCATE prices`);
      if (isBitcoin === true) {
        this.uniqueLog(logger.notice, `'blocks_prices' table has been truncated`);
        await this.$executeQuery(`TRUNCATE blocks_prices`);
      }
      await this.updateToSchemaVersion(54);
    }

    if (databaseSchemaVersion < 55) {
      await this.$executeQuery(this.getAdditionalBlocksDataQuery());
      this.uniqueLog(logger.notice, this.blocksTruncatedMessage);
      await this.$executeQuery('TRUNCATE blocks;'); // Need to re-index
      await this.updateToSchemaVersion(55);
    }

    if (databaseSchemaVersion < 56) {
      await this.$executeQuery('ALTER TABLE pools ADD unique_id int NOT NULL DEFAULT -1');
      await this.$executeQuery('TRUNCATE TABLE `blocks`');
      this.uniqueLog(logger.notice, this.blocksTruncatedMessage);
      await this.$executeQuery('DELETE FROM `pools`');
      await this.$executeQuery('ALTER TABLE pools AUTO_INCREMENT = 1');
      await this.$executeQuery(`UPDATE state SET string = NULL WHERE name = 'pools_json_sha'`);
      this.uniqueLog(logger.notice, '`pools` table has been truncated`');
      await this.updateToSchemaVersion(56);
    }

    if (databaseSchemaVersion < 57 && isBitcoin === true) {
      await this.$executeQuery(`ALTER TABLE nodes MODIFY updated_at datetime NULL`);
      await this.updateToSchemaVersion(57);
    }

    if (databaseSchemaVersion < 58) {
      // We only run some migration queries for this version
      await this.updateToSchemaVersion(58);
    }

    if (databaseSchemaVersion < 59 && (config.MEMPOOL.NETWORK === 'signet' || config.MEMPOOL.NETWORK === 'testnet')) {
      // https://github.com/mempool/mempool/issues/3360
      await this.$executeQuery(`TRUNCATE prices`);
    }

    if (databaseSchemaVersion < 60 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `blocks_audits` ADD sigop_txs JSON DEFAULT "[]"');
      await this.updateToSchemaVersion(60);
    }

    if (databaseSchemaVersion < 61 && isBitcoin === true) {
      // Break block templates into their own table
      if (! await this.$checkIfTableExists('blocks_templates')) {
        await this.$executeQuery('CREATE TABLE blocks_templates AS SELECT id, template FROM blocks_summaries WHERE template != "[]"');
      }
      await this.$executeQuery('ALTER TABLE blocks_templates MODIFY template JSON DEFAULT "[]"');
      await this.$executeQuery('ALTER TABLE blocks_templates ADD PRIMARY KEY (id)');
      await this.$executeQuery('ALTER TABLE blocks_summaries DROP COLUMN template');
      await this.updateToSchemaVersion(61);
    }

    if (databaseSchemaVersion < 62 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `blocks_audits` ADD expected_fees BIGINT UNSIGNED DEFAULT NULL');
      await this.$executeQuery('ALTER TABLE `blocks_audits` ADD expected_weight BIGINT UNSIGNED DEFAULT NULL');
      await this.updateToSchemaVersion(62);
    }

    if (databaseSchemaVersion < 63 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `blocks_audits` ADD fullrbf_txs JSON DEFAULT "[]"');
      await this.updateToSchemaVersion(63);
    }

    if (databaseSchemaVersion < 64 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `nodes` ADD features text NULL');
      await this.updateToSchemaVersion(64);
    }

    if (databaseSchemaVersion < 65 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `blocks_audits` ADD accelerated_txs JSON DEFAULT "[]"');
      await this.updateToSchemaVersion(65);
    }

    if (databaseSchemaVersion < 66) {
      await this.$executeQuery('ALTER TABLE `statistics` ADD min_fee FLOAT UNSIGNED DEFAULT NULL');
      await this.updateToSchemaVersion(66);
    }

    if (databaseSchemaVersion < 67  && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `blocks_summaries` ADD version INT NOT NULL DEFAULT 0');
      await this.$executeQuery('ALTER TABLE `blocks_summaries` ADD INDEX `version` (`version`)');
      await this.$executeQuery('ALTER TABLE `blocks_templates` ADD version INT NOT NULL DEFAULT 0');
      await this.$executeQuery('ALTER TABLE `blocks_templates` ADD INDEX `version` (`version`)');
      await this.updateToSchemaVersion(67);
    }
    
    if (databaseSchemaVersion < 68 && config.MEMPOOL.NETWORK === "liquid") {
      await this.$executeQuery('TRUNCATE TABLE elements_pegs');
      await this.$executeQuery('ALTER TABLE elements_pegs ADD PRIMARY KEY (txid, txindex);');
      await this.$executeQuery(`UPDATE state SET number = 0 WHERE name = 'last_elements_block';`);
      // Create the federation_addresses table and add the two Liquid Federation change addresses in
      await this.$executeQuery(this.getCreateFederationAddressesTableQuery(), await this.$checkIfTableExists('federation_addresses'));
      await this.$executeQuery(`INSERT INTO federation_addresses (bitcoinaddress) VALUES ('bc1qxvay4an52gcghxq5lavact7r6qe9l4laedsazz8fj2ee2cy47tlqff4aj4')`); // Federation change address
      await this.$executeQuery(`INSERT INTO federation_addresses (bitcoinaddress) VALUES ('3EiAcrzq1cELXScc98KeCswGWZaPGceT1d')`); // Federation change address
      // Create the federation_txos table that uses the federation_addresses table as a foreign key
      await this.$executeQuery(this.getCreateFederationTxosTableQuery(), await this.$checkIfTableExists('federation_txos'));
      await this.$executeQuery(`INSERT INTO state VALUES('last_bitcoin_block_audit', 0, NULL);`);
      await this.updateToSchemaVersion(68);
    }

    if (databaseSchemaVersion < 69 && config.MEMPOOL.NETWORK === 'mainnet') {
      await this.$executeQuery(this.getCreateAccelerationsTableQuery(), await this.$checkIfTableExists('accelerations'));
      await this.updateToSchemaVersion(69);
    }

    if (databaseSchemaVersion < 70 && config.MEMPOOL.NETWORK === 'mainnet') {
      await this.$executeQuery('ALTER TABLE accelerations MODIFY COLUMN added DATETIME;');
      await this.updateToSchemaVersion(70);
    }

    if (databaseSchemaVersion < 71 && config.MEMPOOL.NETWORK === 'liquid') {
      await this.$executeQuery('TRUNCATE TABLE elements_pegs');
      await this.$executeQuery('TRUNCATE TABLE federation_txos');
      await this.$executeQuery('SET FOREIGN_KEY_CHECKS = 0');
      await this.$executeQuery('TRUNCATE TABLE federation_addresses');
      await this.$executeQuery('SET FOREIGN_KEY_CHECKS = 1');
      await this.$executeQuery(`INSERT INTO federation_addresses (bitcoinaddress) VALUES ('bc1qxvay4an52gcghxq5lavact7r6qe9l4laedsazz8fj2ee2cy47tlqff4aj4')`); // Federation change address
      await this.$executeQuery(`INSERT INTO federation_addresses (bitcoinaddress) VALUES ('3EiAcrzq1cELXScc98KeCswGWZaPGceT1d')`); // Federation change address
      await this.$executeQuery(`UPDATE state SET number = 0 WHERE name = 'last_elements_block';`);
      await this.$executeQuery(`UPDATE state SET number = 0 WHERE name = 'last_bitcoin_block_audit';`);
      await this.$executeQuery('ALTER TABLE `federation_txos` ADD timelock INT NOT NULL DEFAULT 0');
      await this.$executeQuery('ALTER TABLE `federation_txos` ADD expiredAt INT NOT NULL DEFAULT 0');
      await this.$executeQuery('ALTER TABLE `federation_txos` ADD emergencyKey TINYINT NOT NULL DEFAULT 0');
      await this.updateToSchemaVersion(71);
    }

    if (databaseSchemaVersion < 72 && isBitcoin === true) {
      // reindex Goggles flags for mined block templates above height 832000
      await this.$executeQuery('UPDATE blocks_summaries SET version = 0 WHERE height >= 832000;');
      await this.updateToSchemaVersion(72);
    }

    if (databaseSchemaVersion < 73 && config.MEMPOOL.NETWORK === 'mainnet') {
      // Clear bad data
      await this.$executeQuery(`TRUNCATE accelerations`);
      this.uniqueLog(logger.notice, `'accelerations' table has been truncated`);
      await this.updateToSchemaVersion(73);
    }

    if (databaseSchemaVersion < 74 && config.MEMPOOL.NETWORK === 'mainnet') {
      await this.$executeQuery(`INSERT INTO state(name, number) VALUE ('last_acceleration_block', 0);`);
      await this.updateToSchemaVersion(74);
    }

    if (databaseSchemaVersion < 75) {
      await this.$executeQuery('ALTER TABLE `prices` ADD `BGN` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `BRL` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `CNY` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `CZK` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `DKK` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `HKD` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `HRK` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `HUF` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `IDR` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `ILS` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `INR` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `ISK` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `KRW` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `MXN` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `MYR` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `NOK` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `NZD` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `PHP` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `PLN` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `RON` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `RUB` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `SEK` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `SGD` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `THB` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `TRY` float DEFAULT "-1"');
      await this.$executeQuery('ALTER TABLE `prices` ADD `ZAR` float DEFAULT "-1"');

      if (isBitcoin === true) {
        await this.$executeQuery('TRUNCATE hashrates');
        await this.$executeQuery('TRUNCATE difficulty_adjustments');
        await this.$executeQuery(`UPDATE state SET string = NULL WHERE name = 'pools_json_sha'`);
      }

      await this.updateToSchemaVersion(75);
    }

    if (databaseSchemaVersion < 76 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `blocks_audits` ADD prioritized_txs JSON DEFAULT "[]"');
      await this.updateToSchemaVersion(76);
    }

    if (databaseSchemaVersion < 77 && config.MEMPOOL.NETWORK === 'mainnet') {
      await this.$executeQuery('ALTER TABLE `accelerations` ADD requested datetime DEFAULT NULL');
      await this.updateToSchemaVersion(77);
    }

    if (databaseSchemaVersion < 78) {
      await this.$executeQuery('ALTER TABLE `prices` CHANGE `time` `time` datetime NOT NULL');
      await this.updateToSchemaVersion(78);
    }

    if (databaseSchemaVersion < 79 && config.MEMPOOL.NETWORK === 'mainnet') {
      // Clear bad data
      await this.$executeQuery(`TRUNCATE accelerations`);
      this.uniqueLog(logger.notice, `'accelerations' table has been truncated`);
      await this.$executeQuery(`
        UPDATE state
        SET number = 0
        WHERE name = 'last_acceleration_block'
      `);
      await this.updateToSchemaVersion(79);
    }

    if (databaseSchemaVersion < 80) {
      await this.$executeQuery('ALTER TABLE `blocks` ADD coinbase_addresses JSON DEFAULT NULL');
      await this.updateToSchemaVersion(80);
    }

    if (databaseSchemaVersion < 81 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `blocks_audits` ADD version INT NOT NULL DEFAULT 0');
      await this.$executeQuery('ALTER TABLE `blocks_audits` ADD INDEX `version` (`version`)');
      await this.$executeQuery('ALTER TABLE `blocks_audits` ADD unseen_txs JSON DEFAULT "[]"');
      await this.updateToSchemaVersion(81);
    }

    if (databaseSchemaVersion < 82 && isBitcoin === true && config.MEMPOOL.NETWORK === 'mainnet') {
      await this.$fixBadV1AuditBlocks();
      await this.updateToSchemaVersion(82);
    }

    if (databaseSchemaVersion < 83 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `blocks` ADD first_seen datetime(6) DEFAULT NULL');
      await this.updateToSchemaVersion(83);
    }

    // add new pools indexes
    if (databaseSchemaVersion < 84 && isBitcoin === true) {
      await this.$executeQuery(`
        ALTER TABLE \`pools\`
          ADD INDEX \`slug\` (\`slug\`),
          ADD INDEX \`unique_id\` (\`unique_id\`)
      `);
      await this.updateToSchemaVersion(84);
    }

    // lightning channels indexes
    if (databaseSchemaVersion < 85 && isBitcoin === true) {
      await this.$executeQuery(`
        ALTER TABLE \`channels\`
          ADD INDEX \`created\` (\`created\`),
          ADD INDEX \`capacity\` (\`capacity\`),
          ADD INDEX \`closing_reason\` (\`closing_reason\`),
          ADD INDEX \`closing_resolved\` (\`closing_resolved\`)
      `);
      await this.updateToSchemaVersion(85);
    }

    // lightning nodes indexes
    if (databaseSchemaVersion < 86 && isBitcoin === true) {
      await this.$executeQuery(`
        ALTER TABLE \`nodes\`
          ADD INDEX \`status\` (\`status\`),
          ADD INDEX \`channels\` (\`channels\`),
          ADD INDEX \`country_id\` (\`country_id\`),
          ADD INDEX \`as_number\` (\`as_number\`),
          ADD INDEX \`first_seen\` (\`first_seen\`)
      `);
      await this.updateToSchemaVersion(86);
    }

    // lightning node sockets indexes
    if (databaseSchemaVersion < 87 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `nodes_sockets` ADD INDEX `type` (`type`)');
      await this.updateToSchemaVersion(87);
    }

    // lightning stats indexes
    if (databaseSchemaVersion < 88 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `lightning_stats` ADD INDEX `added` (`added`)');
      await this.updateToSchemaVersion(88);
    }

    // geo names indexes
    if (databaseSchemaVersion < 89 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `geo_names` ADD INDEX `names` (`names`)');
      await this.updateToSchemaVersion(89);
    }

    // hashrates indexes
    if (databaseSchemaVersion < 90 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `hashrates` ADD INDEX `type` (`type`)');
      await this.updateToSchemaVersion(90);
    }

    // block audits indexes
    if (databaseSchemaVersion < 91 && isBitcoin === true) {
      await this.$executeQuery('ALTER TABLE `blocks_audits` ADD INDEX `time` (`time`)');
      await this.updateToSchemaVersion(91);
    }

    // elements_pegs indexes
    if (databaseSchemaVersion < 92 && config.MEMPOOL.NETWORK === 'liquid') {
      await this.$executeQuery(`
        ALTER TABLE \`elements_pegs\`
          ADD INDEX \`block\` (\`block\`),
          ADD INDEX \`datetime\` (\`datetime\`),
          ADD INDEX \`amount\` (\`amount\`),
          ADD INDEX \`bitcoinaddress\` (\`bitcoinaddress\`),
          ADD INDEX \`bitcointxid\` (\`bitcointxid\`)
      `);
      await this.updateToSchemaVersion(92);
    }

    // federation_txos indexes
    if (databaseSchemaVersion < 93 && config.MEMPOOL.NETWORK === 'liquid') {
      await this.$executeQuery(`
        ALTER TABLE \`federation_txos\`
          ADD INDEX \`unspent\` (\`unspent\`),
          ADD INDEX \`lastblockupdate\` (\`lastblockupdate\`),
          ADD INDEX \`blocktime\` (\`blocktime\`),
          ADD INDEX \`emergencyKey\` (\`emergencyKey\`),
          ADD INDEX \`expiredAt\` (\`expiredAt\`)
      `);
      await this.updateToSchemaVersion(93);
    }

    // Unify database schema for all mempool netwoks
    // versions above 94 should not use network-specific flags
    if (databaseSchemaVersion < 94) {

      if (!isBitcoin) {
        // Apply all the bitcoin specific migrations to non-bitcoin networks: liquid, liquidtestnet and testnet4 (!)
        // Version 5
        await this.$executeQuery('ALTER TABLE blocks ADD `reward` double unsigned NOT NULL DEFAULT "0"');

        // Version 6
        await this.$executeQuery('ALTER TABLE blocks MODIFY `height` integer unsigned NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE blocks MODIFY `tx_count` smallint unsigned NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE blocks MODIFY `size` integer unsigned NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE blocks MODIFY `weight` integer unsigned NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE blocks MODIFY `difficulty` double NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE blocks DROP FOREIGN KEY IF EXISTS `blocks_ibfk_1`');
        await this.$executeQuery('ALTER TABLE pools MODIFY `id` smallint unsigned AUTO_INCREMENT');
        await this.$executeQuery('ALTER TABLE blocks MODIFY `pool_id` smallint unsigned NULL');
        await this.$executeQuery('ALTER TABLE blocks ADD FOREIGN KEY (`pool_id`) REFERENCES `pools` (`id`)');
        await this.$executeQuery('ALTER TABLE blocks ADD `version` integer unsigned NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE blocks ADD `bits` integer unsigned NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE blocks ADD `nonce` bigint unsigned NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE blocks ADD `merkle_root` varchar(65) NOT NULL DEFAULT ""');
        await this.$executeQuery('ALTER TABLE blocks ADD `previous_block_hash` varchar(65) NULL');

        // Version 7
        await this.$executeQuery('DROP table IF EXISTS hashrates;');
        await this.$executeQuery(this.getCreateDailyStatsTableQuery(), await this.$checkIfTableExists('hashrates'));

        // Version 8
        await this.$executeQuery('ALTER TABLE `hashrates` DROP INDEX `PRIMARY`');
        await this.$executeQuery('ALTER TABLE `hashrates` ADD `id` int NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST');
        await this.$executeQuery('ALTER TABLE `hashrates` ADD `share` float NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE `hashrates` ADD `type` enum("daily", "weekly") DEFAULT "daily"');

        // Version 9
        await this.$executeQuery('ALTER TABLE `state` CHANGE `name` `name` varchar(100)');
        await this.$executeQuery('ALTER TABLE `hashrates` ADD UNIQUE `hashrate_timestamp_pool_id` (`hashrate_timestamp`, `pool_id`)');

        // Version 10
        await this.$executeQuery('ALTER TABLE `blocks` ADD INDEX `blockTimestamp` (`blockTimestamp`)');

        // Version 11
        await this.$executeQuery(`ALTER TABLE blocks
          ADD avg_fee INT UNSIGNED NULL,
          ADD avg_fee_rate INT UNSIGNED NULL
        `);
        await this.$executeQuery('ALTER TABLE blocks MODIFY `reward` BIGINT UNSIGNED NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE blocks MODIFY `median_fee` INT UNSIGNED NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE blocks MODIFY `fees` INT UNSIGNED NOT NULL DEFAULT "0"');

        // Version 12
        await this.$executeQuery('ALTER TABLE blocks MODIFY `fees` BIGINT UNSIGNED NOT NULL DEFAULT "0"');

        // Version 13
        await this.$executeQuery('ALTER TABLE blocks MODIFY `difficulty` DOUBLE UNSIGNED NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE blocks MODIFY `median_fee` BIGINT UNSIGNED NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE blocks MODIFY `avg_fee` BIGINT UNSIGNED NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE blocks MODIFY `avg_fee_rate` BIGINT UNSIGNED NOT NULL DEFAULT "0"');

        // Version 14
        await this.$executeQuery('ALTER TABLE `hashrates` DROP FOREIGN KEY `hashrates_ibfk_1`');
        await this.$executeQuery('ALTER TABLE `hashrates` MODIFY `pool_id` SMALLINT UNSIGNED NOT NULL DEFAULT "0"');

        // Version 17
        await this.$executeQuery('ALTER TABLE `pools` ADD `slug` CHAR(50) NULL');

        // Version 18
        await this.$executeQuery('ALTER TABLE `blocks` ADD INDEX `hash` (`hash`);');

        // Version 20
        await this.$executeQuery(this.getCreateBlocksSummariesTableQuery(), await this.$checkIfTableExists('blocks_summaries'));

        // Version 22
        await this.$executeQuery('DROP TABLE IF EXISTS `difficulty_adjustments`');
        await this.$executeQuery(this.getCreateDifficultyAdjustmentsTableQuery(), await this.$checkIfTableExists('difficulty_adjustments'));

        // Version 24
        await this.$executeQuery('DROP TABLE IF EXISTS `blocks_audits`');
        await this.$executeQuery(this.getCreateBlocksAuditsTableQuery(), await this.$checkIfTableExists('blocks_audits'));

        // Version 25
        await this.$executeQuery(this.getCreateLightningStatisticsQuery(), await this.$checkIfTableExists('lightning_stats'));
        await this.$executeQuery(this.getCreateNodesQuery(), await this.$checkIfTableExists('nodes'));
        await this.$executeQuery(this.getCreateChannelsQuery(), await this.$checkIfTableExists('channels'));
        await this.$executeQuery(this.getCreateNodesStatsQuery(), await this.$checkIfTableExists('node_stats'));

        // Version 26
        await this.$executeQuery('ALTER TABLE `lightning_stats` ADD tor_nodes int(11) NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE `lightning_stats` ADD clearnet_nodes int(11) NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE `lightning_stats` ADD unannounced_nodes int(11) NOT NULL DEFAULT "0"');

        // Version 27
        await this.$executeQuery('ALTER TABLE `lightning_stats` ADD avg_capacity bigint(20) unsigned NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE `lightning_stats` ADD avg_fee_rate int(11) unsigned NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE `lightning_stats` ADD avg_base_fee_mtokens bigint(20) unsigned NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE `lightning_stats` ADD med_capacity bigint(20) unsigned NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE `lightning_stats` ADD med_fee_rate int(11) unsigned NOT NULL DEFAULT "0"');
        await this.$executeQuery('ALTER TABLE `lightning_stats` ADD med_base_fee_mtokens bigint(20) unsigned NOT NULL DEFAULT "0"');

        // Version 28
        await this.$executeQuery(`ALTER TABLE lightning_stats MODIFY added DATE`);

        // Version 29
        await this.$executeQuery(this.getCreateGeoNamesTableQuery(), await this.$checkIfTableExists('geo_names'));
        await this.$executeQuery('ALTER TABLE `nodes` ADD as_number int(11) unsigned NULL DEFAULT NULL');
        await this.$executeQuery('ALTER TABLE `nodes` ADD city_id int(11) unsigned NULL DEFAULT NULL');
        await this.$executeQuery('ALTER TABLE `nodes` ADD country_id int(11) unsigned NULL DEFAULT NULL');
        await this.$executeQuery('ALTER TABLE `nodes` ADD accuracy_radius int(11) unsigned NULL DEFAULT NULL');
        await this.$executeQuery('ALTER TABLE `nodes` ADD subdivision_id int(11) unsigned NULL DEFAULT NULL');
        await this.$executeQuery('ALTER TABLE `nodes` ADD longitude double NULL DEFAULT NULL');
        await this.$executeQuery('ALTER TABLE `nodes` ADD latitude double NULL DEFAULT NULL');

        // Version 30
        await this.$executeQuery('ALTER TABLE `geo_names` CHANGE `type` `type` enum("city","country","division","continent","as_organization") NOT NULL');

        // Version 31
        await this.$executeQuery('ALTER TABLE `prices` ADD `id` int NULL AUTO_INCREMENT UNIQUE');
        await this.$executeQuery('DROP TABLE IF EXISTS `blocks_prices`');
        await this.$executeQuery(this.getCreateBlocksPricesTableQuery(), await this.$checkIfTableExists('blocks_prices'));

        // Version 32
        await this.$executeQuery('ALTER TABLE `blocks_summaries` ADD `template` JSON DEFAULT "[]"');

        // Version 33
        await this.$executeQuery('ALTER TABLE `geo_names` CHANGE `type` `type` enum("city","country","division","continent","as_organization", "country_iso_code") NOT NULL');

        // Version 34
        await this.$executeQuery('ALTER TABLE `lightning_stats` ADD clearnet_tor_nodes int(11) NOT NULL DEFAULT "0"');
    
        // Version 35
        await this.$executeQuery('DELETE from `lightning_stats` WHERE added > "2021-09-19"');
        await this.$executeQuery('ALTER TABLE `lightning_stats` ADD CONSTRAINT added_unique UNIQUE (added);');

        // Version 36
        await this.$executeQuery('ALTER TABLE `nodes` ADD status TINYINT NOT NULL DEFAULT "1"');
    
        // Version 37
        await this.$executeQuery(this.getCreateLNNodesSocketsTableQuery(), await this.$checkIfTableExists('nodes_sockets'));
        
        // Version 38
        await this.$executeQuery(`TRUNCATE lightning_stats`);
        await this.$executeQuery(`TRUNCATE node_stats`);
        await this.$executeQuery('ALTER TABLE `lightning_stats` CHANGE `added` `added` timestamp NULL');
        await this.$executeQuery('ALTER TABLE `node_stats` CHANGE `added` `added` timestamp NULL');
        await this.updateToSchemaVersion(38);
      
        // Version 39
        await this.$executeQuery('ALTER TABLE `nodes` ADD alias_search TEXT NULL DEFAULT NULL AFTER `alias`');
        await this.$executeQuery('ALTER TABLE nodes ADD FULLTEXT(alias_search)');

        // Version 40
        await this.$executeQuery('ALTER TABLE `nodes` ADD capacity bigint(20) unsigned DEFAULT NULL');
        await this.$executeQuery('ALTER TABLE `nodes` ADD channels int(11) unsigned DEFAULT NULL');
        await this.$executeQuery('ALTER TABLE `nodes` ADD INDEX `capacity` (`capacity`);');

        // Version 41
        await this.$executeQuery('UPDATE channels SET closing_reason = NULL WHERE closing_reason = 1');

        // Version 42
        await this.$executeQuery('ALTER TABLE `channels` ADD closing_resolved tinyint(1) DEFAULT 0');
      
        // Version 43
        await this.$executeQuery(this.getCreateLNNodeRecordsTableQuery(), await this.$checkIfTableExists('nodes_records'));

        // Version 44
        await this.$executeQuery('UPDATE blocks_summaries SET template = NULL');

        // Version 45
        await this.$executeQuery('ALTER TABLE `blocks_audits` ADD fresh_txs JSON DEFAULT "[]"');
    
        // Version 48
        await this.$executeQuery('ALTER TABLE `channels` ADD source_checked tinyint(1) DEFAULT 0');
        await this.$executeQuery('ALTER TABLE `channels` ADD closing_fee bigint(20) unsigned DEFAULT 0');
        await this.$executeQuery('ALTER TABLE `channels` ADD node1_funding_balance bigint(20) unsigned DEFAULT 0');
        await this.$executeQuery('ALTER TABLE `channels` ADD node2_funding_balance bigint(20) unsigned DEFAULT 0');
        await this.$executeQuery('ALTER TABLE `channels` ADD node1_closing_balance bigint(20) unsigned DEFAULT 0');
        await this.$executeQuery('ALTER TABLE `channels` ADD node2_closing_balance bigint(20) unsigned DEFAULT 0');
        await this.$executeQuery('ALTER TABLE `channels` ADD funding_ratio float unsigned DEFAULT NULL');
        await this.$executeQuery('ALTER TABLE `channels` ADD closed_by varchar(66) DEFAULT NULL');
        await this.$executeQuery('ALTER TABLE `channels` ADD single_funded tinyint(1) DEFAULT 0');
        await this.$executeQuery('ALTER TABLE `channels` ADD outputs JSON DEFAULT "[]"');

        // Version 57
        await this.$executeQuery(`ALTER TABLE nodes MODIFY updated_at datetime NULL`);

        // Version 60
        await this.$executeQuery('ALTER TABLE `blocks_audits` ADD sigop_txs JSON DEFAULT "[]"');

        // Version 61
        if (! await this.$checkIfTableExists('blocks_templates')) {
          await this.$executeQuery('CREATE TABLE blocks_templates AS SELECT id, template FROM blocks_summaries WHERE template != "[]"');
        }
        await this.$executeQuery('ALTER TABLE blocks_templates MODIFY template JSON DEFAULT "[]"');
        await this.$executeQuery('ALTER TABLE blocks_templates ADD PRIMARY KEY (id)');
        await this.$executeQuery('ALTER TABLE blocks_summaries DROP COLUMN template');

        // Version 62
        await this.$executeQuery('ALTER TABLE `blocks_audits` ADD expected_fees BIGINT UNSIGNED DEFAULT NULL');
        await this.$executeQuery('ALTER TABLE `blocks_audits` ADD expected_weight BIGINT UNSIGNED DEFAULT NULL');
      
        // Version 63
        await this.$executeQuery('ALTER TABLE `blocks_audits` ADD fullrbf_txs JSON DEFAULT "[]"');
    
        // Version 64
        await this.$executeQuery('ALTER TABLE `nodes` ADD features text NULL');
    
        // Version 65
        await this.$executeQuery('ALTER TABLE `blocks_audits` ADD accelerated_txs JSON DEFAULT "[]"');

        // Version 67
        await this.$executeQuery('ALTER TABLE `blocks_summaries` ADD version INT NOT NULL DEFAULT 0');
        await this.$executeQuery('ALTER TABLE `blocks_summaries` ADD INDEX `version` (`version`)');
        await this.$executeQuery('ALTER TABLE `blocks_templates` ADD version INT NOT NULL DEFAULT 0');
        await this.$executeQuery('ALTER TABLE `blocks_templates` ADD INDEX `version` (`version`)');

        // Version 76
        await this.$executeQuery('ALTER TABLE `blocks_audits` ADD prioritized_txs JSON DEFAULT "[]"');

        // Version 81
        await this.$executeQuery('ALTER TABLE `blocks_audits` ADD version INT NOT NULL DEFAULT 0');
        await this.$executeQuery('ALTER TABLE `blocks_audits` ADD INDEX `version` (`version`)');
        await this.$executeQuery('ALTER TABLE `blocks_audits` ADD unseen_txs JSON DEFAULT "[]"');

        // Version 83
        await this.$executeQuery('ALTER TABLE `blocks` ADD first_seen datetime(6) DEFAULT NULL');

        // Version 84
        await this.$executeQuery(`
          ALTER TABLE \`pools\`
            ADD INDEX \`slug\` (\`slug\`),
            ADD INDEX \`unique_id\` (\`unique_id\`)
        `);

        // Version 85
        await this.$executeQuery(`
          ALTER TABLE \`channels\`
            ADD INDEX \`created\` (\`created\`),
            ADD INDEX \`capacity\` (\`capacity\`),
            ADD INDEX \`closing_reason\` (\`closing_reason\`),
            ADD INDEX \`closing_resolved\` (\`closing_resolved\`)
        `);
        
        // Version 86        
        await this.$executeQuery(`
          ALTER TABLE \`nodes\`
            ADD INDEX \`status\` (\`status\`),
            ADD INDEX \`channels\` (\`channels\`),
            ADD INDEX \`country_id\` (\`country_id\`),
            ADD INDEX \`as_number\` (\`as_number\`),
            ADD INDEX \`first_seen\` (\`first_seen\`)
        `);

        // Version 87
        await this.$executeQuery('ALTER TABLE `nodes_sockets` ADD INDEX `type` (`type`)');
        await this.updateToSchemaVersion(87);
        
        // Version 88
        await this.$executeQuery('ALTER TABLE `lightning_stats` ADD INDEX `added` (`added`)');
    
        // Version 89
        await this.$executeQuery('ALTER TABLE `geo_names` ADD INDEX `names` (`names`)');
    
        // Version 90
        await this.$executeQuery('ALTER TABLE `hashrates` ADD INDEX `type` (`type`)');

        // Version 91
        await this.$executeQuery('ALTER TABLE `blocks_audits` ADD INDEX `time` (`time`)');
      }
      
      if (config.MEMPOOL.NETWORK !== 'liquid') {
        // Apply all the liquid specific migrations to all other networks
        // Version 68
        await this.$executeQuery('ALTER TABLE elements_pegs ADD PRIMARY KEY (txid, txindex);');
        await this.$executeQuery(this.getCreateFederationAddressesTableQuery(), await this.$checkIfTableExists('federation_addresses'));
        await this.$executeQuery(this.getCreateFederationTxosTableQuery(), await this.$checkIfTableExists('federation_txos'));

        // Version 71
        await this.$executeQuery('ALTER TABLE `federation_txos` ADD timelock INT NOT NULL DEFAULT 0');
        await this.$executeQuery('ALTER TABLE `federation_txos` ADD expiredAt INT NOT NULL DEFAULT 0');
        await this.$executeQuery('ALTER TABLE `federation_txos` ADD emergencyKey TINYINT NOT NULL DEFAULT 0');

        // Version 92
        await this.$executeQuery(`
          ALTER TABLE \`elements_pegs\`
            ADD INDEX \`block\` (\`block\`),
            ADD INDEX \`datetime\` (\`datetime\`),
            ADD INDEX \`amount\` (\`amount\`),
            ADD INDEX \`bitcoinaddress\` (\`bitcoinaddress\`),
            ADD INDEX \`bitcointxid\` (\`bitcointxid\`)
        `);
    
        // Version 93
        await this.$executeQuery(`
          ALTER TABLE \`federation_txos\`
            ADD INDEX \`unspent\` (\`unspent\`),
            ADD INDEX \`lastblockupdate\` (\`lastblockupdate\`),
            ADD INDEX \`blocktime\` (\`blocktime\`),
            ADD INDEX \`emergencyKey\` (\`emergencyKey\`),
            ADD INDEX \`expiredAt\` (\`expiredAt\`)
        `);
      }

      if (config.MEMPOOL.NETWORK !== 'mainnet') {
        // Apply all the mainnet specific migrations to all other networks
        // Version 69
        await this.$executeQuery(this.getCreateAccelerationsTableQuery(), await this.$checkIfTableExists('accelerations'));

        // Version 70
        await this.$executeQuery('ALTER TABLE accelerations MODIFY COLUMN added DATETIME;');

        // Version 77
        await this.$executeQuery('ALTER TABLE `accelerations` ADD requested datetime DEFAULT NULL');
      }
      await this.updateToSchemaVersion(94);
    }

    // blocks pools-v2.json hash
    if (databaseSchemaVersion < 95) {
      let poolJsonSha = 'f737d86571d190cf1a1a3cf5fd86b33ba9624254';
      const [poolJsonShaDb]: any[] = await DB.query(`SELECT string FROM state WHERE name = 'pools_json_sha'`);
      if (poolJsonShaDb?.length > 0) {
        poolJsonSha = poolJsonShaDb[0].string;
      }
      await this.$executeQuery(`ALTER TABLE blocks ADD definition_hash varchar(255) NOT NULL DEFAULT "${poolJsonSha}"`);
      await this.$executeQuery('ALTER TABLE blocks ADD INDEX `definition_hash` (`definition_hash`)');
      await this.updateToSchemaVersion(95);
    }
  }

  /**
   * Special case here for the `statistics` table - It appeared that somehow some dbs already had the `added` field indexed
   * while it does not appear in previous schemas. The mariadb command "CREATE INDEX IF NOT EXISTS" is not supported on
   * older mariadb version. Therefore we set a flag here in order to know if the index needs to be created or not before
   * running the migration process
   */
  private async $setStatisticsAddedIndexedFlag(databaseSchemaVersion: number) {
    if (databaseSchemaVersion >= 2) {
      this.statisticsAddedIndexed = true;
      return;
    }

    try {
      // We don't use "CREATE INDEX IF NOT EXISTS" because it is not supported on old mariadb version 5.X
      const query = `SELECT COUNT(1) hasIndex FROM INFORMATION_SCHEMA.STATISTICS
        WHERE table_schema=DATABASE() AND table_name='statistics' AND index_name='added';`;
      const [rows] = await this.$executeQuery(query, true);
      if (rows[0].hasIndex === 0) {
        logger.debug('MIGRATIONS: `statistics.added` is not indexed');
        this.statisticsAddedIndexed = false;
      } else if (rows[0].hasIndex === 1) {
        logger.debug('MIGRATIONS: `statistics.added` is already indexed');
        this.statisticsAddedIndexed = true;
      }
    } catch (e) {
      // Should really never happen but just in case it fails, we just don't execute
      // any query related to this indexing so it won't fail if the index actually already exists
      logger.err('MIGRATIONS: Unable to check if `statistics.added` INDEX exist or not.');
      this.statisticsAddedIndexed = true;
    }
  }

  /**
   * Small query execution wrapper to log all executed queries
   */
  private async $executeQuery(query: string, silent = false): Promise<any> {
    if (!silent) {
      logger.debug('MIGRATIONS: Execute query:\n' + query);
    }
    return DB.query({ sql: query, timeout: this.queryTimeout });
  }

  /**
   * Check if 'table' exists in the database
   */
  private async $checkIfTableExists(table: string): Promise<boolean> {
    const query = `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${config.DATABASE.DATABASE}' AND TABLE_NAME = '${table}'`;
    const [rows] = await DB.query({ sql: query, timeout: this.queryTimeout });
    return rows[0]['COUNT(*)'] === 1;
  }

  /**
   * Get current database version
   */
  private async $getSchemaVersionFromDatabase(): Promise<number> {
    const query = `SELECT number FROM state WHERE name = 'schema_version';`;
    const [rows] = await this.$executeQuery(query, true);
    return rows[0]['number'];
  }

  /**
   * Create the `state` table
   */
  private async $createMigrationStateTable(): Promise<void> {
    const query = `CREATE TABLE IF NOT EXISTS state (
      name varchar(25) NOT NULL,
      number int(11) NULL,
      string varchar(100) NULL,
      CONSTRAINT name_unique UNIQUE (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
    await this.$executeQuery(query);

    // Set initial values
    await this.$executeQuery(`INSERT INTO state VALUES('schema_version', 0, NULL);`);
    await this.$executeQuery(`INSERT INTO state VALUES('last_elements_block', 0, NULL);`);
  }

  /**
   * We actually execute the migrations queries here
   */
  private async $migrateTableSchemaFromVersion(version: number): Promise<void> {
    const transactionQueries: string[] = [];
    for (const query of this.getMigrationQueriesFromVersion(version)) {
      transactionQueries.push(query);
    }

    logger.notice(`MIGRATIONS: ${version > 0 ? 'Upgrading' : 'Initializing'} database schema version number to ${DatabaseMigration.currentVersion}`);
    transactionQueries.push(this.getUpdateToLatestSchemaVersionQuery());

    try {
      await this.$executeQuery('START TRANSACTION;');
      for (const query of transactionQueries) {
        await this.$executeQuery(query);
      }
      await this.$executeQuery('COMMIT;');
    } catch (e) {
      await this.$executeQuery('ROLLBACK;');
      throw e;
    }
  }

  /**
   * Generate migration queries based on schema version
   */
  private getMigrationQueriesFromVersion(version: number): string[] {
    const queries: string[] = [];
    const isBitcoin = ['mainnet', 'testnet', 'signet'].includes(config.MEMPOOL.NETWORK);

    if (version < 1) {
      if (config.MEMPOOL.NETWORK !== 'liquid' && config.MEMPOOL.NETWORK !== 'liquidtestnet') {
        if (version > 0) {
          logger.notice(`MIGRATIONS: Migrating (shifting) statistics table data`);
        }
        queries.push(this.getShiftStatisticsQuery());
      }
    }

    if (version < 7 && isBitcoin === true) {
      queries.push(`INSERT INTO state(name, number, string) VALUES ('last_hashrates_indexing', 0, NULL)`);
    }

    if (version < 9 && isBitcoin === true) {
      queries.push(`INSERT INTO state(name, number, string) VALUES ('last_weekly_hashrates_indexing', 0, NULL)`);
    }

    if (version < 58) {
      queries.push(`DELETE FROM state WHERE name = 'last_hashrates_indexing'`);
      queries.push(`DELETE FROM state WHERE name = 'last_weekly_hashrates_indexing'`);
    }

    return queries;
  }

  /**
   * Save the schema version in the database
   */
  private getUpdateToLatestSchemaVersionQuery(): string {
    return `UPDATE state SET number = ${DatabaseMigration.currentVersion} WHERE name = 'schema_version';`;
  }

  private async updateToSchemaVersion(version): Promise<void> {
    await this.$executeQuery(`UPDATE state SET number = ${version} WHERE name = 'schema_version';`);
  }

  /**
   * Print current database version
   */
  private async $printDatabaseVersion() {
    try {
      const [rows] = await this.$executeQuery('SELECT VERSION() as version;', true);
      logger.debug(`MIGRATIONS: Database engine version '${rows[0].version}'`);
    } catch (e) {
      logger.debug(`MIGRATIONS: Could not fetch database engine version. ` + e);
    }
  }

  // Couple of wrappers to clean the main logic
  private getShiftStatisticsQuery(): string {
    return `UPDATE statistics SET
      vsize_1 = vsize_1 + vsize_2, vsize_2 = vsize_3,
      vsize_3 = vsize_4, vsize_4 = vsize_5,
      vsize_5 = vsize_6, vsize_6 = vsize_8,
      vsize_8 = vsize_10, vsize_10 = vsize_12,
      vsize_12 = vsize_15, vsize_15 = vsize_20,
      vsize_20 = vsize_30, vsize_30 = vsize_40,
      vsize_40 = vsize_50, vsize_50 = vsize_60,
      vsize_60 = vsize_70, vsize_70 = vsize_80,
      vsize_80 = vsize_90, vsize_90 = vsize_100,
      vsize_100 = vsize_125, vsize_125 = vsize_150,
      vsize_150 = vsize_175, vsize_175 = vsize_200,
      vsize_200 = vsize_250, vsize_250 = vsize_300,
      vsize_300 = vsize_350, vsize_350 = vsize_400,
      vsize_400 = vsize_500, vsize_500 = vsize_600,
      vsize_600 = vsize_700, vsize_700 = vsize_800,
      vsize_800 = vsize_900, vsize_900 = vsize_1000,
      vsize_1000 = vsize_1200, vsize_1200 = vsize_1400,
      vsize_1400 = vsize_1800, vsize_1800 = vsize_2000, vsize_2000 = 0;`;
  }

  private getCreateStatisticsQuery(): string {
    return `CREATE TABLE IF NOT EXISTS statistics (
      id int(11) NOT NULL AUTO_INCREMENT,
      added datetime NOT NULL,
      unconfirmed_transactions int(11) UNSIGNED NOT NULL,
      tx_per_second float UNSIGNED NOT NULL,
      vbytes_per_second int(10) UNSIGNED NOT NULL,
      mempool_byte_weight int(10) UNSIGNED NOT NULL,
      fee_data longtext NOT NULL,
      total_fee double UNSIGNED NOT NULL,
      vsize_1 int(11) NOT NULL,
      vsize_2 int(11) NOT NULL,
      vsize_3 int(11) NOT NULL,
      vsize_4 int(11) NOT NULL,
      vsize_5 int(11) NOT NULL,
      vsize_6 int(11) NOT NULL,
      vsize_8 int(11) NOT NULL,
      vsize_10 int(11) NOT NULL,
      vsize_12 int(11) NOT NULL,
      vsize_15 int(11) NOT NULL,
      vsize_20 int(11) NOT NULL,
      vsize_30 int(11) NOT NULL,
      vsize_40 int(11) NOT NULL,
      vsize_50 int(11) NOT NULL,
      vsize_60 int(11) NOT NULL,
      vsize_70 int(11) NOT NULL,
      vsize_80 int(11) NOT NULL,
      vsize_90 int(11) NOT NULL,
      vsize_100 int(11) NOT NULL,
      vsize_125 int(11) NOT NULL,
      vsize_150 int(11) NOT NULL,
      vsize_175 int(11) NOT NULL,
      vsize_200 int(11) NOT NULL,
      vsize_250 int(11) NOT NULL,
      vsize_300 int(11) NOT NULL,
      vsize_350 int(11) NOT NULL,
      vsize_400 int(11) NOT NULL,
      vsize_500 int(11) NOT NULL,
      vsize_600 int(11) NOT NULL,
      vsize_700 int(11) NOT NULL,
      vsize_800 int(11) NOT NULL,
      vsize_900 int(11) NOT NULL,
      vsize_1000 int(11) NOT NULL,
      vsize_1200 int(11) NOT NULL,
      vsize_1400 int(11) NOT NULL,
      vsize_1600 int(11) NOT NULL,
      vsize_1800 int(11) NOT NULL,
      vsize_2000 int(11) NOT NULL,
      CONSTRAINT PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateElementsTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS elements_pegs (
      block int(11) NOT NULL,
      datetime int(11) NOT NULL,
      amount bigint(20) NOT NULL,
      txid varchar(65) NOT NULL,
      txindex int(11) NOT NULL,
      bitcoinaddress varchar(100) NOT NULL,
      bitcointxid varchar(65) NOT NULL,
      bitcoinindex int(11) NOT NULL,
      final_tx int(11) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateFederationAddressesTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS federation_addresses (
      bitcoinaddress varchar(100) NOT NULL,
      PRIMARY KEY (bitcoinaddress)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateFederationTxosTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS federation_txos (
      txid varchar(65) NOT NULL,
      txindex int(11) NOT NULL,
      bitcoinaddress varchar(100) NOT NULL,
      amount bigint(20) unsigned NOT NULL,
      blocknumber int(11) unsigned NOT NULL,
      blocktime int(11) unsigned NOT NULL,
      unspent tinyint(1) NOT NULL,
      lastblockupdate int(11) unsigned NOT NULL,
      lasttimeupdate int(11) unsigned NOT NULL,
      pegtxid varchar(65) NOT NULL,
      pegindex int(11) NOT NULL,
      pegblocktime int(11) unsigned NOT NULL,
      PRIMARY KEY (txid, txindex), 
      FOREIGN KEY (bitcoinaddress) REFERENCES federation_addresses (bitcoinaddress)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreatePoolsTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS pools (
      id int(11) NOT NULL AUTO_INCREMENT,
      name varchar(50) NOT NULL,
      link varchar(255) NOT NULL,
      addresses text NOT NULL,
      regexes text NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  }

  private getCreateBlocksTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS blocks (
      height int(11) unsigned NOT NULL,
      hash varchar(65) NOT NULL,
      blockTimestamp timestamp NOT NULL,
      size int(11) unsigned NOT NULL,
      weight int(11) unsigned NOT NULL,
      tx_count int(11) unsigned NOT NULL,
      coinbase_raw text,
      difficulty bigint(20) unsigned NOT NULL,
      pool_id int(11) DEFAULT -1,
      fees double unsigned NOT NULL,
      fee_span json NOT NULL,
      median_fee double unsigned NOT NULL,
      PRIMARY KEY (height),
      INDEX (pool_id),
      FOREIGN KEY (pool_id) REFERENCES pools (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getAdditionalBlocksDataQuery(): string {
    return `ALTER TABLE blocks
      ADD median_timestamp timestamp NOT NULL,
      ADD coinbase_address varchar(100) NULL,
      ADD coinbase_signature varchar(500) NULL,
      ADD coinbase_signature_ascii varchar(500) NULL,
      ADD avg_tx_size double unsigned NOT NULL,
      ADD total_inputs int unsigned NOT NULL,
      ADD total_outputs int unsigned NOT NULL,
      ADD total_output_amt bigint unsigned NOT NULL,
      ADD fee_percentiles longtext NULL,
      ADD median_fee_amt int unsigned NULL,
      ADD segwit_total_txs int unsigned NOT NULL,
      ADD segwit_total_size int unsigned NOT NULL,
      ADD segwit_total_weight int unsigned NOT NULL,
      ADD header varchar(160) NOT NULL,
      ADD utxoset_change int NOT NULL,
      ADD utxoset_size int unsigned NULL,
      ADD total_input_amt bigint unsigned NULL
    `;
  }

  private getCreateDailyStatsTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS hashrates (
      hashrate_timestamp timestamp NOT NULL,
      avg_hashrate double unsigned DEFAULT '0',
      pool_id smallint unsigned NULL,
      PRIMARY KEY (hashrate_timestamp),
      INDEX (pool_id),
      FOREIGN KEY (pool_id) REFERENCES pools (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateRatesTableQuery(): string { // This table has been replaced by the prices table
    return `CREATE TABLE IF NOT EXISTS rates (
      height int(10) unsigned NOT NULL,
      bisq_rates JSON NOT NULL,
      PRIMARY KEY (height)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateBlocksSummariesTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS blocks_summaries (
      height int(10) unsigned NOT NULL,
      id varchar(65) NOT NULL,
      transactions JSON NOT NULL,
      PRIMARY KEY (id),
      INDEX (height)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreatePricesTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS prices (
      time timestamp NOT NULL,
      avg_prices JSON NOT NULL,
      PRIMARY KEY (time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateDifficultyAdjustmentsTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS difficulty_adjustments (
      time timestamp NOT NULL,
      height int(10) unsigned NOT NULL,
      difficulty double unsigned NOT NULL,
      adjustment float NOT NULL,
      PRIMARY KEY (height),
      INDEX (time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateLightningStatisticsQuery(): string {
    return `CREATE TABLE IF NOT EXISTS lightning_stats (
      id int(11) NOT NULL AUTO_INCREMENT,
      added datetime NOT NULL,
      channel_count int(11) NOT NULL,
      node_count int(11) NOT NULL,
      total_capacity double unsigned NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateNodesQuery(): string {
    return `CREATE TABLE IF NOT EXISTS nodes (
      public_key varchar(66) NOT NULL,
      first_seen datetime NOT NULL,
      updated_at datetime NOT NULL,
      alias varchar(200) CHARACTER SET utf8mb4 NOT NULL,
      color varchar(200) NOT NULL,
      sockets text DEFAULT NULL,
      PRIMARY KEY (public_key),
      KEY alias (alias(10))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateChannelsQuery(): string {
    return `CREATE TABLE IF NOT EXISTS channels (
      id bigint(11) unsigned NOT NULL,
      short_id varchar(15) NOT NULL DEFAULT '',
      capacity bigint(20) unsigned NOT NULL,
      transaction_id varchar(64) NOT NULL,
      transaction_vout int(11) NOT NULL,
      updated_at datetime DEFAULT NULL,
      created datetime DEFAULT NULL,
      status int(11) NOT NULL DEFAULT 0,
      closing_transaction_id varchar(64) DEFAULT NULL,
      closing_date datetime DEFAULT NULL,
      closing_reason int(11) DEFAULT NULL,
      node1_public_key varchar(66) NOT NULL,
      node1_base_fee_mtokens bigint(20) unsigned DEFAULT NULL,
      node1_cltv_delta int(11) DEFAULT NULL,
      node1_fee_rate bigint(11) DEFAULT NULL,
      node1_is_disabled tinyint(1) DEFAULT NULL,
      node1_max_htlc_mtokens bigint(20) unsigned DEFAULT NULL,
      node1_min_htlc_mtokens bigint(20) DEFAULT NULL,
      node1_updated_at datetime DEFAULT NULL,
      node2_public_key varchar(66) NOT NULL,
      node2_base_fee_mtokens bigint(20) unsigned DEFAULT NULL,
      node2_cltv_delta int(11) DEFAULT NULL,
      node2_fee_rate bigint(11) DEFAULT NULL,
      node2_is_disabled tinyint(1) DEFAULT NULL,
      node2_max_htlc_mtokens bigint(20) unsigned DEFAULT NULL,
      node2_min_htlc_mtokens bigint(20) unsigned DEFAULT NULL,
      node2_updated_at datetime DEFAULT NULL,
      PRIMARY KEY (id),
      KEY node1_public_key (node1_public_key),
      KEY node2_public_key (node2_public_key),
      KEY status (status),
      KEY short_id (short_id),
      KEY transaction_id (transaction_id),
      KEY closing_transaction_id (closing_transaction_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateNodesStatsQuery(): string {
    return `CREATE TABLE IF NOT EXISTS node_stats (
      id int(11) unsigned NOT NULL AUTO_INCREMENT,
      public_key varchar(66) NOT NULL DEFAULT '',
      added date NOT NULL,
      capacity bigint(20) unsigned NOT NULL DEFAULT 0,
      channels int(11) unsigned NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      UNIQUE KEY added (added,public_key),
      KEY public_key (public_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateBlocksAuditsTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS blocks_audits (
      time timestamp NOT NULL,
      hash varchar(65) NOT NULL,
      height int(10) unsigned NOT NULL,
      missing_txs JSON NOT NULL,
      added_txs JSON NOT NULL,
      match_rate float unsigned NOT NULL,
      PRIMARY KEY (hash),
      INDEX (height)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateGeoNamesTableQuery(): string {
    return `CREATE TABLE geo_names (
      id int(11) unsigned NOT NULL,
      type enum('city','country','division','continent') NOT NULL,
      names text DEFAULT NULL,
      UNIQUE KEY id (id,type),
      KEY id_2 (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateBlocksPricesTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS blocks_prices (
      height int(10) unsigned NOT NULL,
      price_id int(10) unsigned NOT NULL,
      PRIMARY KEY (height),
      INDEX (price_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateLNNodesSocketsTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS nodes_sockets (
      public_key varchar(66) NOT NULL,
      socket varchar(100) NOT NULL,
      type enum('ipv4', 'ipv6', 'torv2', 'torv3', 'i2p', 'dns', 'websocket') NULL,
      UNIQUE KEY public_key_socket (public_key, socket),
      INDEX (public_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateLNNodeRecordsTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS nodes_records (
      public_key varchar(66) NOT NULL,
      type int(10) unsigned NOT NULL,
      payload blob NOT NULL,
      UNIQUE KEY public_key_type (public_key, type),
      INDEX (public_key),
      FOREIGN KEY (public_key)
        REFERENCES nodes (public_key)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateCPFPTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS cpfp_clusters (
      root varchar(65) NOT NULL,
      height int(10) NOT NULL,
      txs JSON DEFAULT NULL,
      fee_rate double unsigned NOT NULL,
      PRIMARY KEY (root)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateTransactionsTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS transactions (
      txid varchar(65) NOT NULL,
      cluster varchar(65) DEFAULT NULL,
      PRIMARY KEY (txid),
      FOREIGN KEY (cluster) REFERENCES cpfp_clusters (root) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateCompactCPFPTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS compact_cpfp_clusters (
      root binary(32) NOT NULL,
      height int(10) NOT NULL,
      txs BLOB DEFAULT NULL,
      fee_rate float unsigned,
      PRIMARY KEY (root),
      INDEX (height)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateCompactTransactionsTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS compact_transactions (
      txid binary(32) NOT NULL,
      cluster binary(32) DEFAULT NULL,
      PRIMARY KEY (txid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  private getCreateAccelerationsTableQuery(): string {
    return `CREATE TABLE IF NOT EXISTS accelerations (
      txid varchar(65) NOT NULL,
      added datetime NOT NULL,
      height int(10) NOT NULL,
      pool smallint unsigned NULL,
      effective_vsize int(10) NOT NULL,
      effective_fee bigint(20) unsigned NOT NULL,
      boost_rate float unsigned,
      boost_cost bigint(20) unsigned NOT NULL,
      PRIMARY KEY (txid),
      INDEX (added),
      INDEX (height),
      INDEX (pool)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8;`;
  }

  public async $blocksReindexingTruncate(): Promise<void> {
    logger.warn(`Truncating pools, blocks, hashrates and difficulty_adjustments tables for re-indexing (using '--reindex-blocks'). You can cancel this command within 5 seconds`);
    await Common.sleep$(5000);

    await this.$executeQuery(`TRUNCATE blocks`);
    await this.$executeQuery(`TRUNCATE hashrates`);
    await this.$executeQuery(`TRUNCATE difficulty_adjustments`);
    await this.$executeQuery('DELETE FROM `pools`');
    await this.$executeQuery('ALTER TABLE pools AUTO_INCREMENT = 1');
    await this.$executeQuery(`UPDATE state SET string = NULL WHERE name = 'pools_json_sha'`);
  }

  private async $convertCompactCpfpTables(): Promise<void> {
    try {
      const batchSize = 250;
      const maxHeight = await blocksRepository.$mostRecentBlockHeight() || 0;
      const [minHeightRows]: any = await DB.query(`SELECT MIN(height) AS minHeight from cpfp_clusters`);
      const minHeight = (minHeightRows.length && minHeightRows[0].minHeight != null) ? minHeightRows[0].minHeight : maxHeight;
      let height = maxHeight;

      // Logging
      let timer = new Date().getTime() / 1000;
      const startedAt = new Date().getTime() / 1000;

      while (height > minHeight) {
        const [rows] = await DB.query(
          `
            SELECT * from cpfp_clusters
            WHERE height <= ? AND height > ?
            ORDER BY height
          `,
          [height, height - batchSize]
        ) as RowDataPacket[][];
        if (rows?.length) {
          await cpfpRepository.$batchSaveClusters(rows.map(row => {
            return {
              root: row.root,
              height: row.height,
              txs: JSON.parse(row.txs),
              effectiveFeePerVsize: row.fee_rate,
            };
          }));
        }

        const elapsed = new Date().getTime() / 1000 - timer;
        const runningFor = new Date().getTime() / 1000 - startedAt;
        logger.debug(`Migrated cpfp data from block ${height} to ${height - batchSize} in ${elapsed.toFixed(2)} seconds | total elapsed: ${runningFor.toFixed(2)} seconds`);
        timer = new Date().getTime() / 1000;
        height -= batchSize;
      }
    } catch (e) {
      logger.warn(`Failed to migrate cpfp transaction data`);
    }
  }

  private async $fixBadV1AuditBlocks(): Promise<void> {
    const badBlocks = [
      '000000000000000000011ad49227fc8c9ba0ca96ad2ebce41a862f9a244478dc',
      '000000000000000000010ac1f68b3080153f2826ffddc87ceffdd68ed97d6960',
      '000000000000000000024cbdafeb2660ae8bd2947d166e7fe15d1689e86b2cf7',
      '00000000000000000002e1dbfbf6ae057f331992a058b822644b368034f87286',
      '0000000000000000000019973b2778f08ad6d21e083302ff0833d17066921ebb',
    ];

    for (const hash of badBlocks) {
      try {
        await this.$executeQuery(`
          UPDATE blocks_audits
          SET prioritized_txs = '[]'
          WHERE hash = '${hash}'
        `, true);
      } catch (e) {
        continue;
      }
    }
  }
}

export default new DatabaseMigration();
