import { GbtGenerator, GbtResult, ThreadTransaction as RustThreadTransaction, ThreadAcceleration as RustThreadAcceleration } from 'rust-gbt';
import logger from '../logger';
import { MempoolBlock, MempoolTransactionExtended, MempoolBlockWithTransactions, MempoolBlockDelta, Ancestor, CompactThreadTransaction, FeeStats, TransactionClassified, TransactionCompressed, MempoolDeltaChange, GbtCandidates, PoolTag, EffectiveFeeStats } from '../mempool.interfaces';
import { Common, OnlineFeeStatsCalculator } from './common';
import config from '../config';
import { Worker } from 'worker_threads';
import path from 'path';
import mempool from './mempool';
import { Acceleration } from './services/acceleration';
import PoolsRepository from '../repositories/PoolsRepository';

const MAX_UINT32 = Math.pow(2, 32) - 1;

class MempoolBlocks {
  private mempoolBlocks: MempoolBlockWithTransactions[] = [];
  private mempoolBlockDeltas: MempoolBlockDelta[] = [];
  private txSelectionWorker: Worker | null = null;
  private rustInitialized: boolean = false;
  private rustGbtGenerator: GbtGenerator = new GbtGenerator(config.MEMPOOL.BLOCK_WEIGHT_UNITS, config.MEMPOOL.MEMPOOL_BLOCKS_AMOUNT);

  private nextUid: number = 1;
  private uidMap: Map<number, string> = new Map(); // map short numerical uids to full txids
  private txidMap: Map<string, number> = new Map(); // map full txids back to short numerical uids

  private pools: { [id: number]: PoolTag } = {};

  public getMempoolBlocks(): MempoolBlock[] {
    return this.mempoolBlocks.map((block) => {
      return {
        blockSize: block.blockSize,
        blockVSize: block.blockVSize,
        nTx: block.nTx,
        totalFees: block.totalFees,
        medianFee: block.medianFee,
        feeRange: block.feeRange,
        effectiveMedianFee: block.effectiveMedianFee,
        effectiveFeeRange: block.effectiveFeeRange,
      };
    });
  }

  public getMempoolBlocksWithTransactions(): MempoolBlockWithTransactions[] {
    return this.mempoolBlocks;
  }

  public getMempoolBlockDeltas(): MempoolBlockDelta[] {
    return this.mempoolBlockDeltas;
  }

  public async updatePools$(): Promise<void> {
    if (['mainnet', 'testnet', 'signet'].includes(config.MEMPOOL.NETWORK) === false) {
      this.pools = {};
      return;
    }
    const allPools = await PoolsRepository.$getPools();
    this.pools = {};
    for (const pool of allPools) {
      this.pools[pool.uniqueId] = pool;
    }
  }

  private calculateMempoolDeltas(prevBlocks: MempoolBlockWithTransactions[], mempoolBlocks: MempoolBlockWithTransactions[]): MempoolBlockDelta[] {
    const mempoolBlockDeltas: MempoolBlockDelta[] = [];
    for (let i = 0; i < Math.max(mempoolBlocks.length, prevBlocks.length); i++) {
      let added: TransactionClassified[] = [];
      let removed: string[] = [];
      const changed: TransactionClassified[] = [];
      if (mempoolBlocks[i] && !prevBlocks[i]) {
        added = mempoolBlocks[i].transactions;
      } else if (!mempoolBlocks[i] && prevBlocks[i]) {
        removed = prevBlocks[i].transactions.map(tx => tx.txid);
      } else if (mempoolBlocks[i] && prevBlocks[i]) {
        const prevIds = {};
        const newIds = {};
        prevBlocks[i].transactions.forEach(tx => {
          prevIds[tx.txid] = tx;
        });
        mempoolBlocks[i].transactions.forEach(tx => {
          newIds[tx.txid] = true;
        });
        prevBlocks[i].transactions.forEach(tx => {
          if (!newIds[tx.txid]) {
            removed.push(tx.txid);
          }
        });
        mempoolBlocks[i].transactions.forEach(tx => {
          if (!prevIds[tx.txid]) {
            added.push(tx);
          } else if (tx.rate !== prevIds[tx.txid].rate || tx.acc !== prevIds[tx.txid].acc) {
            changed.push(tx);
          }
        });
      }
      mempoolBlockDeltas.push({
        added: added.map(this.compressTx),
        removed,
        changed: changed.map(this.compressDeltaChange),
      });
    }
    return mempoolBlockDeltas;
  }

