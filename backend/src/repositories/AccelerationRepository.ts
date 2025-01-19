import { AccelerationInfo } from '../api/acceleration/acceleration';
import { RowDataPacket } from 'mysql2';
import DB from '../database';
import logger from '../logger';
import { IEsploraApi } from '../api/bitcoin/esplora-api.interface';
import { Common } from '../api/common';
import config from '../config';
import blocks from '../api/blocks';
import accelerationApi, { Acceleration, AccelerationHistory } from '../api/services/acceleration';
import accelerationCosts from '../api/acceleration/acceleration';
import bitcoinApi from '../api/bitcoin/bitcoin-api-factory';
import transactionUtils from '../api/transaction-utils';
import { BlockExtended, MempoolTransactionExtended } from '../mempool.interfaces';
import { makeBlockTemplate } from '../api/mini-miner';

export interface PublicAcceleration {
  txid: string,
  height: number,
  added: number,
  pool: {
    id: number,
    slug: string,
    name: string,
  },
  effective_vsize: number,
  effective_fee: number,
  boost_rate: number,
  boost_cost: number,
}

class AccelerationRepository {
  private bidBoostV2Activated = 831580;

  public async $saveAcceleration(acceleration: AccelerationInfo, block: IEsploraApi.Block, pool_id: number, accelerationData: Acceleration[]): Promise<void> {
    const accelerationMap: { [txid: string]: Acceleration } = {};
    for (const acc of accelerationData) {
      accelerationMap[acc.txid] = acc;
    }
    try {
      await DB.query(`
        INSERT INTO accelerations(txid, requested, added, height, pool, effective_vsize, effective_fee, boost_rate, boost_cost)
        VALUE (?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          height = ?
      `, [
        acceleration.txSummary.txid,
        accelerationMap[acceleration.txSummary.txid].added,
        block.timestamp,
        block.height,
        pool_id,
        acceleration.txSummary.effectiveVsize,
        acceleration.txSummary.effectiveFee,
        acceleration.targetFeeRate,
        acceleration.cost,
        block.height,
      ]);
    } catch (e: any) {
      logger.err(`Cannot save acceleration (${acceleration.txSummary.txid}) into db. Reason: ` + (e instanceof Error ? e.message : e));
      // We don't throw, not a critical issue if we miss some accelerations
    }
  }

