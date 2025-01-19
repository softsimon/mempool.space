import { IEsploraApi } from './api/bitcoin/esplora-api.interface';
import { OrphanedBlock } from './api/chain-tips';
import { HeapNode } from './utils/pairing-heap';

export interface PoolTag {
  id: number;
  uniqueId: number;
  name: string;
  link: string;
  regexes: string; // JSON array
  addresses: string; // JSON array
  slug: string;
}

export interface PoolInfo {
  poolId: number; // mysql row id
  name: string;
  link: string;
  blockCount: number;
  slug: string;
  avgMatchRate: number | null;
  avgFeeDelta: number | null;
  poolUniqueId: number;
}

export interface PoolStats extends PoolInfo {
  rank: number;
  emptyBlocks: number;
}

export interface BlockAudit {
  version: number,
  time: number,
  height: number,
  hash: string,
  unseenTxs: string[],
  missingTxs: string[],
  freshTxs: string[],
  sigopTxs: string[],
  fullrbfTxs: string[],
  addedTxs: string[],
  prioritizedTxs: string[],
  acceleratedTxs: string[],
  matchRate: number,
  expectedFees?: number,
  expectedWeight?: number,
  template?: any[];
}

export interface TransactionAudit {
  seen?: boolean;
  expected?: boolean;
  added?: boolean;
  prioritized?: boolean;
  delayed?: number;
  accelerated?: boolean;
  conflict?: boolean;
  coinbase?: boolean;
  firstSeen?: number;
}

export interface AuditScore {
  hash: string,
  matchRate?: number,
  expectedFees?: number
  expectedWeight?: number
}

export interface MempoolBlock {
  blockSize: number;
  blockVSize: number;
  nTx: number;
  medianFee: number;
  totalFees: number;
  feeRange: number[];
}

export interface MempoolBlockWithTransactions extends MempoolBlock {
  transactionIds: string[];
  transactions: TransactionClassified[];
}

export interface MempoolBlockDelta {
  added: TransactionCompressed[];
  removed: string[];
  changed: MempoolDeltaChange[];
}

export interface MempoolDeltaTxids {
  sequence: number,
  added: string[];
  removed: string[];
  mined: string[];
  replaced: { replaced: string, by: string }[];
}

export interface MempoolDelta {
  sequence: number,
  added: MempoolTransactionExtended[];
  removed: string[];
  mined: string[];
  replaced: { replaced: string, by: TransactionExtended }[];
}

interface VinStrippedToScriptsig {
  scriptsig: string;
}

interface VoutStrippedToScriptPubkey {
  scriptpubkey_address: string | undefined;
  scriptpubkey_asm: string | undefined;
  value: number;
}

export interface TransactionExtended extends IEsploraApi.Transaction {
  vsize: number;
  feePerVsize: number;
  firstSeen?: number;
  effectiveFeePerVsize: number;
  ancestors?: Ancestor[];
  descendants?: Ancestor[];
  bestDescendant?: BestDescendant | null;
  cpfpChecked?: boolean;
  position?: {
    block: number,
    vsize: number,
  };
  acceleration?: boolean;
  acceleratedBy?: number[];
  acceleratedAt?: number;
  feeDelta?: number;
  replacement?: boolean;
  uid?: number;
  flags?: number;
}

export interface MempoolTransactionExtended extends TransactionExtended {
  order: number;
  sigops: number;
  adjustedVsize: number;
  adjustedFeePerVsize: number;
  inputs?: number[];
  lastBoosted?: number;
  cpfpDirty?: boolean;
  cpfpUpdated?: number;
}

export interface AuditTransaction {
  uid: number;
  fee: number;
  weight: number;
  feePerVsize: number;
  effectiveFeePerVsize: number;
  sigops: number;
  inputs: number[];
  relativesSet: boolean;
  ancestorMap: Map<number, AuditTransaction>;
  children: Set<AuditTransaction>;
  ancestorFee: number;
  ancestorWeight: number;
  ancestorSigops: number;
  score: number;
  used: boolean;
  modified: boolean;
  modifiedNode: HeapNode<AuditTransaction>;
  dependencyRate?: number;
}

export interface CompactThreadTransaction {
  uid: number;
  fee: number;
  weight: number;
  sigops: number;
  feePerVsize: number;
  effectiveFeePerVsize: number;
  inputs: number[];
  cpfpRoot?: number;
  cpfpChecked?: boolean;
  dirty?: boolean;
}

export interface GbtCandidates {
  txs: { [txid: string ]: boolean },
  added: MempoolTransactionExtended[];
  removed: MempoolTransactionExtended[];
}

export interface ThreadTransaction {
  txid: string;
  fee: number;
  weight: number;
  feePerVsize: number;
  effectiveFeePerVsize?: number;
  inputs: number[];
  cpfpRoot?: string;
  cpfpChecked?: boolean;
}

export interface Ancestor {
  txid: string;
  weight: number;
  fee: number;
}

export interface TransactionSet {
  fee: number;
  weight: number;
  score: number;
  children?: Set<string>;
  available?: boolean;
  modified?: boolean;
  modifiedNode?: HeapNode<string>;
}