  public async $makeBlockTemplates(transactions: string[], newMempool: { [txid: string]: MempoolTransactionExtended }, candidates: GbtCandidates | undefined, saveResults: boolean = false, useAccelerations: boolean = false, accelerationPool?: number): Promise<MempoolBlockWithTransactions[]> {
    const start = Date.now();

    // reset mempool short ids
    if (saveResults) {
      this.resetUids();
    }
    // set missing short ids
    for (const txid of transactions) {
      const tx = newMempool[txid];
      this.setUid(tx, !saveResults);
    }

    const accelerations = useAccelerations ? mempool.getAccelerations() : {};

    // prepare a stripped down version of the mempool with only the minimum necessary data
    // to reduce the overhead of passing this data to the worker thread
    const strippedMempool: Map<number, CompactThreadTransaction> = new Map();
    for (const txid of transactions) {
      const entry = newMempool[txid];
      if (entry.uid !== null && entry.uid !== undefined) {
        const stripped = {
          uid: entry.uid,
          fee: entry.fee + (useAccelerations && (!accelerationPool || accelerations[entry.txid]?.pools?.includes(accelerationPool)) ? (accelerations[entry.txid]?.feeDelta || 0) : 0),
          weight: (entry.adjustedVsize * 4),
          sigops: entry.sigops,
          feePerVsize: entry.adjustedFeePerVsize || entry.feePerVsize,
          effectiveFeePerVsize: entry.effectiveFeePerVsize || entry.adjustedFeePerVsize || entry.feePerVsize,
          inputs: entry.vin.map(v => this.getUid(newMempool[v.txid])).filter(uid => (uid !== null && uid !== undefined)) as number[],
        };
        strippedMempool.set(entry.uid, stripped);
      }
    }

    // (re)initialize tx selection worker thread
    if (!this.txSelectionWorker) {
      this.txSelectionWorker = new Worker(path.resolve(__dirname, './tx-selection-worker.js'));
      // if the thread throws an unexpected error, or exits for any other reason,
      // reset worker state so that it will be re-initialized on the next run
      this.txSelectionWorker.once('error', () => {
        this.txSelectionWorker = null;
      });
      this.txSelectionWorker.once('exit', () => {
        this.txSelectionWorker = null;
      });
    }

    // run the block construction algorithm in a separate thread, and wait for a result
    let threadErrorListener;
    try {
      const workerResultPromise = new Promise<{ blocks: number[][], rates: Map<number, number>, clusters: Map<number, number[]> }>((resolve, reject) => {
        threadErrorListener = reject;
        this.txSelectionWorker?.once('message', (result): void => {
          resolve(result);
        });
        this.txSelectionWorker?.once('error', reject);
      });
      this.txSelectionWorker.postMessage({ type: 'set', mempool: strippedMempool });
      const { blocks, rates, clusters } = this.convertResultTxids(await workerResultPromise);

      // clean up thread error listener
      this.txSelectionWorker?.removeListener('error', threadErrorListener);

      const processed = this.processBlockTemplates(newMempool, blocks, null, Object.entries(rates), Object.values(clusters), candidates, accelerations, accelerationPool, saveResults);

      logger.debug(`makeBlockTemplates completed in ${(Date.now() - start)/1000} seconds`);

      return processed;
    } catch (e) {
      logger.err('makeBlockTemplates failed. ' + (e instanceof Error ? e.message : e));
    }
    return this.mempoolBlocks;
  }

