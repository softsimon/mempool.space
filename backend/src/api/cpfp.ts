import { Ancestor, CpfpCluster, CpfpInfo, CpfpSummary, MempoolTransactionExtended, TransactionExtended } from '../mempool.interfaces';
import { GraphTx, convertToGraphTx, expandRelativesGraph, initializeRelatives, makeBlockTemplate, mempoolComparator, removeAncestors, setAncestorScores } from './mini-miner';
import memPool from './mempool';
import { Acceleration } from './acceleration/acceleration';

const CPFP_UPDATE_INTERVAL = 60_000; // update CPFP info at most once per 60s per transaction
const MAX_CLUSTER_ITERATIONS = 100;

export function calculateFastBlockCpfp(height: number, transactions: MempoolTransactionExtended[], saveRelatives: boolean = false): CpfpSummary {
  const clusters: CpfpCluster[] = []; // list of all cpfp clusters in this block
  const clusterMap: { [txid: string]: CpfpCluster } = {}; // map transactions to their cpfp cluster
  let clusterTxs: TransactionExtended[] = []; // working list of elements of the current cluster
  let ancestors: { [txid: string]: boolean } = {}; // working set of ancestors of the current cluster root
  const txMap: { [txid: string]: TransactionExtended } = {};
  // initialize the txMap
  for (const tx of transactions) {
    txMap[tx.txid] = tx;
  }
  // reverse pass to identify CPFP clusters
  for (let i = transactions.length - 1; i >= 0; i--) {
    const tx = transactions[i];
    if (!ancestors[tx.txid]) {
      let totalFee = 0;
      let totalVSize = 0;
      clusterTxs.forEach(tx => {
        totalFee += tx?.fee || 0;
        totalVSize += (tx.weight / 4);
      });
      const effectiveFeePerVsize = totalFee / totalVSize;
      let cluster: CpfpCluster;
      if (clusterTxs.length > 1) {
        cluster = {
          root: clusterTxs[0].txid,
          height,
          txs: clusterTxs.map(tx => { return { txid: tx.txid, weight: tx.weight, fee: tx.fee || 0 }; }),
          effectiveFeePerVsize,
        };
        clusters.push(cluster);
      }
      clusterTxs.forEach(tx => {
        txMap[tx.txid].effectiveFeePerVsize = effectiveFeePerVsize;
        if (cluster) {
          clusterMap[tx.txid] = cluster;
        }
      });
      // reset working vars
      clusterTxs = [];
      ancestors = {};
    }
    clusterTxs.push(tx);
    tx.vin.forEach(vin => {
      ancestors[vin.txid] = true;
    });
  }
  // forward pass to enforce ancestor rate caps
  for (const tx of transactions) {
    let minAncestorRate = tx.effectiveFeePerVsize;
    for (const vin of tx.vin) {
      if (txMap[vin.txid]?.effectiveFeePerVsize) {
        minAncestorRate = Math.min(minAncestorRate, txMap[vin.txid].effectiveFeePerVsize);
      }
    }
    // check rounded values to skip cases with almost identical fees
    const roundedMinAncestorRate = Math.ceil(minAncestorRate);
    const roundedEffectiveFeeRate = Math.floor(tx.effectiveFeePerVsize);
    if (roundedMinAncestorRate < roundedEffectiveFeeRate) {
      tx.effectiveFeePerVsize = minAncestorRate;
      if (!clusterMap[tx.txid]) {
        // add a single-tx cluster to record the dependent rate
        const cluster = {
          root: tx.txid,
          height,
          txs: [{ txid: tx.txid, weight: tx.weight, fee: tx.fee || 0 }],
          effectiveFeePerVsize: minAncestorRate,
        };
        clusterMap[tx.txid] = cluster;
        clusters.push(cluster);
      } else {
        // update the existing cluster with the dependent rate
        clusterMap[tx.txid].effectiveFeePerVsize = minAncestorRate;
      }
    }
  }
  if (saveRelatives) {
    for (const cluster of clusters) {
      cluster.txs.forEach((member, index) => {
        txMap[member.txid].descendants = cluster.txs.slice(0, index).reverse();
        txMap[member.txid].ancestors = cluster.txs.slice(index + 1).reverse();
        txMap[member.txid].effectiveFeePerVsize = cluster.effectiveFeePerVsize;
      });
    }
  }
  return {
    transactions,
    clusters,
    version: 1,
  };
}

