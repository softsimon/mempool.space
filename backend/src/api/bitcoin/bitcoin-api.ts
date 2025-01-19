import * as bitcoinjs from 'bitcoinjs-lib';
import { AbstractBitcoinApi, HealthCheckHost } from './bitcoin-api-abstract-factory';
import { IBitcoinApi, SubmitPackageResult, TestMempoolAcceptResult } from './bitcoin-api.interface';
import { IEsploraApi } from './esplora-api.interface';
import blocks from '../blocks';
import mempool from '../mempool';
import indexer from '../../indexer';
import { TransactionExtended } from '../../mempool.interfaces';
import transactionUtils from '../transaction-utils';

class BitcoinApi implements AbstractBitcoinApi {
  private rawMempoolCache: IBitcoinApi.RawMempool | null = null;
  protected bitcoindClient: any;

  constructor(bitcoinClient: any) {
    this.bitcoindClient = bitcoinClient;
  }

  static convertBlock(block: IBitcoinApi.Block): IEsploraApi.Block {
    return {
      id: block.hash,
      height: block.height,
      version: block.version,
      timestamp: block.time,
      bits: parseInt(block.bits, 16),
      nonce: block.nonce,
      difficulty: block.difficulty,
      merkle_root: block.merkleroot,
      tx_count: block.nTx,
      size: block.size,
      weight: block.weight,
      previousblockhash: block.previousblockhash,
      mediantime: block.mediantime,
      stale: block.confirmations === -1,
    };
  }


  $getRawTransaction(txId: string, skipConversion = false, addPrevout = false, lazyPrevouts = false): Promise<IEsploraApi.Transaction> {
    // If the transaction is in the mempool we already converted and fetched the fee. Only prevouts are missing
    const txInMempool = mempool.getMempool()[txId];
    if (txInMempool && addPrevout) {
      return this.$addPrevouts(txInMempool);
    }

    return this.bitcoindClient.getRawTransaction(txId, true)
      .then((transaction: IBitcoinApi.Transaction) => {
        if (skipConversion) {
          transaction.vout.forEach((vout) => {
            vout.value = Math.round(vout.value * 100000000);
          });
          return transaction;
        }
        return this.$convertTransaction(transaction, addPrevout, lazyPrevouts);
      })
      .catch((e: Error) => {
        if (e.message.startsWith('The genesis block coinbase')) {
          return this.$returnCoinbaseTransaction();
        }
        throw e;
      });
  }

  async $getRawTransactions(txids: string[]): Promise<IEsploraApi.Transaction[]> {
    const txs: IEsploraApi.Transaction[] = [];
    for (const txid of txids) {
      try {
        const tx = await this.$getRawTransaction(txid, false, true);
        txs.push(tx);
      } catch (err) {
        // skip failures
      }
    }
    return txs;
  }

  $getMempoolTransactions(txids: string[]): Promise<IEsploraApi.Transaction[]> {
    throw new Error('Method getMempoolTransactions not supported by the Bitcoin RPC API.');
  }

  $getAllMempoolTransactions(lastTxid?: string, max_txs?: number): Promise<IEsploraApi.Transaction[]> {
    throw new Error('Method getAllMempoolTransactions not supported by the Bitcoin RPC API.');

  }

  async $getTransactionHex(txId: string): Promise<string> {
    const txInMempool = mempool.getMempool()[txId];
    if (txInMempool && txInMempool.hex) {
      return txInMempool.hex;
    }

    return this.bitcoindClient.getRawTransaction(txId, true)
      .then((transaction: IBitcoinApi.Transaction) => {
        return transaction.hex;
      });
  }

  $getBlockHeightTip(): Promise<number> {
    return this.bitcoindClient.getBlockCount();
  }

  $getBlockHashTip(): Promise<string> {
    return this.bitcoindClient.getBestBlockHash();
  }

  $getTxIdsForBlock(hash: string): Promise<string[]> {
    return this.bitcoindClient.getBlock(hash, 1)
      .then((rpcBlock: IBitcoinApi.Block) => rpcBlock.tx);
  }

  async $getTxsForBlock(hash: string): Promise<IEsploraApi.Transaction[]> {
    const verboseBlock: IBitcoinApi.VerboseBlock = await this.bitcoindClient.getBlock(hash, 2);
    const transactions: IEsploraApi.Transaction[] = [];
    for (const tx of verboseBlock.tx) {
      const converted = await this.$convertTransaction(tx, true);
      transactions.push(converted);
    }
    return transactions;
  }

