import bitcoinApi from '../api/bitcoin/bitcoin-api-factory';
import { BlockExtended, BlockExtension, BlockPrice, EffectiveFeeStats } from '../mempool.interfaces';
import DB from '../database';
import logger from '../logger';
import { Common } from '../api/common';
import PoolsRepository from './PoolsRepository';
import HashratesRepository from './HashratesRepository';
import { RowDataPacket } from 'mysql2';
import BlocksSummariesRepository from './BlocksSummariesRepository';
import DifficultyAdjustmentsRepository from './DifficultyAdjustmentsRepository';
import bitcoinClient from '../api/bitcoin/bitcoin-client';
import config from '../config';
import chainTips from '../api/chain-tips';
import blocks from '../api/blocks';
import BlocksAuditsRepository from './BlocksAuditsRepository';
import transactionUtils from '../api/transaction-utils';
import { parseDATUMTemplateCreator } from '../utils/bitcoin-script';
import poolsUpdater from '../tasks/pools-updater';

interface DatabaseBlock {
  id: string;
  height: number;
  version: number;
  timestamp: number;
  bits: number;
  nonce: number;
  difficulty: number;
  merkle_root: string;
  tx_count: number;
  size: number;
  weight: number;
  previousblockhash: string;
  mediantime: number;
  totalFees: number;
  medianFee: number;
  feeRange: string;
  reward: number;
  poolId: number;
  poolName: string;
  poolSlug: string;
  avgFee: number;
  avgFeeRate: number;
  coinbaseRaw: string;
  coinbaseAddress: string;
  coinbaseAddresses: string;
  coinbaseSignature: string;
  coinbaseSignatureAscii: string;
  avgTxSize: number;
  totalInputs: number;
  totalOutputs: number;
  totalOutputAmt: number;
  medianFeeAmt: number;
  feePercentiles: string;
  segwitTotalTxs: number;
  segwitTotalSize: number;
  segwitTotalWeight: number;
  header: string;
  utxoSetChange: number;
  utxoSetSize: number;
  totalInputAmt: number;
  firstSeen: number;
}

const BLOCK_DB_FIELDS = `
  blocks.hash AS id,
  blocks.height,
  blocks.version,
  UNIX_TIMESTAMP(blocks.blockTimestamp) AS timestamp,
  blocks.bits,
  blocks.nonce,
  blocks.difficulty,
  blocks.merkle_root,
  blocks.tx_count,
  blocks.size,
  blocks.weight,
  blocks.previous_block_hash AS previousblockhash,
  UNIX_TIMESTAMP(blocks.median_timestamp) AS mediantime,
  blocks.fees AS totalFees,
  blocks.median_fee AS medianFee,
  blocks.fee_span AS feeRange,
  blocks.reward,
  pools.unique_id AS poolId,
  pools.name AS poolName,
  pools.slug AS poolSlug,
  blocks.avg_fee AS avgFee,
  blocks.avg_fee_rate AS avgFeeRate,
  blocks.coinbase_raw AS coinbaseRaw,
  blocks.coinbase_address AS coinbaseAddress,
  blocks.coinbase_addresses AS coinbaseAddresses,
  blocks.coinbase_signature AS coinbaseSignature,
  blocks.coinbase_signature_ascii AS coinbaseSignatureAscii,
  blocks.avg_tx_size AS avgTxSize,
  blocks.total_inputs AS totalInputs,
  blocks.total_outputs AS totalOutputs,
  blocks.total_output_amt AS totalOutputAmt,
  blocks.median_fee_amt AS medianFeeAmt,
  blocks.fee_percentiles AS feePercentiles,
  blocks.segwit_total_txs AS segwitTotalTxs,
  blocks.segwit_total_size AS segwitTotalSize,
  blocks.segwit_total_weight AS segwitTotalWeight,
  blocks.header,
  blocks.utxoset_change AS utxoSetChange,
  blocks.utxoset_size AS utxoSetSize,
  blocks.total_input_amt AS totalInputAmt,
  UNIX_TIMESTAMP(blocks.first_seen) AS firstSeen
`;