export function calculateGoodBlockCpfp(height: number, transactions: MempoolTransactionExtended[], accelerations: Acceleration[]): CpfpSummary {
  const txMap: { [txid: string]: MempoolTransactionExtended } = {};
  for (const tx of transactions) {
    txMap[tx.txid] = tx;
  }
  const template = makeBlockTemplate(transactions, accelerations, 1, Infinity, Infinity);
  const clusters = new Map<string, string[]>();
  for (const tx of template) {
    const cluster = tx.cluster || [];
    const root = cluster.length ? cluster[cluster.length - 1] : null;
    if (cluster.length > 1 && root && !clusters.has(root)) {
      clusters.set(root, cluster);
    }
    txMap[tx.txid].effectiveFeePerVsize = tx.effectiveFeePerVsize;
  }

  const clusterArray: CpfpCluster[] = [];

  for (const cluster of clusters.values()) {
    for (const txid of cluster) {
      const mempoolTx = txMap[txid];
      if (mempoolTx) {
        const ancestors: Ancestor[] = [];
        const descendants: Ancestor[] = [];
        let matched = false;
        cluster.forEach(relativeTxid => {
          if (relativeTxid === txid) {
            matched = true;
          } else {
            const relative = {
              txid: relativeTxid,
              fee: txMap[relativeTxid].fee,
              weight: (txMap[relativeTxid].adjustedVsize * 4) || txMap[relativeTxid].weight,
            };
            if (matched) {
              descendants.push(relative);
            } else {
              ancestors.push(relative);
            }
          }
        });
        if (mempoolTx.ancestors?.length !== ancestors.length || mempoolTx.descendants?.length !== descendants.length) {
          mempoolTx.cpfpDirty = true;
        }
        Object.assign(mempoolTx, { ancestors, descendants, bestDescendant: null, cpfpChecked: true });
      }
    }
    const root = cluster[cluster.length - 1];
    clusterArray.push({
      root: root,
      height,
      txs: cluster.reverse().map(txid => ({
        txid,
        fee: txMap[txid].fee,
        weight: (txMap[txid].adjustedVsize * 4) || txMap[txid].weight,
      })),
      effectiveFeePerVsize: txMap[root].effectiveFeePerVsize,
    });
  }

  return {
    transactions: transactions.map(tx => txMap[tx.txid]),
    clusters: clusterArray,
    version: 2,
  };
}

/**
 * Takes a mempool transaction and a copy of the current mempool, and calculates the CPFP data for
 * that transaction (and all others in the same cluster)
 * If the passed transaction is not guaranteed to be in the mempool, set localTx to true: this will
 * prevent updating the CPFP data of other transactions in the cluster
 */