  public async $updateBlockTemplates(transactions: string[], newMempool: { [txid: string]: MempoolTransactionExtended }, added: MempoolTransactionExtended[], removed: MempoolTransactionExtended[], candidates: GbtCandidates | undefined, accelerationDelta: string[] = [], saveResults: boolean = false, useAccelerations: boolean = false): Promise<void> {
    if (!this.txSelectionWorker) {
      // need to reset the worker
      await this.$makeBlockTemplates(transactions, newMempool, candidates, saveResults, useAccelerations);
      return;
    }

    const start = Date.now();

    const accelerations = useAccelerations ? mempool.getAccelerations() : {};
    const addedAndChanged: MempoolTransactionExtended[] = useAccelerations ? accelerationDelta.map(txid => newMempool[txid]).filter(tx => tx != null).concat(added) : added;

    for (const tx of addedAndChanged) {
      this.setUid(tx, false);
    }
    const removedTxs = removed.filter(tx => tx.uid != null) as MempoolTransactionExtended[];

    // prepare a stripped down version of the mempool with only the minimum necessary data
    // to reduce the overhead of passing this data to the worker thread
    const addedStripped: CompactThreadTransaction[] = addedAndChanged.filter(entry => entry.uid != null).map(entry => {
      return {
        uid: entry.uid || 0,
        fee: entry.fee + (useAccelerations ? (accelerations[entry.txid]?.feeDelta || 0) : 0),
        weight: (entry.adjustedVsize * 4),
        sigops: entry.sigops,
        feePerVsize: entry.adjustedFeePerVsize || entry.feePerVsize,
        effectiveFeePerVsize: entry.effectiveFeePerVsize || entry.adjustedFeePerVsize || entry.feePerVsize,
        inputs: entry.vin.map(v => this.getUid(newMempool[v.txid])).filter(uid => (uid !== null && uid !== undefined)) as number[],
      };
    });

    // run the block construction algorithm in a separate thread, and wait for a result
    let threadErrorListener;
    try {
      const workerResultPromise = new Promise<{ blocks: number[][], rates: Map<number, number>, clusters: Map<number, number[]> }>((resolve, reject) => {
        threadErrorListener = reject;
        this.txSelectionWorker?.once('message', (result): void => {
          resolve(result);
        });
        this.txSelectionWorker?.once('error', reject);
      });
      this.txSelectionWorker.postMessage({ type: 'update', added: addedStripped, removed: removedTxs.map(tx => tx.uid) as number[] });
      const { blocks, rates, clusters } = this.convertResultTxids(await workerResultPromise);

      this.removeUids(removedTxs);

      // clean up thread error listener
      this.txSelectionWorker?.removeListener('error', threadErrorListener);

      this.processBlockTemplates(newMempool, blocks, null, Object.entries(rates), Object.values(clusters), candidates, accelerations, null, saveResults);
      logger.debug(`updateBlockTemplates completed in ${(Date.now() - start) / 1000} seconds`);
    } catch (e) {
      logger.err('updateBlockTemplates failed. ' + (e instanceof Error ? e.message : e));
    }
  }

  private resetRustGbt(): void {
    this.rustInitialized = false;
    this.rustGbtGenerator = new GbtGenerator(config.MEMPOOL.BLOCK_WEIGHT_UNITS, config.MEMPOOL.MEMPOOL_BLOCKS_AMOUNT);
  }

  public async $rustMakeBlockTemplates(txids: string[], newMempool: { [txid: string]: MempoolTransactionExtended }, candidates: GbtCandidates | undefined, saveResults: boolean = false, useAccelerations: boolean = false, accelerationPool?: number): Promise<MempoolBlockWithTransactions[]> {
    const start = Date.now();

    // reset mempool short ids
    if (saveResults) {
      this.resetUids();
    }

    const transactions = txids.map(txid => newMempool[txid]).filter(tx => tx != null);
    // set missing short ids
    for (const tx of transactions) {
      this.setUid(tx, !saveResults);
    }
    // set short ids for transaction inputs
    for (const tx of transactions) {
      tx.inputs = tx.vin.map(v => this.getUid(newMempool[v.txid])).filter(uid => (uid !== null && uid !== undefined)) as number[];
    }

    const accelerations = useAccelerations ? mempool.getAccelerations() : {};
    const acceleratedList = accelerationPool ? Object.values(accelerations).filter(acc => newMempool[acc.txid] && acc.pools.includes(accelerationPool)) : Object.values(accelerations).filter(acc => newMempool[acc.txid]);
    const convertedAccelerations = acceleratedList.map(acc => {
      this.setUid(newMempool[acc.txid], true);
      return {
        uid: this.getUid(newMempool[acc.txid]),
        delta: acc.feeDelta,
      };
    });

    // run the block construction algorithm in a separate thread, and wait for a result
    const rustGbt = saveResults ? this.rustGbtGenerator : new GbtGenerator(config.MEMPOOL.BLOCK_WEIGHT_UNITS, config.MEMPOOL.MEMPOOL_BLOCKS_AMOUNT);
    try {
      const { blocks, blockWeights, rates, clusters, overflow } = this.convertNapiResultTxids(
        await rustGbt.make(transactions as RustThreadTransaction[], convertedAccelerations as RustThreadAcceleration[], this.nextUid),
      );
      if (saveResults) {
        this.rustInitialized = true;
      }
      const expectedSize = transactions.length;
      const resultMempoolSize = blocks.reduce((total, block) => total + block.length, 0) + overflow.length;
      logger.debug(`RUST updateBlockTemplates returned ${resultMempoolSize} txs out of ${expectedSize} in the mempool, ${overflow.length} were unmineable`);
      const processed = this.processBlockTemplates(newMempool, blocks, blockWeights, rates, clusters, candidates, accelerations, accelerationPool, saveResults);
      logger.debug(`RUST makeBlockTemplates completed in ${(Date.now() - start)/1000} seconds`);
      return processed;
    } catch (e) {
      logger.err('RUST makeBlockTemplates failed. ' + (e instanceof Error ? e.message : e));
      if (saveResults) {
        this.resetRustGbt();
      }
    }
    return this.mempoolBlocks;
  }