class BlocksRepository {
  /**
   * Save indexed block data in the database
   */
  public async $saveBlockInDatabase(block: BlockExtended) {
    const truncatedCoinbaseSignature = block?.extras?.coinbaseSignature?.substring(0, 500);
    const truncatedCoinbaseSignatureAscii = block?.extras?.coinbaseSignatureAscii?.substring(0, 500);

    try {
      const query = `INSERT INTO blocks(
        height,             hash,                     blockTimestamp,    size,
        weight,             tx_count,                 coinbase_raw,      difficulty,
        pool_id,            fees,                     fee_span,          median_fee,
        reward,             version,                  bits,              nonce,
        merkle_root,        previous_block_hash,      avg_fee,           avg_fee_rate,
        median_timestamp,   header,                   coinbase_address,  coinbase_addresses,
        coinbase_signature, utxoset_size,             utxoset_change,    avg_tx_size,
        total_inputs,       total_outputs,            total_input_amt,   total_output_amt,
        fee_percentiles,    segwit_total_txs,         segwit_total_size, segwit_total_weight,
        median_fee_amt,     coinbase_signature_ascii, definition_hash
      ) VALUE (
        ?, ?, FROM_UNIXTIME(?), ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        FROM_UNIXTIME(?), ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?
      )`;

      const poolDbId = await PoolsRepository.$getPoolByUniqueId(block.extras.pool.id);
      if (!poolDbId) {
        throw Error(`Could not find a mining pool with the unique_id = ${block.extras.pool.id}. This error should never be printed.`);
      }

      const params: any[] = [
        block.height,
        block.id,
        block.timestamp,
        block.size,
        block.weight,
        block.tx_count,
        block.extras.coinbaseRaw,
        block.difficulty,
        poolDbId.id,
        block.extras.totalFees,
        JSON.stringify(block.extras.feeRange),
        block.extras.medianFee,
        block.extras.reward,
        block.version,
        block.bits,
        block.nonce,
        block.merkle_root,
        block.previousblockhash,
        block.extras.avgFee,
        block.extras.avgFeeRate,
        block.mediantime,
        block.extras.header,
        block.extras.coinbaseAddress,
        block.extras.coinbaseAddresses ? JSON.stringify(block.extras.coinbaseAddresses) : null,
        truncatedCoinbaseSignature,
        block.extras.utxoSetSize,
        block.extras.utxoSetChange,
        block.extras.avgTxSize,
        block.extras.totalInputs,
        block.extras.totalOutputs,
        block.extras.totalInputAmt,
        block.extras.totalOutputAmt,
        block.extras.feePercentiles ? JSON.stringify(block.extras.feePercentiles) : null,
        block.extras.segwitTotalTxs,
        block.extras.segwitTotalSize,
        block.extras.segwitTotalWeight,
        block.extras.medianFeeAmt,
        truncatedCoinbaseSignatureAscii,
        poolsUpdater.currentSha
      ];

      await DB.query(query, params);
    } catch (e: any) {
      if (e.errno === 1062) { // ER_DUP_ENTRY - This scenario is possible upon node backend restart
        logger.debug(`$saveBlockInDatabase() - Block ${block.height} has already been indexed, ignoring`, logger.tags.mining);
      } else {
        logger.err('Cannot save indexed block into db. Reason: ' + (e instanceof Error ? e.message : e), logger.tags.mining);
        throw e;
      }
    }
  }