  $getRawBlock(hash: string): Promise<Buffer> {
    return this.bitcoindClient.getBlock(hash, 0)
      .then((raw: string) => Buffer.from(raw, "hex"));
  }

  $getBlockHash(height: number): Promise<string> {
    return this.bitcoindClient.getBlockHash(height);
  }

  $getBlockHeader(hash: string): Promise<string> {
    return this.bitcoindClient.getBlockHeader(hash, false);
  }

  async $getBlock(hash: string): Promise<IEsploraApi.Block> {
    const foundBlock = blocks.getBlocks().find((block) => block.id === hash);
    if (foundBlock) {
      return foundBlock;
    }

    return this.bitcoindClient.getBlock(hash)
      .then((block: IBitcoinApi.Block) => BitcoinApi.convertBlock(block));
  }

  $getAddress(address: string): Promise<IEsploraApi.Address> {
    throw new Error('Method getAddress not supported by the Bitcoin RPC API.');
  }

  $getAddressTransactions(address: string, lastSeenTxId: string): Promise<IEsploraApi.Transaction[]> {
    throw new Error('Method getAddressTransactions not supported by the Bitcoin RPC API.');
  }

  $getScriptHash(scripthash: string): Promise<IEsploraApi.ScriptHash> {
    throw new Error('Method getScriptHash not supported by the Bitcoin RPC API.');
  }

  $getScriptHashTransactions(scripthash: string, lastSeenTxId: string): Promise<IEsploraApi.Transaction[]> {
    throw new Error('Method getScriptHashTransactions not supported by the Bitcoin RPC API.');
  }

  $getRawMempool(): Promise<IEsploraApi.Transaction['txid'][]> {
    return this.bitcoindClient.getRawMemPool();
  }

  $getAddressPrefix(prefix: string): string[] {
    const found: { [address: string]: string } = {};
    const mp = mempool.getMempool();
    for (const tx in mp) {
      for (const vout of mp[tx].vout) {
        if (vout.scriptpubkey_address?.indexOf(prefix) === 0) {
          found[vout.scriptpubkey_address] = '';
          if (Object.keys(found).length >= 10) {
            return Object.keys(found);
          }
        }
      }
      for (const vin of mp[tx].vin) {
        if (vin.prevout?.scriptpubkey_address?.indexOf(prefix) === 0) {
          found[vin.prevout?.scriptpubkey_address] = '';
          if (Object.keys(found).length >= 10) {
            return Object.keys(found);
          }
        }
      }
    }
    return Object.keys(found);
  }

  $sendRawTransaction(rawTransaction: string): Promise<string> {
    return this.bitcoindClient.sendRawTransaction(rawTransaction);
  }

  async $testMempoolAccept(rawTransactions: string[], maxfeerate?: number): Promise<TestMempoolAcceptResult[]> {
    if (rawTransactions.length) {
      return this.bitcoindClient.testMempoolAccept(rawTransactions, maxfeerate ?? undefined);
    } else {
      return [];
    }
  }

  $submitPackage(rawTransactions: string[], maxfeerate?: number, maxburnamount?: number): Promise<SubmitPackageResult> {
    return this.bitcoindClient.submitPackage(rawTransactions, maxfeerate ?? undefined, maxburnamount ?? undefined);
  }

  async $getOutspend(txId: string, vout: number): Promise<IEsploraApi.Outspend> {
    const txOut = await this.bitcoindClient.getTxOut(txId, vout, false);
    return {
      spent: txOut === null,
      status: {
        confirmed: true,
      }
    };
  }