  public async $oneOffRustBlockTemplates(transactions: string[], newMempool: { [txid: string]: MempoolTransactionExtended }, candidates: GbtCandidates | undefined, useAccelerations: boolean, accelerationPool?: number): Promise<MempoolBlockWithTransactions[]> {
    return this.$rustMakeBlockTemplates(transactions, newMempool, candidates, false, useAccelerations, accelerationPool);
  }

  public async $rustUpdateBlockTemplates(transactions: string[], newMempool: { [txid: string]: MempoolTransactionExtended }, added: MempoolTransactionExtended[], removed: MempoolTransactionExtended[], candidates: GbtCandidates | undefined, useAccelerations: boolean, accelerationPool?: number): Promise<MempoolBlockWithTransactions[]> {
    // GBT optimization requires that uids never get too sparse
    // as a sanity check, we should also explicitly prevent uint32 uid overflow
    if (this.nextUid + added.length >= Math.min(Math.max(262144, 2 * transactions.length), MAX_UINT32)) {
      this.resetRustGbt();
    }

    if (!this.rustInitialized) {
      // need to reset the worker
      return this.$rustMakeBlockTemplates(transactions, newMempool, candidates, true, useAccelerations, accelerationPool);
    }

    const start = Date.now();
    // set missing short ids
    for (const tx of added) {
      this.setUid(tx, false);
    }
    // set short ids for transaction inputs
    for (const tx of added) {
      tx.inputs = tx.vin.map(v => this.getUid(newMempool[v.txid])).filter(uid => (uid !== null && uid !== undefined)) as number[];
    }
    const removedTxs = removed.filter(tx => tx.uid != null) as MempoolTransactionExtended[];

    const accelerations = useAccelerations ? mempool.getAccelerations() : {};
    const acceleratedList = accelerationPool ? Object.values(accelerations).filter(acc => newMempool[acc.txid] && acc.pools.includes(accelerationPool)) : Object.values(accelerations).filter(acc => newMempool[acc.txid]);
    const convertedAccelerations = acceleratedList.map(acc => {
      this.setUid(newMempool[acc.txid], true);
      return {
        uid: this.getUid(newMempool[acc.txid]),
        delta: acc.feeDelta,
      };
    });

    // run the block construction algorithm in a separate thread, and wait for a result
    try {
      const { blocks, blockWeights, rates, clusters, overflow } = this.convertNapiResultTxids(
        await this.rustGbtGenerator.update(
          added as RustThreadTransaction[],
          removedTxs.map(tx => tx.uid) as number[],
          convertedAccelerations as RustThreadAcceleration[],
          this.nextUid,
        ),
      );
      const resultMempoolSize = blocks.reduce((total, block) => total + block.length, 0) + overflow.length;
      logger.debug(`RUST updateBlockTemplates returned ${resultMempoolSize} txs out of ${transactions.length} candidates, ${overflow.length} were unmineable`);
      if (transactions.length !== resultMempoolSize) {
        throw new Error(`GBT returned wrong number of transactions ${transactions.length} vs ${resultMempoolSize}, cache is probably out of sync`);
      } else {
        const processed = this.processBlockTemplates(newMempool, blocks, blockWeights, rates, clusters, candidates, accelerations, accelerationPool, true);
        this.removeUids(removedTxs);
        logger.debug(`RUST updateBlockTemplates completed in ${(Date.now() - start)/1000} seconds`);
        return processed;
      }
    } catch (e) {
      logger.err('RUST updateBlockTemplates failed. ' + (e instanceof Error ? e.message : e));
      this.resetRustGbt();
      return this.mempoolBlocks;
    }
  }