  /**
   * Save newly indexed data from core coinstatsindex
   * 
   * @param utxoSetSize 
   * @param totalInputAmt 
   */
  public async $updateCoinStatsIndexData(blockHash: string, utxoSetSize: number,
    totalInputAmt: number
  ) : Promise<void> {
    try {
      const query = `
        UPDATE blocks
        SET utxoset_size = ?, total_input_amt = ?
        WHERE hash = ?
      `;
      const params: any[] = [
        utxoSetSize,
        totalInputAmt,
        blockHash
      ];
      await DB.query(query, params);
    } catch (e: any) {
      logger.err('Cannot update indexed block coinstatsindex. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Update missing fee amounts fields
   *
   * @param blockHash 
   * @param feeAmtPercentiles 
   * @param medianFeeAmt 
   */
  public async $updateFeeAmounts(blockHash: string, feeAmtPercentiles, medianFeeAmt) : Promise<void> {
    try {
      const query = `
        UPDATE blocks
        SET fee_percentiles = ?, median_fee_amt = ?
        WHERE hash = ?
      `;
      const params: any[] = [
        JSON.stringify(feeAmtPercentiles),
        medianFeeAmt,
        blockHash
      ];
      await DB.query(query, params);
    } catch (e: any) {
      logger.err(`Cannot update fee amounts for block ${blockHash}. Reason: ' + ${e instanceof Error ? e.message : e}`);
      throw e;
    }
  }

  /**
   * Get all block height that have not been indexed between [startHeight, endHeight]
   */
  public async $getMissingBlocksBetweenHeights(startHeight: number, endHeight: number): Promise<number[]> {
    if (startHeight < endHeight) {
      return [];
    }

    try {
      const [rows]: any[] = await DB.query(`
        SELECT height
        FROM blocks
        WHERE height <= ? AND height >= ?
        ORDER BY height DESC;
      `, [startHeight, endHeight]);

      const indexedBlockHeights: number[] = [];
      rows.forEach((row: any) => { indexedBlockHeights.push(row.height); });
      const seekedBlocks: number[] = Array.from(Array(startHeight - endHeight + 1).keys(), n => n + endHeight).reverse();
      const missingBlocksHeights = seekedBlocks.filter(x => indexedBlockHeights.indexOf(x) === -1);

      return missingBlocksHeights;
    } catch (e) {
      logger.err('Cannot retrieve blocks list to index. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get empty blocks for one or all pools
   */
  public async $countEmptyBlocks(poolId: number | null, interval: string | null = null): Promise<any> {
    interval = Common.getSqlInterval(interval);

    const params: any[] = [];
    let query = `SELECT count(height) as count, pools.id as poolId
      FROM blocks
      JOIN pools on pools.id = blocks.pool_id
      WHERE tx_count = 1`;

    if (poolId) {
      query += ` AND pool_id = ?`;
      params.push(poolId);
    }

    if (interval) {
      query += ` AND blockTimestamp BETWEEN DATE_SUB(NOW(), INTERVAL ${interval}) AND NOW()`;
    }

    query += ` GROUP by pools.id`;

    try {
      const [rows] = await DB.query(query, params);
      return rows;
    } catch (e) {
      logger.err('Cannot count empty blocks. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Return most recent block height
   */
  public async $mostRecentBlockHeight(): Promise<number> {
    try {
      const [row] = await DB.query('SELECT MAX(height) as maxHeight from blocks');
      return row[0]['maxHeight'];
    } catch (e) {
      logger.err(`Cannot count blocks for this pool (using offset). Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get blocks count for a period
   */
  public async $blockCount(poolId: number | null, interval: string | null = null): Promise<number> {
    interval = Common.getSqlInterval(interval);

    const params: any[] = [];
    let query = `SELECT count(height) as blockCount
      FROM blocks`;

    if (poolId) {
      query += ` WHERE pool_id = ?`;
      params.push(poolId);
    }

    if (interval) {
      if (poolId) {
        query += ` AND`;
      } else {
        query += ` WHERE`;
      }
      query += ` blockTimestamp BETWEEN DATE_SUB(NOW(), INTERVAL ${interval}) AND NOW()`;
    }

    try {
      const [rows] = await DB.query(query, params);
      return <number>rows[0].blockCount;
    } catch (e) {
      logger.err(`Cannot count blocks for this pool (using offset). Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get blocks count between two dates
   * @param poolId
   * @param from - The oldest timestamp
   * @param to - The newest timestamp
   * @returns
   */
  public async $blockCountBetweenTimestamp(poolId: number | null, from: number, to: number): Promise<number> {
    const params: any[] = [];
    let query = `SELECT
      count(height) as blockCount,
      max(height) as lastBlockHeight
      FROM blocks`;

    if (poolId) {
      query += ` WHERE pool_id = ?`;
      params.push(poolId);
    }

    if (poolId) {
      query += ` AND`;
    } else {
      query += ` WHERE`;
    }
    query += ` blockTimestamp BETWEEN FROM_UNIXTIME('${from}') AND FROM_UNIXTIME('${to}')`;

    try {
      const [rows] = await DB.query(query, params);
      return <number>rows[0];
    } catch (e) {
      logger.err(`Cannot count blocks for this pool (using timestamps). Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get blocks count for a period
   */
   public async $blockCountBetweenHeight(startHeight: number, endHeight: number): Promise<number> {
    const params: any[] = [];
    let query = `SELECT count(height) as blockCount
      FROM blocks
      WHERE height <= ${startHeight} AND height >= ${endHeight}`;

    try {
      const [rows] = await DB.query(query, params);
      return <number>rows[0].blockCount;
    } catch (e) {
      logger.err(`Cannot count blocks for this pool (using offset). Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get average block health for all blocks for a single pool
   */
  public async $getAvgBlockHealthPerPoolId(poolId: number): Promise<number | null> {
    const params: any[] = [];
    const query = `
      SELECT AVG(blocks_audits.match_rate) AS avg_match_rate
      FROM blocks
      JOIN blocks_audits ON blocks.height = blocks_audits.height
      WHERE blocks.pool_id = ?
    `;
    params.push(poolId);

    try {
      const [rows] = await DB.query(query, params);
      if (!rows[0] || rows[0].avg_match_rate == null) {
        return null;
      }
      return Math.round(rows[0].avg_match_rate * 100) / 100;
    } catch (e) {
      logger.err(`Cannot get average block health for pool id ${poolId}. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get average block health for all blocks for a single pool
   */
  public async $getTotalRewardForPoolId(poolId: number): Promise<number> {
    const params: any[] = [];
    const query = `
      SELECT sum(reward) as total_reward
      FROM blocks
      WHERE blocks.pool_id = ?
    `;
    params.push(poolId);

    try {
      const [rows] = await DB.query(query, params);
      if (!rows[0] || !rows[0].total_reward) {
        return 0;
      }
      return rows[0].total_reward;
    } catch (e) {
      logger.err(`Cannot get total reward for pool id ${poolId}. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get the oldest indexed block
   */
  public async $oldestBlockTimestamp(): Promise<number> {
    const query = `SELECT UNIX_TIMESTAMP(blockTimestamp) as blockTimestamp
      FROM blocks
      ORDER BY height
      LIMIT 1;`;

    try {
      const [rows]: any[] = await DB.query(query);

      if (rows.length <= 0) {
        return -1;
      }

      return <number>rows[0].blockTimestamp;
    } catch (e) {
      logger.err('Cannot get oldest indexed block timestamp. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get blocks mined by a specific mining pool
   */
  public async $getBlocksByPool(slug: string, startHeight?: number): Promise<BlockExtended[]> {
    const pool = await PoolsRepository.$getPool(slug);
    if (!pool) {
      throw new Error('This mining pool does not exist');
    }

    const params: any[] = [];
    let query = `
      SELECT ${BLOCK_DB_FIELDS}
      FROM blocks
      JOIN pools ON blocks.pool_id = pools.id
      WHERE pool_id = ?`;
    params.push(pool.id);

    if (startHeight !== undefined) {
      query += ` AND height < ?`;
      params.push(startHeight);
    }

    query += ` ORDER BY height DESC
      LIMIT 100`;

    try {
      const [rows]: any[] = await DB.query(query, params);

      const blocks: BlockExtended[] = [];
      for (const block of rows) {
        blocks.push(await this.formatDbBlockIntoExtendedBlock(block as DatabaseBlock));
      }

      return blocks;
    } catch (e) {
      logger.err('Cannot get blocks for this pool. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get one block by height
   */
  public async $getBlockByHeight(height: number): Promise<BlockExtended | null> {
    try {
      const [rows]: any[] = await DB.query(`
        SELECT ${BLOCK_DB_FIELDS}
        FROM blocks
        JOIN pools ON blocks.pool_id = pools.id
        WHERE blocks.height = ?`,
        [height]
      );

      if (rows.length <= 0) {
        return null;
      }

      return await this.formatDbBlockIntoExtendedBlock(rows[0] as DatabaseBlock);
    } catch (e) {
      logger.err(`Cannot get indexed block ${height}. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Return blocks difficulty
   */
  public async $getBlocksDifficulty(): Promise<object[]> {
    try {
      const [rows]: any[] = await DB.query(`SELECT UNIX_TIMESTAMP(blockTimestamp) as time, height, difficulty, bits FROM blocks ORDER BY height ASC`);
      return rows;
    } catch (e) {
      logger.err('Cannot get blocks difficulty list from the db. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get the first block at or directly after a given timestamp
   * @param timestamp number unix time in seconds
   * @returns The height and timestamp of a block (timestamp might vary from given timestamp)
   */
  public async $getBlockHeightFromTimestamp(
    timestamp: number,
  ): Promise<{ height: number; hash: string; timestamp: number }> {
    try {
      // Get first block at or after the given timestamp
      const query = `SELECT height, hash, blockTimestamp as timestamp FROM blocks
        WHERE blockTimestamp <= FROM_UNIXTIME(?)
        ORDER BY blockTimestamp DESC
        LIMIT 1`;
      const params = [timestamp];
      const [rows]: any[][] = await DB.query(query, params);
      if (rows.length === 0) {
        throw new Error(`No block was found before timestamp ${timestamp}`);
      }

      return rows[0];
    } catch (e) {
      logger.err(
        'Cannot get block height from timestamp from the db. Reason: ' +
          (e instanceof Error ? e.message : e),
      );
      throw e;
    }
  }

  /**
   * Get general block stats
   */
  public async $getBlockStats(blockCount: number): Promise<any> {
    try {
      // We need to use a subquery
      const query = `
        SELECT MIN(height) as startBlock, MAX(height) as endBlock, SUM(reward) as totalReward, SUM(fees) as totalFee, SUM(tx_count) as totalTx
        FROM
          (SELECT height, reward, fees, tx_count FROM blocks
          ORDER by height DESC
          LIMIT ?) as sub`;

      const [rows]: any = await DB.query(query, [blockCount]);

      return rows[0];
    } catch (e) {
      logger.err('Cannot generate reward stats. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Check if the chain of block hash is valid and delete data from the stale branch if needed
   */
  public async $validateChain(): Promise<boolean> {
    try {
      const start = new Date().getTime();
      const [blocks]: any[] = await DB.query(`
        SELECT
          height,
          hash,
          previous_block_hash,
          UNIX_TIMESTAMP(blockTimestamp) AS timestamp
        FROM blocks
        ORDER BY height
      `);

      let partialMsg = false;
      let idx = 1;
      while (idx < blocks.length) {
        if (blocks[idx].height - 1 !== blocks[idx - 1].height) {
          if (partialMsg === false) {
            logger.info('Some blocks are not indexed, skipping missing blocks during chain validation');
            partialMsg = true;
          }
          ++idx;
          continue;
        }

        if (blocks[idx].previous_block_hash !== blocks[idx - 1].hash) {
          logger.warn(`Chain divergence detected at block ${blocks[idx - 1].height}`);
          await this.$deleteBlocksFrom(blocks[idx - 1].height);
          await HashratesRepository.$deleteHashratesFromTimestamp(blocks[idx - 1].timestamp - 604800);
          await DifficultyAdjustmentsRepository.$deleteAdjustementsFromHeight(blocks[idx - 1].height);
          return false;
        }
        ++idx;
      }

      logger.debug(`${idx} blocks hash validated in ${new Date().getTime() - start} ms`);
      return true;
    } catch (e) {
      logger.err('Cannot validate chain of block hash. Reason: ' + (e instanceof Error ? e.message : e));
      return true; // Don't do anything if there is a db error
    }
  }

  /**
   * Delete blocks from the database from blockHeight
   */
  public async $deleteBlocksFrom(blockHeight: number) {
    logger.info(`Delete newer blocks from height ${blockHeight} from the database`, logger.tags.mining);

    try {
      await DB.query(`DELETE FROM blocks where height >= ${blockHeight}`);
    } catch (e) {
      logger.err('Cannot delete indexed blocks. Reason: ' + (e instanceof Error ? e.message : e));
    }
  }

  /**
   * Get the historical averaged block fees
   */
  public async $getHistoricalBlockFees(div: number, interval: string | null, timespan?: {from: number, to: number}): Promise<any> {
    try {
      let query = `SELECT
        CAST(AVG(blocks.height) as INT) as avgHeight,
        CAST(AVG(UNIX_TIMESTAMP(blockTimestamp)) as INT) as timestamp,
        CAST(AVG(fees) as INT) as avgFees,
        prices.USD
        FROM blocks
        JOIN blocks_prices on blocks_prices.height = blocks.height
        JOIN prices on prices.id = blocks_prices.price_id
      `;

      if (interval !== null) {
        query += ` WHERE blockTimestamp BETWEEN DATE_SUB(NOW(), INTERVAL ${interval}) AND NOW()`;
      } else if (timespan) {
        query += ` WHERE blockTimestamp BETWEEN FROM_UNIXTIME(${timespan.from}) AND FROM_UNIXTIME(${timespan.to})`;
      }

      query += ` GROUP BY UNIX_TIMESTAMP(blockTimestamp) DIV ${div}`;

      const [rows]: any = await DB.query(query);
      return rows;
    } catch (e) {
      logger.err('Cannot generate block fees history. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get the historical averaged block rewards
   */
  public async $getHistoricalBlockRewards(div: number, interval: string | null): Promise<any> {
    try {
      let query = `SELECT
        CAST(AVG(blocks.height) as INT) as avgHeight,
        CAST(AVG(UNIX_TIMESTAMP(blockTimestamp)) as INT) as timestamp,
        CAST(AVG(reward) as INT) as avgRewards,
        prices.USD
        FROM blocks
        JOIN blocks_prices on blocks_prices.height = blocks.height
        JOIN prices on prices.id = blocks_prices.price_id
      `;

      if (interval !== null) {
        query += ` WHERE blockTimestamp BETWEEN DATE_SUB(NOW(), INTERVAL ${interval}) AND NOW()`;
      }

      query += ` GROUP BY UNIX_TIMESTAMP(blockTimestamp) DIV ${div}`;

      const [rows]: any = await DB.query(query);
      return rows;
    } catch (e) {
      logger.err('Cannot generate block rewards history. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get the historical averaged block fee rate percentiles
   */
   public async $getHistoricalBlockFeeRates(div: number, interval: string | null): Promise<any> {
    try {
      let query = `SELECT
        CAST(AVG(height) as INT) as avgHeight,
        CAST(AVG(UNIX_TIMESTAMP(blockTimestamp)) as INT) as timestamp,
        CAST(AVG(JSON_EXTRACT(fee_span, '$[0]')) as INT) as avgFee_0,
        CAST(AVG(JSON_EXTRACT(fee_span, '$[1]')) as INT) as avgFee_10,
        CAST(AVG(JSON_EXTRACT(fee_span, '$[2]')) as INT) as avgFee_25,
        CAST(AVG(JSON_EXTRACT(fee_span, '$[3]')) as INT) as avgFee_50,
        CAST(AVG(JSON_EXTRACT(fee_span, '$[4]')) as INT) as avgFee_75,
        CAST(AVG(JSON_EXTRACT(fee_span, '$[5]')) as INT) as avgFee_90,
        CAST(AVG(JSON_EXTRACT(fee_span, '$[6]')) as INT) as avgFee_100
      FROM blocks`;

      if (interval !== null) {
        query += ` WHERE blockTimestamp BETWEEN DATE_SUB(NOW(), INTERVAL ${interval}) AND NOW()`;
      }

      query += ` GROUP BY UNIX_TIMESTAMP(blockTimestamp) DIV ${div}`;

      const [rows]: any = await DB.query(query);
      return rows;
    } catch (e) {
      logger.err('Cannot generate block fee rates history. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get the historical averaged block sizes
   */
   public async $getHistoricalBlockSizes(div: number, interval: string | null): Promise<any> {
    try {
      let query = `SELECT
        CAST(AVG(height) as INT) as avgHeight,
        CAST(AVG(UNIX_TIMESTAMP(blockTimestamp)) as INT) as timestamp,
        CAST(AVG(size) as INT) as avgSize
      FROM blocks`;

      if (interval !== null) {
        query += ` WHERE blockTimestamp BETWEEN DATE_SUB(NOW(), INTERVAL ${interval}) AND NOW()`;
      }

      query += ` GROUP BY UNIX_TIMESTAMP(blockTimestamp) DIV ${div}`;

      const [rows]: any = await DB.query(query);
      return rows;
    } catch (e) {
      logger.err('Cannot generate block size and weight history. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get the historical averaged block weights
   */
   public async $getHistoricalBlockWeights(div: number, interval: string | null): Promise<any> {
    try {
      let query = `SELECT
        CAST(AVG(height) as INT) as avgHeight,
        CAST(AVG(UNIX_TIMESTAMP(blockTimestamp)) as INT) as timestamp,
        CAST(AVG(weight) as INT) as avgWeight
      FROM blocks`;

      if (interval !== null) {
        query += ` WHERE blockTimestamp BETWEEN DATE_SUB(NOW(), INTERVAL ${interval}) AND NOW()`;
      }

      query += ` GROUP BY UNIX_TIMESTAMP(blockTimestamp) DIV ${div}`;

      const [rows]: any = await DB.query(query);
      return rows;
    } catch (e) {
      logger.err('Cannot generate block size and weight history. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get a list of blocks that have been indexed
   */
  public async $getIndexedBlocks(): Promise<{ height: number, hash: string }[]> {
    try {
      const [rows] = await DB.query(`SELECT height, hash FROM blocks ORDER BY height DESC`) as RowDataPacket[][];
      return rows as { height: number, hash: string }[];
    } catch (e) {
      logger.err('Cannot generate block size and weight history. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get a list of blocks that have not had CPFP data indexed
   */
   public async $getCPFPUnindexedBlocks(): Promise<number[]> {
    try {
      const blockchainInfo = await bitcoinClient.getBlockchainInfo();
      const currentBlockHeight = blockchainInfo.blocks;
      let indexingBlockAmount = Math.min(config.MEMPOOL.INDEXING_BLOCKS_AMOUNT, currentBlockHeight);
      if (indexingBlockAmount <= -1) {
        indexingBlockAmount = currentBlockHeight + 1;
      }
      const minHeight = Math.max(0, currentBlockHeight - indexingBlockAmount + 1);

      const [rows] = await DB.query(`
        SELECT height
        FROM compact_cpfp_clusters
        WHERE height <= ? AND height >= ?
        GROUP BY height
        ORDER BY height DESC;
      `, [currentBlockHeight, minHeight]) as RowDataPacket[][];

      const indexedHeights = {};
      rows.forEach((row) => { indexedHeights[row.height] = true; });
      const allHeights: number[] = Array.from(Array(currentBlockHeight - minHeight + 1).keys(), n => n + minHeight).reverse();
      const unindexedHeights = allHeights.filter(x => !indexedHeights[x]);

      return unindexedHeights;
    } catch (e) {
      logger.err('Cannot fetch CPFP unindexed blocks. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Return the oldest block  from a consecutive chain of block from the most recent one
   */
  public async $getOldestConsecutiveBlock(): Promise<any> {
    try {
      const [rows]: any = await DB.query(`SELECT height, UNIX_TIMESTAMP(blockTimestamp) as timestamp, difficulty, bits FROM blocks ORDER BY height DESC`);
      for (let i = 0; i < rows.length - 1; ++i) {
        if (rows[i].height - rows[i + 1].height > 1) {
          return rows[i];
        }
      }
      return rows[rows.length - 1];
    } catch (e) {
      logger.err('Cannot generate block size and weight history. Reason: ' + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Get all blocks which have not be linked to a price yet
   */
  public async $getBlocksWithoutPrice(): Promise<object[]> {
    try {
      const [rows]: any[] = await DB.query(`
        SELECT UNIX_TIMESTAMP(blocks.blockTimestamp) as timestamp, blocks.height
        FROM blocks
        LEFT JOIN blocks_prices ON blocks.height = blocks_prices.height
        WHERE blocks_prices.height IS NULL
        ORDER BY blocks.height
      `);
      return rows;
    } catch (e) {
      logger.err('Cannot get blocks height and timestamp from the db. Reason: ' + (e instanceof Error ? e.message : e));
      return [];
    }
  }

  /**
   * Save block price by batch
   */
   public async $saveBlockPrices(blockPrices: BlockPrice[]): Promise<void> {
    try {
      let query = `INSERT INTO blocks_prices(height, price_id) VALUES`;
      for (const price of blockPrices) {
        query += ` (${price.height}, ${price.priceId}),`;
      }
      query = query.slice(0, -1);
      await DB.query(query);
    } catch (e: any) {
      if (e.errno === 1062) { // ER_DUP_ENTRY - This scenario is possible upon node backend restart
        logger.debug(`Cannot save blocks prices for blocks [${blockPrices[0].height} to ${blockPrices[blockPrices.length - 1].height}] because it has already been indexed, ignoring`);
      } else {
        logger.err(`Cannot save blocks prices for blocks [${blockPrices[0].height} to ${blockPrices[blockPrices.length - 1].height}] into db. Reason: ` + (e instanceof Error ? e.message : e));
      }
    }
  }

  /**
   * Get all indexed blocsk with missing coinstatsindex data
   */
  public async $getBlocksMissingCoinStatsIndex(maxHeight: number, minHeight: number): Promise<any> {
    try {
      const [blocks] = await DB.query(`
        SELECT height, hash
        FROM blocks
        WHERE height >= ${minHeight} AND height <= ${maxHeight} AND
          (utxoset_size IS NULL OR total_input_amt IS NULL)
      `);
      return blocks;
    } catch (e) {
      logger.err(`Cannot get blocks with missing coinstatsindex. Reason: ` + (e instanceof Error ? e.message : e));
      return [];
    }
  }

  /**
   * Get all indexed blocks with missing coinbase addresses
   */
  public async $getBlocksWithoutCoinbaseAddresses(): Promise<any> {
    try {
      const [blocks] = await DB.query(`
        SELECT height, hash, coinbase_addresses
        FROM blocks
        WHERE coinbase_addresses IS NULL AND
          coinbase_address IS NOT NULL
        ORDER BY height DESC
      `);
      return blocks;
    } catch (e) {
      logger.err(`Cannot get blocks with missing coinbase addresses. Reason: ` + (e instanceof Error ? e.message : e));
      return [];
    }
  }

  /**
   * Save indexed median fee to avoid recomputing it later
   * 
   * @param id 
   * @param feePercentiles 
   */
  public async $saveFeePercentilesForBlockId(id: string, feePercentiles: number[]): Promise<void> {
    try {
      await DB.query(`
        UPDATE blocks SET fee_percentiles = ?, median_fee_amt = ?
        WHERE hash = ?`,
        [JSON.stringify(feePercentiles), feePercentiles[3], id]
      );
    } catch (e) {
      logger.err(`Cannot update block fee_percentiles. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Save indexed effective fee statistics
   * 
   * @param id 
   * @param feeStats 
   */
  public async $saveEffectiveFeeStats(id: string, feeStats: EffectiveFeeStats): Promise<void> {
    try {
      await DB.query(`
        UPDATE blocks SET median_fee = ?, fee_span = ?
        WHERE hash = ?`,
        [feeStats.medianFee, JSON.stringify(feeStats.feeRange), id]
      );
    } catch (e) {
      logger.err(`Cannot update block fee stats. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Save coinbase addresses
   * 
   * @param id
   * @param addresses
   */
  public async $saveCoinbaseAddresses(id: string, addresses: string[]): Promise<void> {
    try {
      await DB.query(`
        UPDATE blocks SET coinbase_addresses = ?
        WHERE hash = ?`,
        [JSON.stringify(addresses), id]
      );
    } catch (e) {
      logger.err(`Cannot update block coinbase addresses. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Save pool
   * 
   * @param id
   * @param poolId
   */
  public async $savePool(id: string, poolId: number): Promise<void> {
    try {
      await DB.query(`
        UPDATE blocks SET pool_id = ?, definition_hash = ?
        WHERE hash = ?`,
        [poolId, poolsUpdater.currentSha, id]
      );
    } catch (e) {
      logger.err(`Cannot update block pool. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Save block first seen time
   * 
   * @param id 
   */
  public async $saveFirstSeenTime(id: string, firstSeen: number): Promise<void> {
    try {
      await DB.query(`
        UPDATE blocks SET first_seen = FROM_UNIXTIME(?)
        WHERE hash = ?`,
        [firstSeen, id]
      );
    } catch (e) {
      logger.err(`Cannot update block first seen time. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Convert a mysql row block into a BlockExtended. Note that you
   * must provide the correct field into dbBlk object param
   * 
   * @param dbBlk 
   */
  private async formatDbBlockIntoExtendedBlock(dbBlk: DatabaseBlock): Promise<BlockExtended> {
    const blk: Partial<BlockExtended> = {};
    const extras: Partial<BlockExtension> = {};

    // IEsploraApi.Block
    blk.id = dbBlk.id;
    blk.height = dbBlk.height;
    blk.version = dbBlk.version;
    blk.timestamp = dbBlk.timestamp;
    blk.bits = dbBlk.bits;
    blk.nonce = dbBlk.nonce;
    blk.difficulty = dbBlk.difficulty;
    blk.merkle_root = dbBlk.merkle_root;
    blk.tx_count = dbBlk.tx_count;
    blk.size = dbBlk.size;
    blk.weight = dbBlk.weight;
    blk.previousblockhash = dbBlk.previousblockhash;
    blk.mediantime = dbBlk.mediantime;
    
    // BlockExtension
    extras.totalFees = dbBlk.totalFees;
    extras.medianFee = dbBlk.medianFee;
    extras.feeRange = JSON.parse(dbBlk.feeRange);
    extras.reward = dbBlk.reward;
    extras.pool = {
      id: dbBlk.poolId,
      name: dbBlk.poolName,
      slug: dbBlk.poolSlug,
      minerNames: null,
    };
    extras.avgFee = dbBlk.avgFee;
    extras.avgFeeRate = dbBlk.avgFeeRate;
    extras.coinbaseRaw = dbBlk.coinbaseRaw;
    extras.coinbaseAddress = dbBlk.coinbaseAddress;
    extras.coinbaseAddresses = dbBlk.coinbaseAddresses ? JSON.parse(dbBlk.coinbaseAddresses) : [];
    extras.coinbaseSignature = dbBlk.coinbaseSignature;
    extras.coinbaseSignatureAscii = dbBlk.coinbaseSignatureAscii;
    extras.avgTxSize = dbBlk.avgTxSize;
    extras.totalInputs = dbBlk.totalInputs;
    extras.totalOutputs = dbBlk.totalOutputs;
    extras.totalOutputAmt = dbBlk.totalOutputAmt;
    extras.medianFeeAmt = dbBlk.medianFeeAmt;
    extras.feePercentiles = JSON.parse(dbBlk.feePercentiles);
    extras.segwitTotalTxs = dbBlk.segwitTotalTxs;
    extras.segwitTotalSize = dbBlk.segwitTotalSize;
    extras.segwitTotalWeight = dbBlk.segwitTotalWeight;
    extras.header = dbBlk.header,
    extras.utxoSetChange = dbBlk.utxoSetChange;
    extras.utxoSetSize = dbBlk.utxoSetSize;
    extras.totalInputAmt = dbBlk.totalInputAmt;
    extras.virtualSize = dbBlk.weight / 4.0;
    extras.firstSeen = dbBlk.firstSeen;

    // Re-org can happen after indexing so we need to always get the
    // latest state from core
    extras.orphans = chainTips.getOrphanedBlocksAtHeight(dbBlk.height);

    // Match rate is not part of the blocks table, but it is part of APIs so we must include it
    extras.matchRate = null;
    extras.expectedFees = null;
    extras.expectedWeight = null;
    if (config.MEMPOOL.AUDIT) {
      const auditScore = await BlocksAuditsRepository.$getBlockAuditScore(dbBlk.id);
      if (auditScore != null) {
        extras.matchRate = auditScore.matchRate;
        extras.expectedFees = auditScore.expectedFees;
        extras.expectedWeight = auditScore.expectedWeight;
      }
    }

    // If we're missing block summary related field, check if we can populate them on the fly now
    // This is for example triggered upon re-org
    if (Common.blocksSummariesIndexingEnabled() &&
      (extras.medianFeeAmt === null || extras.feePercentiles === null))
    {
      extras.feePercentiles = await BlocksSummariesRepository.$getFeePercentilesByBlockId(dbBlk.id);
      if (extras.feePercentiles === null) {

        let summary;
        let summaryVersion = 0;
        if (config.MEMPOOL.BACKEND === 'esplora') {
          const txs = (await bitcoinApi.$getTxsForBlock(dbBlk.id)).map(tx => transactionUtils.extendTransaction(tx));
          summary = blocks.summarizeBlockTransactions(dbBlk.id, dbBlk.height, txs);
          summaryVersion = 1;
        } else {
          // Call Core RPC
          const block = await bitcoinClient.getBlock(dbBlk.id, 2);
          summary = blocks.summarizeBlock(block);
        }

        await BlocksSummariesRepository.$saveTransactions(dbBlk.height, dbBlk.id, summary.transactions, summaryVersion);
        extras.feePercentiles = await BlocksSummariesRepository.$getFeePercentilesByBlockId(dbBlk.id);
      }
      if (extras.feePercentiles !== null) {
        extras.medianFeeAmt = extras.feePercentiles[3];
        await this.$updateFeeAmounts(dbBlk.id, extras.feePercentiles, extras.medianFeeAmt);
      }
    }

    if (extras.pool.name === 'OCEAN') {
      extras.pool.minerNames = parseDATUMTemplateCreator(extras.coinbaseRaw);
    }

    blk.extras = <BlockExtension>extras;
    return <BlockExtended>blk;
  }
}

export default new BlocksRepository();
