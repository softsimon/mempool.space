import { TransactionExtended, MempoolTransactionExtended, TransactionMinerInfo } from '../mempool.interfaces';
import { IEsploraApi } from './bitcoin/esplora-api.interface';
import { Common } from './common';
import bitcoinApi, { bitcoinCoreApi } from './bitcoin/bitcoin-api-factory';
import * as bitcoinjs from 'bitcoinjs-lib';
import logger from '../logger';
import config from '../config';
import pLimit from '../utils/p-limit';

class TransactionUtils {
  constructor() { }

  public stripCoinbaseTransaction(tx: TransactionExtended): TransactionMinerInfo {
    return {
      vin: [{
        scriptsig: tx.vin[0].scriptsig || tx.vin[0]['coinbase']
      }],
      vout: tx.vout
        .map((vout) => ({
          scriptpubkey_address: vout.scriptpubkey_address,
          scriptpubkey_asm: vout.scriptpubkey_asm,
          value: vout.value
        }))
        .filter((vout) => vout.value)
    };
  }

  // Wrapper for $getTransactionExtended with an automatic retry direct to Core if the first API request fails.
  // Propagates any error from the retry request.
  public async $getTransactionExtendedRetry(txid: string, addPrevouts = false, lazyPrevouts = false, forceCore = false, addMempoolData = false): Promise<TransactionExtended> {
    try {
      const result = await this.$getTransactionExtended(txid, addPrevouts, lazyPrevouts, forceCore, addMempoolData);
      if (result) {
        return result;
      } else {
        logger.err(`Cannot fetch tx ${txid}. Reason: backend returned null data`);
      }
    } catch (e) {
      logger.err(`Cannot fetch tx ${txid}. Reason: ` + (e instanceof Error ? e.message : e));
    }
    // retry direct from Core if first request failed
    return this.$getTransactionExtended(txid, addPrevouts, lazyPrevouts, true, addMempoolData);
  }

  /**
   * @param txId
   * @param addPrevouts
   * @param lazyPrevouts
   * @param forceCore - See https://github.com/mempool/mempool/issues/2904
   */
  public async $getTransactionExtended(txId: string, addPrevouts = false, lazyPrevouts = false, forceCore = false, addMempoolData = false): Promise<TransactionExtended> {
    let transaction: IEsploraApi.Transaction;
    if (forceCore === true) {
      transaction  = await bitcoinCoreApi.$getRawTransaction(txId, false, addPrevouts, lazyPrevouts);
    } else {
      transaction  = await bitcoinApi.$getRawTransaction(txId, false, addPrevouts, lazyPrevouts);
    }

    if (Common.isLiquid()) {
      if (!isFinite(Number(transaction.fee))) {
        transaction.fee = Object.values(transaction.fee || {}).reduce((total, output) => total + output, 0);
      }
    }

    if (addMempoolData || !transaction?.status?.confirmed) {
      return this.extendMempoolTransaction(transaction);
    } else {
      return this.extendTransaction(transaction);
    }
  }

  public async $getMempoolTransactionExtended(txId: string, addPrevouts = false, lazyPrevouts = false, forceCore = false): Promise<MempoolTransactionExtended> {
    return (await this.$getTransactionExtended(txId, addPrevouts, lazyPrevouts, forceCore, true)) as MempoolTransactionExtended;
  }

  public async $getMempoolTransactionsExtended(txids: string[], addPrevouts = false, lazyPrevouts = false, forceCore = false): Promise<MempoolTransactionExtended[]> {
    if (forceCore || config.MEMPOOL.BACKEND !== 'esplora') {
      const limiter = pLimit(8); // Run 8 requests at a time
      const results = await Promise.allSettled(txids.map(
        txid => limiter(() => this.$getMempoolTransactionExtended(txid, addPrevouts, lazyPrevouts, forceCore))
      ));
      return results.filter(reply => reply.status === 'fulfilled')
        .map(r => (r as PromiseFulfilledResult<MempoolTransactionExtended>).value);
    } else {
      const transactions = await bitcoinApi.$getMempoolTransactions(txids);
      return transactions.map(transaction => {
        if (Common.isLiquid()) {
          if (!isFinite(Number(transaction.fee))) {
            transaction.fee = Object.values(transaction.fee || {}).reduce((total, output) => total + output, 0);
          }
        }

        return this.extendMempoolTransaction(transaction);
      });
    }
  }