  private processBlockTemplates(mempool: { [txid: string]: MempoolTransactionExtended }, blocks: string[][], blockWeights: number[] | null, rates: [string, number][], clusters: string[][], candidates: GbtCandidates | undefined, accelerations: { [txid: string]: Acceleration }, accelerationPool, saveResults): MempoolBlockWithTransactions[] {
    for (const txid of Object.keys(candidates?.txs ?? mempool)) {
      if (txid in mempool) {
        mempool[txid].cpfpDirty = false;
        mempool[txid].ancestors = [];
        mempool[txid].descendants = [];
        mempool[txid].bestDescendant = null;
      }
    }
    for (const [txid, rate] of rates) {
      if (txid in mempool) {
        mempool[txid].cpfpDirty = (rate !== mempool[txid].effectiveFeePerVsize);
        mempool[txid].effectiveFeePerVsize = rate;
        mempool[txid].cpfpChecked = true;
      }
    }

    const lastBlockIndex = blocks.length - 1;
    let hasBlockStack = blocks.length >= 8;
    let stackWeight;
    let feeStatsCalculator: OnlineFeeStatsCalculator | null = null;
    if (hasBlockStack) {
      if (blockWeights && blockWeights[7] !== null) {
        stackWeight = blockWeights[7];
      } else {
        stackWeight = blocks[lastBlockIndex].reduce((total, tx) => total + (mempool[tx]?.weight || 0), 0);
      }
      hasBlockStack = stackWeight > config.MEMPOOL.BLOCK_WEIGHT_UNITS;
      feeStatsCalculator = new OnlineFeeStatsCalculator(stackWeight, 0.5, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
    }

    const ancestors: Ancestor[] = [];
    const descendants: Ancestor[] = [];
    let ancestor: MempoolTransactionExtended;
    for (const cluster of clusters) {
      for (const memberTxid of cluster) {
        const mempoolTx = mempool[memberTxid];
        if (mempoolTx) {
          // ugly micro-optimization to avoid allocating new arrays
          ancestors.length = 0;
          descendants.length = 0;
          let matched = false;
          cluster.forEach(txid => {
            ancestor = mempool[txid];
            if (txid === memberTxid) {
              matched = true;
            } else {
              if (!ancestor) {
                console.log('txid missing from mempool! ', txid, candidates?.txs[txid]);
                return;
              }
              const relative = {
                txid: txid,
                fee: ancestor.fee,
                weight: (ancestor.adjustedVsize * 4),
              };
              if (matched) {
                descendants.push(relative);
                if (!mempoolTx.lastBoosted || (ancestor.firstSeen && ancestor.firstSeen > mempoolTx.lastBoosted)) {
                  mempoolTx.lastBoosted = ancestor.firstSeen;
                }
              } else {
                ancestors.push(relative);
              }
            }
          });
          if (mempoolTx.ancestors?.length !== ancestors.length || mempoolTx.descendants?.length !== descendants.length) {
            mempoolTx.cpfpDirty = true;
          }
          // ugly micro-optimization to avoid allocating new arrays or objects
          if (mempoolTx.ancestors) {
            mempoolTx.ancestors.length = 0;
          } else {
            mempoolTx.ancestors = [];
          }
          if (mempoolTx.descendants) {
            mempoolTx.descendants.length = 0;
          } else {
            mempoolTx.descendants = [];
          }
          mempoolTx.ancestors.push(...ancestors);
          mempoolTx.descendants.push(...descendants);
          mempoolTx.cpfpChecked = true;
        }
      }
    }

    const isAcceleratedBy : { [txid: string]: number[] | false } = {};

    const sizeLimit = (config.MEMPOOL.BLOCK_WEIGHT_UNITS / 4) * 1.2;
    // update this thread's mempool with the results
    let mempoolTx: MempoolTransactionExtended;
    let acceleration: Acceleration;
    const mempoolBlocks: MempoolBlockWithTransactions[] = [];
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex];
      let totalSize = 0;
      let totalVsize = 0;
      let totalWeight = 0;
      let totalFees = 0;
      const transactions: MempoolTransactionExtended[] = [];

      // backfill purged transactions
      if (candidates?.txs && blockIndex === blocks.length - 1) {
        for (const txid of Object.keys(mempool)) {
          if (!candidates.txs[txid]) {
            block.push(txid);
          }
        }
      }

      for (let i = 0; i < block.length; i++) {
        const txid = block[i];
        if (txid in mempool) {
          mempoolTx = mempool[txid];
          // save position in projected blocks
          mempoolTx.position = {
            block: blockIndex,
            vsize: totalVsize + (mempoolTx.vsize / 2),
          };

          if (txid in accelerations) {
            acceleration = accelerations[txid];
            if (isAcceleratedBy[txid] || (acceleration && (!accelerationPool || acceleration.pools.includes(accelerationPool)))) {
              if (!mempoolTx.acceleration) {
                mempoolTx.cpfpDirty = true;
              }
              mempoolTx.acceleration = true;
              mempoolTx.acceleratedBy = isAcceleratedBy[txid] || acceleration?.pools;
              mempoolTx.acceleratedAt = acceleration?.added;
              mempoolTx.feeDelta = acceleration?.feeDelta;
              for (const ancestor of mempoolTx.ancestors || []) {
                if (!(ancestor.txid in mempool)) {
                  continue;
                }
                if (!mempool[ancestor.txid].acceleration) {
                  mempool[ancestor.txid].cpfpDirty = true;
                }
                mempool[ancestor.txid].acceleration = true;
                mempool[ancestor.txid].acceleratedBy = mempoolTx.acceleratedBy;
                mempool[ancestor.txid].acceleratedAt = mempoolTx.acceleratedAt;
                mempool[ancestor.txid].feeDelta = mempoolTx.feeDelta;
                isAcceleratedBy[ancestor.txid] = mempoolTx.acceleratedBy;
              }
            } else {
              if (mempoolTx.acceleration) {
                mempoolTx.cpfpDirty = true;
                delete mempoolTx.acceleration;
              }
            }
          } else {
            if (mempoolTx.acceleration) {
              mempoolTx.cpfpDirty = true;
              delete mempoolTx.acceleration;
            }
          }

          // online calculation of stack-of-blocks fee stats
          if (hasBlockStack && blockIndex === lastBlockIndex && feeStatsCalculator) {
            feeStatsCalculator.processNext(mempoolTx);
          }

          totalSize += mempoolTx.size;
          totalVsize += mempoolTx.vsize;
          totalWeight += mempoolTx.weight;
          totalFees += mempoolTx.fee;

          if (totalVsize <= sizeLimit) {
            transactions.push(mempoolTx);
          }
        }
      }
      mempoolBlocks[blockIndex] = this.dataToMempoolBlocks(
        block,
        transactions,
        totalSize,
        totalWeight,
        totalFees,
        (hasBlockStack && blockIndex === lastBlockIndex && feeStatsCalculator) ? feeStatsCalculator.getFeeStats() : undefined,
      );
    };