interface BestDescendant {
  txid: string;
  weight: number;
  fee: number;
}

export interface CpfpInfo {
  ancestors: Ancestor[];
  bestDescendant?: BestDescendant | null;
  descendants?: Ancestor[];
  effectiveFeePerVsize?: number;
  sigops?: number;
  adjustedVsize?: number,
  acceleration?: boolean,
  fee?: number;
}

export interface TransactionStripped {
  txid: string;
  fee: number;
  vsize: number;
  value: number;
  acc?: boolean;
  rate?: number; // effective fee rate
  time?: number;
}

export interface TransactionClassified extends TransactionStripped {
  flags: number;
}

// [txid, fee, vsize, value, rate, flags, acceleration?]
export type TransactionCompressed = [string, number, number, number, number, number, number, 1?];
// [txid, rate, flags, acceleration?]
export type MempoolDeltaChange = [string, number, number, (1|0)];

// binary flags for transaction classification
export const TransactionFlags = {
  // features
  rbf:                                                         0b00000001n,
  no_rbf:                                                      0b00000010n,
  v1:                                                          0b00000100n,
  v2:                                                          0b00001000n,
  v3:                                                          0b00010000n,
  nonstandard:                                                 0b00100000n,
  // address types
  p2pk:                                               0b00000001_00000000n,
  p2ms:                                               0b00000010_00000000n,
  p2pkh:                                              0b00000100_00000000n,
  p2sh:                                               0b00001000_00000000n,
  p2wpkh:                                             0b00010000_00000000n,
  p2wsh:                                              0b00100000_00000000n,
  p2tr:                                               0b01000000_00000000n,
  // behavior
  cpfp_parent:                               0b00000001_00000000_00000000n,
  cpfp_child:                                0b00000010_00000000_00000000n,
  replacement:                               0b00000100_00000000_00000000n,
  // data
  op_return:                        0b00000001_00000000_00000000_00000000n,
  fake_pubkey:                      0b00000010_00000000_00000000_00000000n,
  inscription:                      0b00000100_00000000_00000000_00000000n,
  fake_scripthash:                  0b00001000_00000000_00000000_00000000n,
  // heuristics
  coinjoin:                0b00000001_00000000_00000000_00000000_00000000n,
  consolidation:           0b00000010_00000000_00000000_00000000_00000000n,
  batch_payout:            0b00000100_00000000_00000000_00000000_00000000n,
  // sighash
  sighash_all:    0b00000001_00000000_00000000_00000000_00000000_00000000n,
  sighash_none:   0b00000010_00000000_00000000_00000000_00000000_00000000n,
  sighash_single: 0b00000100_00000000_00000000_00000000_00000000_00000000n,
  sighash_default:0b00001000_00000000_00000000_00000000_00000000_00000000n,
  sighash_acp:    0b00010000_00000000_00000000_00000000_00000000_00000000n,
};

export interface BlockExtension {
  totalFees: number;
  medianFee: number; // median fee rate
  feeRange: number[]; // fee rate percentiles
  reward: number;
  matchRate: number | null;
  expectedFees: number | null;
  expectedWeight: number | null;
  similarity?: number;
  pool: {
    id: number; // Note - This is the `unique_id`, not to mix with the auto increment `id`
    name: string;
    slug: string;
    minerNames: string[] | null;
  };
  avgFee: number;
  avgFeeRate: number;
  coinbaseRaw: string;
  orphans: OrphanedBlock[] | null;
  coinbaseAddress: string | null;
  coinbaseAddresses: string[] | null;
  coinbaseSignature: string | null;
  coinbaseSignatureAscii: string | null;
  virtualSize: number;
  avgTxSize: number;
  totalInputs: number;
  totalOutputs: number;
  totalOutputAmt: number;
  medianFeeAmt: number | null; // median fee in sats
  feePercentiles: number[] | null, // fee percentiles in sats
  segwitTotalTxs: number;
  segwitTotalSize: number;
  segwitTotalWeight: number;
  header: string;
  firstSeen: number | null;
  utxoSetChange: number;
  // Requires coinstatsindex, will be set to NULL otherwise
  utxoSetSize: number | null;
  totalInputAmt: number | null;
  // pools-v2.json git hash
  definitionHash: string | undefined;
}

/**
 * Note: Everything that is added in here will be automatically returned through
 * /api/v1/block and /api/v1/blocks APIs
 */
export interface BlockExtended extends IEsploraApi.Block {
  extras: BlockExtension;
  canonical?: string;
}

export interface BlockSummary {
  id: string;
  transactions: TransactionClassified[];
  version?: number;
}

export interface AuditSummary extends BlockAudit {
  timestamp?: number,
  size?: number,
  weight?: number,
  tx_count?: number,
  transactions: TransactionClassified[];
  template?: TransactionClassified[];
}

export interface BlockPrice {
  height: number;
  priceId: number;
}