  public extendTransaction(transaction: IEsploraApi.Transaction): TransactionExtended {
    // @ts-ignore
    if (transaction.vsize) {
      // @ts-ignore
      return transaction;
    }
    const feePerVbytes = (transaction.fee || 0) / (transaction.weight / 4);
    const transactionExtended: TransactionExtended = Object.assign({
      vsize: transaction.weight / 4,
      feePerVsize: feePerVbytes,
      effectiveFeePerVsize: feePerVbytes,
    }, transaction);
    if (!transaction?.status?.confirmed && !transactionExtended.firstSeen) {
      transactionExtended.firstSeen = Math.round((Date.now() / 1000));
    }
    return transactionExtended;
  }

  public extendMempoolTransaction(transaction: IEsploraApi.Transaction): MempoolTransactionExtended {
    const vsize = Math.ceil(transaction.weight / 4);
    const fractionalVsize = (transaction.weight / 4);
    let sigops = Common.isLiquid() ? 0 : (transaction.sigops != null ? transaction.sigops : this.countSigops(transaction));
    // https://github.com/bitcoin/bitcoin/blob/e9262ea32a6e1d364fb7974844fadc36f931f8c6/src/policy/policy.cpp#L295-L298
    const adjustedVsize = Math.max(fractionalVsize, sigops *  5); // adjusted vsize = Max(weight, sigops * bytes_per_sigop) / witness_scale_factor
    const feePerVbytes = (transaction.fee || 0) / fractionalVsize;
    const adjustedFeePerVsize = (transaction.fee || 0) / adjustedVsize;
    const effectiveFeePerVsize = transaction['effectiveFeePerVsize'] || adjustedFeePerVsize || feePerVbytes;
    const transactionExtended: MempoolTransactionExtended = Object.assign(transaction, {
      order: this.txidToOrdering(transaction.txid),
      vsize,
      adjustedVsize,
      sigops,
      feePerVsize: feePerVbytes,
      adjustedFeePerVsize: adjustedFeePerVsize,
      effectiveFeePerVsize: effectiveFeePerVsize,
    });
    if (!transactionExtended?.status?.confirmed && !transactionExtended.firstSeen) {
      transactionExtended.firstSeen = Math.round((Date.now() / 1000));
    }
    return transactionExtended;
  }

  public hex2ascii(hex: string) {
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
      str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return str;
  }

  public countScriptSigops(script: string, isRawScript: boolean = false, witness: boolean = false): number {
    if (!script?.length) {
      return 0;
    }

    let sigops = 0;
    // count OP_CHECKSIG and OP_CHECKSIGVERIFY
    sigops += (script.match(/OP_CHECKSIG/g)?.length || 0);

    // count OP_CHECKMULTISIG and OP_CHECKMULTISIGVERIFY
    if (isRawScript) {
      // in scriptPubKey or scriptSig, always worth 20
      sigops += 20 * (script.match(/OP_CHECKMULTISIG/g)?.length || 0);
    } else {
      // in redeem scripts and witnesses, worth N if preceded by OP_N, 20 otherwise
      const matches = script.matchAll(/(?:OP_(?:PUSHNUM_)?(\d+))? OP_CHECKMULTISIG/g);
      for (const match of matches) {
        const n = parseInt(match[1]);
        if (Number.isInteger(n)) {
          sigops += n;
        } else {
          sigops += 20;
        }
      }
    }

    return witness ? sigops : (sigops * 4);
  }