  async $getOutspends(txId: string): Promise<IEsploraApi.Outspend[]> {
    const outSpends: IEsploraApi.Outspend[] = [];
    const tx = await this.$getRawTransaction(txId, true, false);
    if (indexer.isCoreIndexReady('txospenderindex') === null) {
      for (let i = 0; i < tx.vout.length; i++) {
        if (tx.status && tx.status.block_height === 0) {
          outSpends.push({
            spent: false
          });
        } else {
          const txOut = await this.bitcoindClient.getTxOut(txId, i);
          outSpends.push({
            spent: txOut === null,
          });
        }
      }
    } else {
      const batchedOutpoints = Array.from(Array(tx.vout.length).keys()).map(x =>({txid: txId, vout:x}));
      const spendingsResume = await this.bitcoindClient.getTxSpendingPrevOut(batchedOutpoints);
      for (const outpointStatus of spendingsResume) {
        if (outpointStatus.spendingtxid === undefined) {
          outSpends.push({spent: false});
          continue;
        }
        const spendingTx = await this.$getRawTransaction(outpointStatus.spendingtxid, true, false);
        const inputIndex = spendingTx.vin.findIndex(x => x.txid === txId);
        outSpends.push({
          spent: true,
          txid: outpointStatus.spendingtxid,
          vin: inputIndex,
          status: {
            confirmed: true,
          }

        });
      }
    }
    return outSpends;
  }

  async $getBatchedOutspends(txId: string[]): Promise<IEsploraApi.Outspend[][]> {
    const outspends: IEsploraApi.Outspend[][] = [];
    for (const tx of txId) {
      const outspend = await this.$getOutspends(tx);
      outspends.push(outspend);
    }
    return outspends;
  }

  async $getBatchedOutspendsInternal(txId: string[]): Promise<IEsploraApi.Outspend[][]> {
    return this.$getBatchedOutspends(txId);
  }

  async $getOutSpendsByOutpoint(outpoints: { txid: string, vout: number }[]): Promise<IEsploraApi.Outspend[]> {
    const outspends: IEsploraApi.Outspend[] = [];
    for (const outpoint of outpoints) {
      const outspend = await this.$getOutspend(outpoint.txid, outpoint.vout);
      outspends.push(outspend);
    }
    return outspends;
  }

  async $getCoinbaseTx(blockhash: string): Promise<IEsploraApi.Transaction> {
    const txids = await this.$getTxIdsForBlock(blockhash);
    return this.$getRawTransaction(txids[0]);
  }

  async $getAddressTransactionSummary(address: string): Promise<IEsploraApi.AddressTxSummary[]> {
    throw new Error('Method getAddressTransactionSummary not supported by the Bitcoin RPC API.');
  }

  $getEstimatedHashrate(blockHeight: number): Promise<number> {
    // 120 is the default block span in Core
    return this.bitcoindClient.getNetworkHashPs(120, blockHeight);
  }

  protected async $convertTransaction(transaction: IBitcoinApi.Transaction, addPrevout: boolean, lazyPrevouts = false): Promise<IEsploraApi.Transaction> {
    let esploraTransaction: IEsploraApi.Transaction = {
      txid: transaction.txid,
      version: transaction.version,
      locktime: transaction.locktime,
      size: transaction.size,
      weight: transaction.weight,
      fee: 0,
      vin: [],
      vout: [],
      status: { confirmed: false },
    };

    esploraTransaction.vout = transaction.vout.map((vout) => {
      return {
        value: Math.round(vout.value * 100000000),
        scriptpubkey: vout.scriptPubKey.hex,
        scriptpubkey_address: vout.scriptPubKey && vout.scriptPubKey.address ? vout.scriptPubKey.address
          : vout.scriptPubKey.addresses ? vout.scriptPubKey.addresses[0] : '',
        scriptpubkey_asm: vout.scriptPubKey.asm ? transactionUtils.convertScriptSigAsm(vout.scriptPubKey.hex) : '',
        scriptpubkey_type: this.translateScriptPubKeyType(vout.scriptPubKey.type),
      };
    });

    esploraTransaction.vin = transaction.vin.map((vin) => {
      return {
        is_coinbase: !!vin.coinbase,
        prevout: null,
        scriptsig: vin.scriptSig && vin.scriptSig.hex || vin.coinbase || '',
        scriptsig_asm: vin.scriptSig && transactionUtils.convertScriptSigAsm(vin.scriptSig.hex) || '',
        sequence: vin.sequence,
        txid: vin.txid || '',
        vout: vin.vout || 0,
        witness: vin.txinwitness || [],
        inner_redeemscript_asm: '',
        inner_witnessscript_asm: '',
      };
    });

    if (transaction.confirmations) {
      esploraTransaction.status = {
        confirmed: true,
        block_height: blocks.getCurrentBlockHeight() - transaction.confirmations + 1,
        block_hash: transaction.blockhash,
        block_time: transaction.blocktime,
      };
    }

    if (addPrevout) {
      esploraTransaction = await this.$calculateFeeFromInputs(esploraTransaction, false, lazyPrevouts);
    } else if (!transaction.confirmations) {
      esploraTransaction = await this.$appendMempoolFeeData(esploraTransaction);
    }

    return esploraTransaction;
  }