export function calculateMempoolTxCpfp(tx: MempoolTransactionExtended, mempool: { [txid: string]: MempoolTransactionExtended }, localTx: boolean = false): CpfpInfo {
  if (tx.cpfpUpdated && Date.now() < (tx.cpfpUpdated + CPFP_UPDATE_INTERVAL)) {
    tx.cpfpDirty = false;
    return {
      ancestors: tx.ancestors || [],
      bestDescendant: tx.bestDescendant || null,
      descendants: tx.descendants || [],
      effectiveFeePerVsize: tx.effectiveFeePerVsize || tx.adjustedFeePerVsize || tx.feePerVsize,
      sigops: tx.sigops,
      fee: tx.fee,
      adjustedVsize: tx.adjustedVsize,
      acceleration: tx.acceleration
    };
  }

  const ancestorMap = new Map<string, GraphTx>();
  const graphTx = convertToGraphTx(tx, memPool.getSpendMap());
  ancestorMap.set(tx.txid, graphTx);

  const allRelatives = expandRelativesGraph(mempool, ancestorMap, memPool.getSpendMap());
  const relativesMap = initializeRelatives(allRelatives);
  const cluster = calculateCpfpCluster(tx.txid, relativesMap);

  let totalVsize = 0;
  let totalFee = 0;
  for (const tx of cluster.values()) {
    totalVsize += tx.vsize;
    totalFee += tx.fees.base;
  }
  const effectiveFeePerVsize = totalFee / totalVsize;

  if (localTx) {
    tx.effectiveFeePerVsize = effectiveFeePerVsize;
    tx.ancestors = Array.from(cluster.get(tx.txid)?.ancestors.values() || []).map(ancestor => ({ txid: ancestor.txid, weight: ancestor.weight, fee: ancestor.fees.base }));
    tx.descendants = Array.from(cluster.values()).filter(entry => entry.txid !== tx.txid && !cluster.get(tx.txid)?.ancestors.has(entry.txid)).map(tx => ({ txid: tx.txid, weight: tx.weight, fee: tx.fees.base }));
    tx.bestDescendant = null;
  } else {
    for (const tx of cluster.values()) {
      mempool[tx.txid].effectiveFeePerVsize = effectiveFeePerVsize;
      mempool[tx.txid].ancestors = Array.from(tx.ancestors.values()).map(tx => ({ txid: tx.txid, weight: tx.weight, fee: tx.fees.base }));
      mempool[tx.txid].descendants = Array.from(cluster.values()).filter(entry => entry.txid !== tx.txid && !tx.ancestors.has(entry.txid)).map(tx => ({ txid: tx.txid, weight: tx.weight, fee: tx.fees.base }));
      mempool[tx.txid].bestDescendant = null;
      mempool[tx.txid].cpfpChecked = true;
      mempool[tx.txid].cpfpDirty = true;
      mempool[tx.txid].cpfpUpdated = Date.now();
    }

    tx = mempool[tx.txid];

  }

  return {
    ancestors: tx.ancestors || [],
    bestDescendant: tx.bestDescendant || null,
    descendants: tx.descendants || [],
    effectiveFeePerVsize: tx.effectiveFeePerVsize || tx.adjustedFeePerVsize || tx.feePerVsize,
    sigops: tx.sigops,
    fee: tx.fee,
    adjustedVsize: tx.adjustedVsize,
    acceleration: tx.acceleration
  };
}

/**
   * Given a root transaction and a list of in-mempool ancestors,
   * Calculate the CPFP cluster
   * 
   * @param tx
   * @param ancestors
   */
function calculateCpfpCluster(txid: string, graph: Map<string, GraphTx>): Map<string, GraphTx> {
  const tx = graph.get(txid);
  if (!tx) {
    return new Map<string, GraphTx>([]);
  }

  // Initialize individual & ancestor fee rates
  graph.forEach(entry => setAncestorScores(entry));

  // Sort by descending ancestor score
  let sortedRelatives = Array.from(graph.values()).sort(mempoolComparator);

  // Iterate until we reach a cluster that includes our target tx
  let maxIterations = MAX_CLUSTER_ITERATIONS;
  let best = sortedRelatives.shift();
  let bestCluster = new Map<string, GraphTx>(best?.ancestors?.entries() || []);
  while (sortedRelatives.length && best && (best.txid !== tx.txid && !best.ancestors.has(tx.txid)) && maxIterations > 0) {
    maxIterations--;
    if ((best && best.txid === tx.txid) || (bestCluster && bestCluster.has(tx.txid))) {
      break;
    } else {
      // Remove this cluster (it doesn't include our target tx)
      // and update scores, ancestor totals and dependencies for the survivors
      removeAncestors(bestCluster, graph);

      // re-sort
      sortedRelatives = Array.from(graph.values()).sort(mempoolComparator);

      // Grab the next highest scoring entry
      best = sortedRelatives.shift();
      if (best) {
        bestCluster = new Map<string, GraphTx>(best?.ancestors?.entries() || []);
        bestCluster.set(best?.txid, best);
      }
    }
  }

  bestCluster.set(tx.txid, tx);

  return bestCluster;
}