export interface TransactionMinerInfo {
  vin: VinStrippedToScriptsig[];
  vout: VoutStrippedToScriptPubkey[];
}

export interface MempoolStats {
  funded_txo_count: number;
  funded_txo_sum: number;
  spent_txo_count: number;
  spent_txo_sum: number;
  tx_count: number;
}

export interface EffectiveFeeStats {
  medianFee: number; // median effective fee rate
  feeRange: number[]; // 2nd, 10th, 25th, 50th, 75th, 90th, 98th percentiles
}

export interface WorkingEffectiveFeeStats extends EffectiveFeeStats {
  minFee: number;
  maxFee: number;
}

export interface CpfpCluster {
  root: string,
  height: number,
  txs: Ancestor[],
  effectiveFeePerVsize: number,
}

export interface CpfpSummary {
  transactions: MempoolTransactionExtended[];
  clusters: CpfpCluster[];
  version: number;
}

export interface Statistic {
  id?: number;
  added: string;
  unconfirmed_transactions: number;
  tx_per_second: number;
  vbytes_per_second: number;
  total_fee: number;
  mempool_byte_weight: number;
  fee_data: string;
  min_fee: number;

  vsize_1: number;
  vsize_2: number;
  vsize_3: number;
  vsize_4: number;
  vsize_5: number;
  vsize_6: number;
  vsize_8: number;
  vsize_10: number;
  vsize_12: number;
  vsize_15: number;
  vsize_20: number;
  vsize_30: number;
  vsize_40: number;
  vsize_50: number;
  vsize_60: number;
  vsize_70: number;
  vsize_80: number;
  vsize_90: number;
  vsize_100: number;
  vsize_125: number;
  vsize_150: number;
  vsize_175: number;
  vsize_200: number;
  vsize_250: number;
  vsize_300: number;
  vsize_350: number;
  vsize_400: number;
  vsize_500: number;
  vsize_600: number;
  vsize_700: number;
  vsize_800: number;
  vsize_900: number;
  vsize_1000: number;
  vsize_1200: number;
  vsize_1400: number;
  vsize_1600: number;
  vsize_1800: number;
  vsize_2000: number;
}

export interface OptimizedStatistic {
  added: string;
  count: number;
  vbytes_per_second: number;
  total_fee: number;
  mempool_byte_weight: number;
  min_fee: number;
  vsizes: number[];
}

export interface TxTrackingInfo {
  replacedBy?: string,
  position?: { block: number, vsize: number, accelerated?: boolean, acceleratedBy?: number[], acceleratedAt?: number, feeDelta?: number },
  cpfp?: {
    ancestors?: Ancestor[],
    bestDescendant?: Ancestor | null,
    descendants?: Ancestor[] | null,
    effectiveFeePerVsize?: number | null,
    sigops: number,
    adjustedVsize: number,
  },
  utxoSpent?: { [vout: number]: { vin: number, txid: string } },
  accelerated?: boolean,
  acceleratedBy?: number[],
  acceleratedAt?: number,
  feeDelta?: number,
  confirmed?: boolean
}

export interface WebsocketResponse {
  action: string;
  data: string[];
  'track-tx': string;
  'track-address': string;
  'watch-mempool': boolean;
}

export interface VbytesPerSecond {
  unixTime: number;
  vSize: number;
}

export interface RequiredSpec { [name: string]: RequiredParams; }

interface RequiredParams {
  required: boolean;
  types: ('@string' | '@number' | '@boolean' | string)[];
}

export interface ILoadingIndicators { [name: string]: number; }

export interface IBackendInfo {
  hostname: string;
  gitCommit: string;
  version: string;
  lightning: boolean;
  backend: 'esplora' | 'electrum' | 'none';
}

export interface IDifficultyAdjustment {
  progressPercent: number;
  difficultyChange: number;
  estimatedRetargetDate: number;
  remainingBlocks: number;
  remainingTime: number;
  previousRetarget: number;
  previousTime: number;
  nextRetargetHeight: number;
  timeAvg: number;
  timeOffset: number;
  expectedBlocks: number;
}

export interface IndexedDifficultyAdjustment {
  time: number; // UNIX timestamp
  height: number; // Block height
  difficulty: number;
  adjustment: number;
}

export interface RewardStats {
  totalReward: number;
  totalFee: number;
  totalTx: number;
}

export interface ITopNodesPerChannels {
  publicKey: string,
  alias: string,
  channels?: number,
  capacity: number,
  firstSeen?: number,
  updatedAt?: number,
  city?: any,
  country?: any,
}

export interface ITopNodesPerCapacity {
  publicKey: string,
  alias: string,
  capacity: number,
  channels?: number,
  firstSeen?: number,
  updatedAt?: number,
  city?: any,
  country?: any,
}

export interface INodesRanking {
  topByCapacity: ITopNodesPerCapacity[];
  topByChannels: ITopNodesPerChannels[];
}

export interface IOldestNodes {
  publicKey: string,
  alias: string,
  firstSeen: number,
  channels?: number,
  capacity: number,
  updatedAt?: number,
  city?: any,
  country?: any,
}