  private translateScriptPubKeyType(outputType: string): string {
    const map = {
      'pubkey': 'p2pk',
      'pubkeyhash': 'p2pkh',
      'scripthash': 'p2sh',
      'witness_v0_keyhash': 'v0_p2wpkh',
      'witness_v0_scripthash': 'v0_p2wsh',
      'witness_v1_taproot': 'v1_p2tr',
      'nonstandard': 'nonstandard',
      'multisig': 'multisig',
      'anchor': 'anchor',
      'nulldata': 'op_return'
    };

    if (map[outputType]) {
      return map[outputType];
    } else {
      return 'unknown';
    }
  }

  private async $appendMempoolFeeData(transaction: IEsploraApi.Transaction): Promise<IEsploraApi.Transaction> {
    if (transaction.fee) {
      return transaction;
    }
    let mempoolEntry: IBitcoinApi.MempoolEntry;
    if (!mempool.isInSync() && !this.rawMempoolCache) {
      this.rawMempoolCache = await this.$getRawMempoolVerbose();
    }
    if (this.rawMempoolCache && this.rawMempoolCache[transaction.txid]) {
      mempoolEntry = this.rawMempoolCache[transaction.txid];
    } else {
      mempoolEntry = await this.$getMempoolEntry(transaction.txid);
    }
    transaction.fee = Math.round(mempoolEntry.fees.base * 100000000);
    return transaction;
  }

  protected async $addPrevouts(transaction: TransactionExtended): Promise<TransactionExtended> {
    for (const vin of transaction.vin) {
      if (vin.prevout) {
        continue;
      }
      const innerTx = await this.$getRawTransaction(vin.txid, false, false);
      vin.prevout = innerTx.vout[vin.vout];
      transactionUtils.addInnerScriptsToVin(vin);
    }
    return transaction;
  }

  protected $returnCoinbaseTransaction(): Promise<IEsploraApi.Transaction> {
    return this.bitcoindClient.getBlockHash(0).then((hash: string) =>
      this.bitcoindClient.getBlock(hash, 2)
        .then((block: IBitcoinApi.Block) => {
          return this.$convertTransaction(Object.assign(block.tx[0], {
            confirmations: blocks.getCurrentBlockHeight() + 1,
            blocktime: block.time }), false);
        })
    );
  }

  private $getMempoolEntry(txid: string): Promise<IBitcoinApi.MempoolEntry> {
    return this.bitcoindClient.getMempoolEntry(txid);
  }

  private $getRawMempoolVerbose(): Promise<IBitcoinApi.RawMempool> {
    return this.bitcoindClient.getRawMemPool(true);
  }


  private async $calculateFeeFromInputs(transaction: IEsploraApi.Transaction, addPrevout: boolean, lazyPrevouts: boolean): Promise<IEsploraApi.Transaction> {
    if (transaction.vin[0].is_coinbase) {
      transaction.fee = 0;
      return transaction;
    }
    let totalIn = 0;

    for (let i = 0; i < transaction.vin.length; i++) {
      if (lazyPrevouts && i > 12) {
        transaction.vin[i].lazy = true;
        continue;
      }
      const innerTx = await this.$getRawTransaction(transaction.vin[i].txid, false, false);
      transaction.vin[i].prevout = innerTx.vout[transaction.vin[i].vout];
      transactionUtils.addInnerScriptsToVin(transaction.vin[i]);
      totalIn += innerTx.vout[transaction.vin[i].vout].value;
    }
    if (lazyPrevouts && transaction.vin.length > 12) {
      transaction.fee = -1;
    } else {
      const totalOut = transaction.vout.reduce((p, output) => p + output.value, 0);
      transaction.fee = parseFloat((totalIn - totalOut).toFixed(8));
    }
    return transaction;
  }

  public startHealthChecks(): void {};

  public getHealthStatus() {
    return [];
  }
}

export default BitcoinApi;