    if (saveResults) {
      const deltas = this.calculateMempoolDeltas(this.mempoolBlocks, mempoolBlocks);
      this.mempoolBlocks = mempoolBlocks;
      this.mempoolBlockDeltas = deltas;
      this.updateAccelerationPositions(mempool, accelerations, mempoolBlocks);
    }

    return mempoolBlocks;
  }

  private dataToMempoolBlocks(transactionIds: string[], transactions: MempoolTransactionExtended[], totalSize: number, totalWeight: number, totalFees: number, effectiveFeeStats?: EffectiveFeeStats ): MempoolBlockWithTransactions {
    const feeStats = Common.calcFeeStatistics(transactions);
    if (!effectiveFeeStats) {
      effectiveFeeStats = Common.calcEffectiveFeeStatistics(transactions);
    }
    return {
      blockSize: totalSize,
      blockVSize: (totalWeight / 4), // fractional vsize to avoid rounding errors
      nTx: transactionIds.length,
      totalFees: totalFees,
      medianFee: feeStats.median,
      feeRange: feeStats.range,
      effectiveMedianFee: effectiveFeeStats.effective_median,
      effectiveFeeRange: effectiveFeeStats.effective_range,
      transactionIds: transactionIds,
      transactions: transactions.map((tx) => Common.classifyTransaction(tx)),
    };
  }

  private resetUids(): void {
    this.uidMap.clear();
    this.txidMap.clear();
    this.nextUid = 1;
  }

  private setUid(tx: MempoolTransactionExtended, skipSet = false): number {
    if (!this.txidMap.has(tx.txid) || !skipSet) {
      const uid = this.nextUid;
      this.nextUid++;
      this.uidMap.set(uid, tx.txid);
      this.txidMap.set(tx.txid, uid);
      tx.uid = uid;
      return uid;
    } else {
      tx.uid = this.txidMap.get(tx.txid) as number;
      return tx.uid;
    }
  }

  private getUid(tx: MempoolTransactionExtended): number | void {
    if (tx) {
      return this.txidMap.get(tx.txid);
    }
  }

  private removeUids(txs: MempoolTransactionExtended[]): void {
    for (const tx of txs) {
      const uid = this.txidMap.get(tx.txid);
      if (uid != null) {
        this.uidMap.delete(uid);
        this.txidMap.delete(tx.txid);
      }
      tx.uid = undefined;
    }
  }

  private convertResultTxids({ blocks, rates, clusters }: { blocks: number[][], rates: Map<number, number>, clusters: Map<number, number[]>})
    : { blocks: string[][], rates: { [root: string]: number }, clusters: { [root: string]: string[] }} {
    const convertedBlocks: string[][] = blocks.map(block => block.map(uid => {
      return this.uidMap.get(uid) || '';
    }));
    const convertedRates = {};
    for (const rateUid of rates.keys()) {
      const rateTxid = this.uidMap.get(rateUid);
      if (rateTxid) {
        convertedRates[rateTxid] = rates.get(rateUid);
      }
    }
    const convertedClusters = {};
    for (const rootUid of clusters.keys()) {
      const rootTxid = this.uidMap.get(rootUid);
      if (rootTxid) {
        const members = clusters.get(rootUid)?.map(uid => {
          return this.uidMap.get(uid);
        });
        convertedClusters[rootTxid] = members;
      }
    }
    return { blocks: convertedBlocks, rates: convertedRates, clusters: convertedClusters } as { blocks: string[][], rates: { [root: string]: number }, clusters: { [root: string]: string[] }};
  }

  private convertNapiResultTxids({ blocks, blockWeights, rates, clusters, overflow }: GbtResult)
    : { blocks: string[][], blockWeights: number[], rates: [string, number][], clusters: string[][], overflow: string[] } {
    const convertedBlocks: string[][] = blocks.map(block => block.map(uid => {
      const txid = this.uidMap.get(uid);
      if (txid !== undefined) {
        return txid;
      } else {
        throw new Error('GBT returned a block containing a transaction with unknown uid');
      }
    }));
    const convertedRates: [string, number][] = [];
    for (const [rateUid, rate] of rates) {
      const rateTxid = this.uidMap.get(rateUid) as string;
      convertedRates.push([rateTxid, rate]);
    }
    const convertedClusters: string[][] = [];
    for (const cluster of clusters) {
      convertedClusters.push(cluster.map(uid => this.uidMap.get(uid)) as string[]);
    }
    const convertedOverflow: string[] = overflow.map(uid => {
      const txid = this.uidMap.get(uid);
      if (txid !== undefined) {
        return txid;
      } else {
        throw new Error('GBT returned an unmineable transaction with unknown uid');
      }
    });
    return { blocks: convertedBlocks, blockWeights, rates: convertedRates, clusters: convertedClusters, overflow: convertedOverflow };
  }

  public compressTx(tx: TransactionClassified): TransactionCompressed {
    if (tx.acc) {
      return [
        tx.txid,
        tx.fee,
        tx.vsize,
        tx.value,
        Math.round((tx.rate || (tx.fee / tx.vsize)) * 100) / 100,
        tx.flags,
        tx.time || 0,
        1,
      ];
    } else {
      return [
        tx.txid,
        tx.fee,
        tx.vsize,
        tx.value,
        Math.round((tx.rate || (tx.fee / tx.vsize)) * 100) / 100,
        tx.flags,
        tx.time || 0,
      ];
    }
  }

  public compressDeltaChange(tx: TransactionClassified): MempoolDeltaChange {
    return [
      tx.txid,
      Math.round((tx.rate || (tx.fee / tx.vsize)) * 100) / 100,
      tx.flags,
      tx.acc ? 1 : 0,
    ];
  }

  // estimates and saves positions of accelerations in mining partner mempools
  private updateAccelerationPositions(mempoolCache: { [txid: string]: MempoolTransactionExtended }, accelerations: { [txid: string]: Acceleration }, mempoolBlocks: MempoolBlockWithTransactions[]): void {
    const accelerationPositions: { [txid: string]: { poolId: number, pool: string, block: number, vsize: number }[] } = {};
    // keep track of simulated mempool blocks for each active pool
    const pools: {
      [pool: string]: { name: string, block: number, vsize: number, accelerations: string[], complete: boolean };
    } = {};
    // prepare a list of accelerations in ascending order (we'll pop items off the end of the list)
    const accQueue: { acceleration: Acceleration, rate: number, vsize: number }[] = Object.values(accelerations).filter(acc => acc.txid in mempoolCache).map(acc => {
      let vsize = mempoolCache[acc.txid].vsize;
      for (const ancestor of mempoolCache[acc.txid].ancestors || []) {
        vsize += (ancestor.weight / 4);
      }
      return {
        acceleration: acc,
        rate: mempoolCache[acc.txid].effectiveFeePerVsize,
        vsize
      };
    }).sort((a, b) => a.rate - b.rate);
    // initialize the pool tracker
    for (const { acceleration }  of accQueue) {
      accelerationPositions[acceleration.txid] = [];
      for (const pool of acceleration.pools) {
        if (!pools[pool]) {
          pools[pool] = {
            name: this.pools[pool]?.name || 'unknown',
            block: 0,
            vsize: 0,
            accelerations: [],
            complete: false,
          };
        }
        pools[pool].accelerations.push(acceleration.txid);
      }
      for (const ancestor of mempoolCache[acceleration.txid].ancestors || []) {
        accelerationPositions[ancestor.txid] = [];
      }
    }

    for (const pool of Object.keys(pools)) {
      // if any pools accepted *every* acceleration, we can just use the GBT result positions directly
      if (pools[pool].accelerations.length === Object.keys(accelerations).length) {
        pools[pool].complete = true;
      }
    }

    let block = 0;
    let index = 0;
    let next = accQueue.pop();
    // build simulated blocks for each pool by taking the best option from
    // either the mempool or the list of accelerations.
    while (next && block < mempoolBlocks.length) {
      while (next && index < mempoolBlocks[block].transactions.length) {
        const nextTx = mempoolBlocks[block].transactions[index];
        if (next.rate >= (nextTx.rate || (nextTx.fee / nextTx.vsize))) {
          for (const pool of next.acceleration.pools) {
            if (pools[pool].vsize + next.vsize <= 999_000) {
              pools[pool].vsize += next.vsize;
            } else {
              pools[pool].block++;
              pools[pool].vsize = next.vsize;
            }
            // insert the acceleration into matching pool's blocks
            if (pools[pool].complete && mempoolCache[next.acceleration.txid]?.position !== undefined) {
              accelerationPositions[next.acceleration.txid].push({
                ...mempoolCache[next.acceleration.txid].position as { block: number, vsize: number },
                poolId: pool,
                pool: pools[pool].name
              });
            } else {
              accelerationPositions[next.acceleration.txid].push({
                poolId: pool,
                pool: pools[pool].name,
                block: pools[pool].block,
                vsize: pools[pool].vsize - (next.vsize / 2),
              });
            }
            // and any accelerated ancestors
            for (const ancestor of mempoolCache[next.acceleration.txid].ancestors || []) {
              if (pools[pool].complete && mempoolCache[ancestor.txid]?.position !== undefined) {
                accelerationPositions[ancestor.txid].push({
                  ...mempoolCache[ancestor.txid].position as { block: number, vsize: number },
                  poolId: pool,
                  pool: pools[pool].name,
                });
              } else {
                accelerationPositions[ancestor.txid].push({
                  poolId: pool,
                  pool: pools[pool].name,
                  block: pools[pool].block,
                  vsize: pools[pool].vsize - (next.vsize / 2),
                });
              }
            }
          }
          next = accQueue.pop();
        } else {
          // skip accelerated transactions and their CPFP ancestors
          if (accelerationPositions[nextTx.txid] == null) {
            // insert into all pools' blocks
            for (const pool of Object.keys(pools)) {
              if (pools[pool].vsize + nextTx.vsize <= 999_000) {
                pools[pool].vsize += nextTx.vsize;
              } else {
                pools[pool].block++;
                pools[pool].vsize = nextTx.vsize;
              }
            }
          }
          index++;
        }
      }
      block++;
      index = 0;
    }
    mempool.setAccelerationPositions(accelerationPositions);
  }
}

export default new MempoolBlocks();