  public async $getAccelerationInfo(poolSlug: string | null = null, height: number | null = null, interval: string | null = null): Promise<PublicAcceleration[]> {
    if (!interval || !['24h', '3d', '1w', '1m'].includes(interval)) {
      interval = '1m';
    }
    interval = Common.getSqlInterval(interval);

    if (!config.MEMPOOL_SERVICES.ACCELERATIONS || (interval == null && poolSlug == null && height == null)) {
      return [];
    }

    let query = `
      SELECT *, UNIX_TIMESTAMP(requested) as requested_timestamp, UNIX_TIMESTAMP(added) as block_timestamp FROM accelerations
      JOIN pools on pools.unique_id = accelerations.pool
    `;
    let params: any[] = [];
    let hasFilter = false;

    if (interval && height === null) {
      query += ` WHERE accelerations.added BETWEEN DATE_SUB(NOW(), INTERVAL ${interval}) AND NOW() `;
      hasFilter = true;
    }

    if (height != null) {
      if (hasFilter) {
        query += ` AND accelerations.height = ? `;
      } else {
        query += ` WHERE accelerations.height = ? `;
      }
      params.push(height);
    } else if (poolSlug != null) {
      if (hasFilter) {
        query += ` AND pools.slug = ? `;
      } else {
        query += ` WHERE pools.slug = ? `;
      }
      params.push(poolSlug);
    }

    query += ` ORDER BY accelerations.added DESC `;

    try {
      const [rows] = await DB.query(query, params) as RowDataPacket[][];
      if (rows?.length) {
        return rows.map(row => ({
          txid: row.txid,
          height: row.height,
          added: row.requested_timestamp || row.block_timestamp,
          pool: {
            id: row.id,
            slug: row.slug,
            name: row.name,
          },
          effective_vsize: row.effective_vsize,
          effective_fee: row.effective_fee,
          boost_rate: row.boost_rate,
          boost_cost: row.boost_cost,
        }));
      } else {
        return [];
      }
    } catch (e) {
      logger.err(`Cannot query acceleration info. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  public async $getAccelerationTotals(poolSlug: string | null = null, interval: string | null = null): Promise<{ cost: number, count: number }> {
    interval = Common.getSqlInterval(interval);

    if (!config.MEMPOOL_SERVICES.ACCELERATIONS) {
      return { cost: 0, count: 0 };
    }

    let query = `
      SELECT SUM(boost_cost) as total_cost, COUNT(txid) as count FROM accelerations
      JOIN pools on pools.unique_id = accelerations.pool
    `;
    let params: any[] = [];
    let hasFilter = false;

    if (interval) {
      query += ` WHERE accelerations.added BETWEEN DATE_SUB(NOW(), INTERVAL ${interval}) AND NOW() `;
      hasFilter = true;
    }
    if (poolSlug != null) {
      if (hasFilter) {
        query += ` AND pools.slug = ? `;
      } else {
        query += ` WHERE pools.slug = ? `;
      }
      params.push(poolSlug);
    }

    try {
      const [rows] = await DB.query(query, params) as RowDataPacket[][];
      return {
        cost: rows[0]?.total_cost || 0,
        count: rows[0]?.count || 0,
      };
    } catch (e) {
      logger.err(`Cannot query acceleration totals. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  public async $getLastSyncedHeight(): Promise<number> {
    try {
      const [rows] = await DB.query(`
        SELECT * FROM state
        WHERE name = 'last_acceleration_block'
      `);
      if (rows?.['length']) {
        return rows[0].number;
      }
    } catch (e: any) {
      logger.err(`Cannot find last acceleration sync height. Reason: ` + (e instanceof Error ? e.message : e));
    }
    return 0;
  }

  private async $setLastSyncedHeight(height: number): Promise<void> {
    try {
      await DB.query(`
        UPDATE state
        SET number = ?
        WHERE name = 'last_acceleration_block'
      `, [height]);
    } catch (e: any) {
      logger.err(`Cannot update last acceleration sync height. Reason: ` + (e instanceof Error ? e.message : e));
    }
  }

  // modifies block transactions
  public async $indexAccelerationsForBlock(block: BlockExtended, accelerations: Acceleration[], transactions: MempoolTransactionExtended[]): Promise<void> {
    const blockTxs: { [txid: string]: MempoolTransactionExtended } = {};
    for (const tx of transactions) {
      blockTxs[tx.txid] = tx;
    }
    const successfulAccelerations = accelerations.filter(acc => acc.pools.includes(block.extras.pool.id));
    let boostRate: number | null = null;
    for (const acc of successfulAccelerations) {
      if (boostRate === null) {
        boostRate = accelerationCosts.calculateBoostRate(
          accelerations.map(acc => ({ txid: acc.txid, max_bid: acc.feeDelta })),
          transactions
        );
      }
      if (blockTxs[acc.txid]) {
        const tx = blockTxs[acc.txid];
        const accelerationInfo = accelerationCosts.getAccelerationInfo(tx, boostRate, transactions);
        accelerationInfo.cost = Math.max(0, Math.min(acc.feeDelta, accelerationInfo.cost));
        this.$saveAcceleration(accelerationInfo, block, block.extras.pool.id, successfulAccelerations);
      }
    }
    let anyConfirmed = false;
    for (const acc of accelerations) {
      if (blockTxs[acc.txid]) {
        anyConfirmed = true;
      }
    }
    if (anyConfirmed) {
      accelerationApi.accelerationConfirmed();
    }
    const lastSyncedHeight = await this.$getLastSyncedHeight();
    // if we've missed any blocks, let the indexer catch up from the last synced height on the next run
    if (block.height === lastSyncedHeight + 1) {
      await this.$setLastSyncedHeight(block.height);
    }
  }

  /**
   * [INDEXING] Backfill missing acceleration data
   */
  async $indexPastAccelerations(): Promise<void> {
    if (config.MEMPOOL.NETWORK !== 'mainnet' || !config.MEMPOOL_SERVICES.ACCELERATIONS) {
      // acceleration history disabled
      return;
    }
    const lastSyncedHeight = await this.$getLastSyncedHeight();
    const currentHeight = blocks.getCurrentBlockHeight();
    if (currentHeight <= lastSyncedHeight) {
      // already in sync
      return;
    }

    logger.debug(`Fetching accelerations between block ${lastSyncedHeight} and ${currentHeight}`);

    // Fetch accelerations from mempool.space since the last synced block;
    const accelerationsByBlock: {[height: number]: AccelerationHistory[]} = {};
    const blockHashes = {};
    let done = false;
    let page = 1;
    let count = 0;
    try {
      while (!done) {
        // don't DDoS the services backend
        Common.sleep$(500 + (Math.random() * 1000));
        const accelerations = await accelerationApi.$fetchAccelerationHistory(page);
        page++;
        if (!accelerations?.length) {
          done = true;
          break;
        }
        for (const acc of accelerations) {
          if (acc.status !== 'completed_provisional' && acc.status !== 'completed') {
            continue;
          }
          if (!lastSyncedHeight || acc.blockHeight > lastSyncedHeight) {
            if (!accelerationsByBlock[acc.blockHeight]) {
              accelerationsByBlock[acc.blockHeight] = [];
              blockHashes[acc.blockHeight] = acc.blockHash;
            }
            accelerationsByBlock[acc.blockHeight].push(acc);
            count++;
          } else {
            done = true;
          }
        }
      }
    } catch (e) {
      logger.err(`Failed to fetch full acceleration history. Reason: ` + (e instanceof Error ? e.message : e));
    }

    logger.debug(`Indexing ${count} accelerations between block ${lastSyncedHeight} and ${currentHeight}`);

    // process accelerated blocks in order
    const heights = Object.keys(accelerationsByBlock).map(key => parseInt(key)).sort((a,b) => a - b);
    for (const height of heights) {
      const accelerations = accelerationsByBlock[height];
      try {
        const block = await blocks.$getBlock(blockHashes[height]) as BlockExtended;
        const transactions = (await bitcoinApi.$getTxsForBlock(blockHashes[height])).map(tx => transactionUtils.extendMempoolTransaction(tx));

        const blockTxs = {};
        for (const tx of transactions) {
          blockTxs[tx.txid] = tx;
        }

        let boostRate = 0;
        // use Bid Boost V2 if active
        if (height > this.bidBoostV2Activated) {
          boostRate = accelerationCosts.calculateBoostRate(
            accelerations.map(acc => ({ txid: acc.txid, max_bid: acc.feeDelta })),
            transactions
          );
        } else {
          // default to Bid Boost V1 (median block fee rate)
          const template = makeBlockTemplate(
            transactions,
            accelerations.map(acc => ({ txid: acc.txid, max_bid: acc.feeDelta })),
            1,
            Infinity,
            Infinity
          );
          const feeStats = Common.calcEffectiveFeeStatistics(template);
          boostRate = feeStats.effective_median;
        }
        const accelerationSummaries = accelerations.map(acc => ({
          ...acc,
          pools: acc.pools,
        }));
        for (const acc of accelerations) {
          if (blockTxs[acc.txid] && acc.pools.includes(block.extras.pool.id)) {
            const tx = blockTxs[acc.txid];
            const accelerationInfo = accelerationCosts.getAccelerationInfo(tx, boostRate, transactions);
            accelerationInfo.cost = Math.max(0, Math.min(acc.feeDelta, accelerationInfo.cost));
            await this.$saveAcceleration(accelerationInfo, block, block.extras.pool.id, accelerationSummaries);
          }
        }
        await this.$setLastSyncedHeight(height);
      } catch (e) {
        logger.err(`Failed to process accelerations for block ${height}. Reason: ` + (e instanceof Error ? e.message : e));
        return;
      }
      logger.debug(`Indexed ${accelerations.length} accelerations in block  ${height}`);
    }

    await this.$setLastSyncedHeight(currentHeight);

    logger.debug(`Indexing accelerations completed`);
  }

  /**
   * Delete accelerations from the database above blockHeight
   */
  public async $deleteAccelerationsFrom(blockHeight: number): Promise<void> {
    logger.info(`Delete newer accelerations from height ${blockHeight} from the database`);
    try {
      const currentSyncedHeight = await this.$getLastSyncedHeight();
      if (currentSyncedHeight >= blockHeight) {
        await DB.query(`
          UPDATE state
          SET number = ?
          WHERE name = 'last_acceleration_block'
        `, [blockHeight - 1]);
      }
      await DB.query(`DELETE FROM accelerations where height >= ${blockHeight}`);
    } catch (e) {
      logger.err('Cannot delete indexed accelerations. Reason: ' + (e instanceof Error ? e.message : e));
    }
  }
}

export default new AccelerationRepository();