  public countSigops(transaction: IEsploraApi.Transaction): number {
    let sigops = 0;

    for (const input of transaction.vin) {
      if (input.scriptsig_asm) {
        sigops += this.countScriptSigops(input.scriptsig_asm, true);
      }
      if (input.prevout) {
        switch (true) {
          case input.prevout.scriptpubkey_type === 'p2sh' && input.witness?.length === 2 && input.scriptsig && input.scriptsig.startsWith('160014'):
          case input.prevout.scriptpubkey_type === 'v0_p2wpkh':
            sigops += 1;
            break;

          case input.prevout?.scriptpubkey_type === 'p2sh' && input.witness?.length && input.scriptsig && input.scriptsig.startsWith('220020'):
          case input.prevout.scriptpubkey_type === 'v0_p2wsh':
            if (input.witness?.length) {
              sigops += this.countScriptSigops(bitcoinjs.script.toASM(Buffer.from(input.witness[input.witness.length - 1], 'hex')), false, true);
            }
            break;

          case input.prevout.scriptpubkey_type === 'p2sh':
            if (input.inner_redeemscript_asm) {
              sigops += this.countScriptSigops(input.inner_redeemscript_asm);
            }
            break;
        }
      }
    }

    for (const output of transaction.vout) {
      if (output.scriptpubkey_asm) {
        sigops += this.countScriptSigops(output.scriptpubkey_asm, true);
      }
    }

    return sigops;
  }

  // returns the most significant 4 bytes of the txid as an integer
  public txidToOrdering(txid: string): number {
    return parseInt(
      txid.substr(62, 2) +
        txid.substr(60, 2) +
        txid.substr(58, 2) +
        txid.substr(56, 2),
      16
    );
  }

  public addInnerScriptsToVin(vin: IEsploraApi.Vin): void {
    if (!vin.prevout) {
      return;
    }

    if (vin.prevout.scriptpubkey_type === 'p2sh') {
      const redeemScript = vin.scriptsig_asm.split(' ').reverse()[0];
      vin.inner_redeemscript_asm = this.convertScriptSigAsm(redeemScript);
      if (vin.witness && vin.witness.length > 2) {
        const witnessScript = vin.witness[vin.witness.length - 1];
        vin.inner_witnessscript_asm = this.convertScriptSigAsm(witnessScript);
      }
    }

    if (vin.prevout.scriptpubkey_type === 'v0_p2wsh' && vin.witness) {
      const witnessScript = vin.witness[vin.witness.length - 1];
      vin.inner_witnessscript_asm = this.convertScriptSigAsm(witnessScript);
    }

    if (vin.prevout.scriptpubkey_type === 'v1_p2tr' && vin.witness) {
      const witnessScript = this.witnessToP2TRScript(vin.witness);
      if (witnessScript !== null) {
        vin.inner_witnessscript_asm = this.convertScriptSigAsm(witnessScript);
      }
    }
  }

  public convertScriptSigAsm(hex: string): string {
    const buf = Buffer.from(hex, 'hex');

    const b: string[] = [];

    let i = 0;
    while (i < buf.length) {
      const op = buf[i];
      if (op >= 0x01 && op <= 0x4e) {
        i++;
        let push: number;
        if (op === 0x4c) {
          push = buf.readUInt8(i);
          b.push('OP_PUSHDATA1');
          i += 1;
        } else if (op === 0x4d) {
          push = buf.readUInt16LE(i);
          b.push('OP_PUSHDATA2');
          i += 2;
        } else if (op === 0x4e) {
          push = buf.readUInt32LE(i);
          b.push('OP_PUSHDATA4');
          i += 4;
        } else {
          push = op;
          b.push('OP_PUSHBYTES_' + push);
        }

        const data = buf.slice(i, i + push);
        if (data.length !== push) {
          break;
        }

        b.push(data.toString('hex'));
        i += data.length;
      } else {
        if (op === 0x00) {
          b.push('OP_0');
        } else if (op === 0x4f) {
          b.push('OP_PUSHNUM_NEG1');
        } else if (op === 0xb1) {
          b.push('OP_CLTV');
        } else if (op === 0xb2) {
          b.push('OP_CSV');
        } else if (op === 0xba) {
          b.push('OP_CHECKSIGADD');
        } else {
          const opcode = bitcoinjs.script.toASM([ op ]);
          if (opcode && op < 0xfd) {
            if (/^OP_(\d+)$/.test(opcode)) {
              b.push(opcode.replace(/^OP_(\d+)$/, 'OP_PUSHNUM_$1'));
            } else {
              b.push(opcode);
            }
          } else {
            b.push('OP_RETURN_' + op);
          }
        }
        i += 1;
      }
    }

    return b.join(' ');
  }

  /**
   * This function must only be called when we know the witness we are parsing
   * is a taproot witness.
   * @param witness An array of hex strings that represents the witness stack of
   *                the input.
   * @returns null if the witness is not a script spend, and the hex string of
   *          the script item if it is a script spend.
   */
  public witnessToP2TRScript(witness: string[]): string | null {
    if (witness.length < 2) return null;
    // Note: see BIP341 for parsing details of witness stack

    // If there are at least two witness elements, and the first byte of the
    // last element is 0x50, this last element is called annex a and
    // is removed from the witness stack.
    const hasAnnex = witness[witness.length - 1].substring(0, 2) === '50';
    // If there are at least two witness elements left, script path spending is used.
    // Call the second-to-last stack element s, the script.
    // (Note: this phrasing from BIP341 assumes we've *removed* the annex from the stack)
    if (hasAnnex && witness.length < 3) return null;
    const positionOfScript = hasAnnex ? witness.length - 3 : witness.length - 2;
    return witness[positionOfScript];
  }

  // calculate the most parsimonious set of prioritizations given a list of block transactions
  // (i.e. the most likely prioritizations and deprioritizations)
  public identifyPrioritizedTransactions(transactions: any[], rateKey: string): { prioritized: string[], deprioritized: string[] } {
    // find the longest increasing subsequence of transactions
    // (adapted from https://en.wikipedia.org/wiki/Longest_increasing_subsequence#Efficient_algorithms)
    // should be O(n log n)
    const X = transactions.slice(1).reverse().map((tx) => ({ txid: tx.txid, rate: tx[rateKey] })); // standard block order is by *decreasing* effective fee rate, but we want to iterate in increasing order (and skip the coinbase)
    if (X.length < 2) {
      return { prioritized: [], deprioritized: [] };
    }
    const N = X.length;
    const P: number[] = new Array(N);
    const M: number[] = new Array(N + 1);
    M[0] = -1; // undefined so can be set to any value

    let L = 0;
    for (let i = 0; i < N; i++) {
      // Binary search for the smallest positive l ≤ L
      // such that X[M[l]].effectiveFeePerVsize > X[i].effectiveFeePerVsize
      let lo = 1;
      let hi = L + 1;
      while (lo < hi) {
        const mid = lo + Math.floor((hi - lo) / 2); // lo <= mid < hi
        if (X[M[mid]].rate > X[i].rate) {
          hi = mid;
        } else { // if X[M[mid]].effectiveFeePerVsize < X[i].effectiveFeePerVsize
          lo = mid + 1;
        }
      }

      // After searching, lo == hi is 1 greater than the
      // length of the longest prefix of X[i]
      const newL = lo;

      // The predecessor of X[i] is the last index of
      // the subsequence of length newL-1
      P[i] = M[newL - 1];
      M[newL] = i;

      if (newL > L) {
        // If we found a subsequence longer than any we've
        // found yet, update L
        L = newL;
      }
    }

    // Reconstruct the longest increasing subsequence
    // It consists of the values of X at the L indices:
    // ..., P[P[M[L]]], P[M[L]], M[L]
    const LIS: any[] = new Array(L);
    let k = M[L];
    for (let j = L - 1; j >= 0; j--) {
      LIS[j] = X[k];
      k = P[k];
    }

    const lisMap = new Map<string, number>();
    LIS.forEach((tx, index) => lisMap.set(tx.txid, index));

    const prioritized: string[] = [];
    const deprioritized: string[] = [];

    let lastRate = X[0].rate;

    for (const tx of X) {
      if (lisMap.has(tx.txid)) {
        lastRate = tx.rate;
      } else {
        if (Math.abs(tx.rate - lastRate) < 0.1) {
          // skip if the rate is almost the same as the previous transaction
        } else if (tx.rate <= lastRate) {
          prioritized.push(tx.txid);
        } else {
          deprioritized.push(tx.txid);
        }
      }
    }

    return { prioritized, deprioritized };
  }

  // Copied from https://github.com/mempool/mempool/blob/14e49126c3ca8416a8d7ad134a95c5e090324d69/backend/src/api/bitcoin/bitcoin-api.ts#L324
  public translateScriptPubKeyType(outputType: string): string {
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
  
}

export default new TransactionUtils();
