import { Application, Request, Response } from 'express';
import axios from 'axios';
import * as bitcoinjs from 'bitcoinjs-lib';
import config from '../../config';
import websocketHandler from '../websocket-handler';
import mempool from '../mempool';
import feeApi from '../fee-api';
import mempoolBlocks from '../mempool-blocks';
import bitcoinApi from './bitcoin-api-factory';
import { Common } from '../common';
import backendInfo from '../backend-info';
import transactionUtils from '../transaction-utils';
import { IEsploraApi } from './esplora-api.interface';
import loadingIndicators from '../loading-indicators';
import { TransactionExtended } from '../../mempool.interfaces';
import logger from '../../logger';
import blocks from '../blocks';
import bitcoinClient from './bitcoin-client';
import difficultyAdjustment from '../difficulty-adjustment';
import transactionRepository from '../../repositories/TransactionRepository';
import rbfCache from '../rbf-cache';
import { calculateMempoolTxCpfp } from '../cpfp';
import { handleError } from '../../utils/api';
import poolsUpdater from '../../tasks/pools-updater';

const TXID_REGEX = /^[a-f0-9]{64}$/i;
const BLOCK_HASH_REGEX = /^[a-f0-9]{64}$/i;
const ADDRESS_REGEX = /^[a-z0-9]{2,120}$/i;
const SCRIPT_HASH_REGEX = /^([a-f0-9]{2})+$/i;

class BitcoinRoutes {
  public initRoutes(app: Application) {
    app
      .get(config.MEMPOOL.API_URL_PREFIX + 'transaction-times', this.getTransactionTimes)
      .get(config.MEMPOOL.API_URL_PREFIX + 'cpfp/:txId', this.$getCpfpInfo)
      .get(config.MEMPOOL.API_URL_PREFIX + 'difficulty-adjustment', this.getDifficultyChange)
      .get(config.MEMPOOL.API_URL_PREFIX + 'fees/recommended', this.getRecommendedFees)
      .get(config.MEMPOOL.API_URL_PREFIX + 'fees/mempool-blocks', this.getMempoolBlocks)
      .get(config.MEMPOOL.API_URL_PREFIX + 'backend-info', this.getBackendInfo)
      .get(config.MEMPOOL.API_URL_PREFIX + 'init-data', this.getInitData)
      .get(config.MEMPOOL.API_URL_PREFIX + 'validate-address/:address', this.validateAddress)
      .get(config.MEMPOOL.API_URL_PREFIX + 'tx/:txId/rbf', this.getRbfHistory)
      .get(config.MEMPOOL.API_URL_PREFIX + 'tx/:txId/cached', this.getCachedTx)
      .get(config.MEMPOOL.API_URL_PREFIX + 'replacements', this.getRbfReplacements)
      .get(config.MEMPOOL.API_URL_PREFIX + 'fullrbf/replacements', this.getFullRbfReplacements)
      .post(config.MEMPOOL.API_URL_PREFIX + 'tx/push', this.$postTransactionForm)
      .get(config.MEMPOOL.API_URL_PREFIX + 'blocks', this.getBlocks.bind(this))
      .get(config.MEMPOOL.API_URL_PREFIX + 'blocks/:height', this.getBlocks.bind(this))
      .get(config.MEMPOOL.API_URL_PREFIX + 'block/:hash', this.getBlock)
      .get(config.MEMPOOL.API_URL_PREFIX + 'block/:hash/summary', this.getStrippedBlockTransactions)
      .get(config.MEMPOOL.API_URL_PREFIX + 'block/:hash/tx/:txid/summary', this.getStrippedBlockTransaction)
      .get(config.MEMPOOL.API_URL_PREFIX + 'block/:hash/audit-summary', this.getBlockAuditSummary)
      .get(config.MEMPOOL.API_URL_PREFIX + 'block/:hash/tx/:txid/audit', this.$getBlockTxAuditSummary)
      .get(config.MEMPOOL.API_URL_PREFIX + 'blocks/tip/height', this.getBlockTipHeight)
      .post(config.MEMPOOL.API_URL_PREFIX + 'psbt/addparents', this.postPsbtCompletion)
      .get(config.MEMPOOL.API_URL_PREFIX + 'blocks-bulk/:from', this.getBlocksByBulk.bind(this))
      .get(config.MEMPOOL.API_URL_PREFIX + 'blocks-bulk/:from/:to', this.getBlocksByBulk.bind(this))
      // Temporarily add txs/package endpoint for all backends until esplora supports it
      .post(config.MEMPOOL.API_URL_PREFIX + 'txs/package', this.$submitPackage)
      // Internal routes
      .get(config.MEMPOOL.API_URL_PREFIX + 'internal/blocks/definition/list', this.getBlockDefinitionHashes)
      .get(config.MEMPOOL.API_URL_PREFIX + 'internal/blocks/definition/current', this.getCurrentBlockDefinitionHash)
      .get(config.MEMPOOL.API_URL_PREFIX + 'internal/blocks/:definitionHash', this.getBlocksByDefinitionHash)
      ;

      if (config.MEMPOOL.BACKEND !== 'esplora') {
        app
          .get(config.MEMPOOL.API_URL_PREFIX + 'mempool', this.getMempool)
          .get(config.MEMPOOL.API_URL_PREFIX + 'mempool/txids', this.getMempoolTxIds)
          .get(config.MEMPOOL.API_URL_PREFIX + 'mempool/recent', this.getRecentMempoolTransactions)
          .get(config.MEMPOOL.API_URL_PREFIX + 'tx/:txId', this.getTransaction)
          .post(config.MEMPOOL.API_URL_PREFIX + 'tx', this.$postTransaction)
          .post(config.MEMPOOL.API_URL_PREFIX + 'txs/test', this.$testTransactions)
          .get(config.MEMPOOL.API_URL_PREFIX + 'tx/:txId/hex', this.getRawTransaction)
          .get(config.MEMPOOL.API_URL_PREFIX + 'tx/:txId/status', this.getTransactionStatus)
          .get(config.MEMPOOL.API_URL_PREFIX + 'tx/:txId/outspends', this.getTransactionOutspends)
          .get(config.MEMPOOL.API_URL_PREFIX + 'txs/outspends', this.$getBatchedOutspends)
          .get(config.MEMPOOL.API_URL_PREFIX + 'block/:hash/header', this.getBlockHeader)
          .get(config.MEMPOOL.API_URL_PREFIX + 'blocks/tip/hash', this.getBlockTipHash)
          .get(config.MEMPOOL.API_URL_PREFIX + 'block/:hash/raw', this.getRawBlock)
          .get(config.MEMPOOL.API_URL_PREFIX + 'block/:hash/txids', this.getTxIdsForBlock)
          .get(config.MEMPOOL.API_URL_PREFIX + 'block/:hash/txs', this.getBlockTransactions)
          .get(config.MEMPOOL.API_URL_PREFIX + 'block/:hash/txs/:index', this.getBlockTransactions)
          .get(config.MEMPOOL.API_URL_PREFIX + 'block-height/:height', this.getBlockHeight)
          .get(config.MEMPOOL.API_URL_PREFIX + 'address/:address', this.getAddress)
          .get(config.MEMPOOL.API_URL_PREFIX + 'address/:address/txs', this.getAddressTransactions)
          .get(config.MEMPOOL.API_URL_PREFIX + 'address/:address/txs/summary', this.getAddressTransactionSummary)
          .get(config.MEMPOOL.API_URL_PREFIX + 'scripthash/:scripthash', this.getScriptHash)
          .get(config.MEMPOOL.API_URL_PREFIX + 'scripthash/:scripthash/txs', this.getScriptHashTransactions)
          .get(config.MEMPOOL.API_URL_PREFIX + 'scripthash/:scripthash/txs/summary', this.getScriptHashTransactionSummary)
          .get(config.MEMPOOL.API_URL_PREFIX + 'address-prefix/:prefix', this.getAddressPrefix)
          ;
      }
  }


  private getInitData(req: Request, res: Response) {
    try {
      const result = websocketHandler.getSerializedInitData();
      res.set('Content-Type', 'application/json');
      res.send(result);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get init data');
    }
  }

  private getRecommendedFees(req: Request, res: Response) {
    if (!mempool.isInSync()) {
      res.statusCode = 503;
      res.send('Service Unavailable');
      return;
    }
    const result = feeApi.getRecommendedFee();
    res.json(result);
  }

  private getMempoolBlocks(req: Request, res: Response) {
    try {
      const result = mempoolBlocks.getMempoolBlocks();
      res.json(result);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get mempool blocks');
    }
  }

  private getTransactionTimes(req: Request, res: Response) {
    if (!Array.isArray(req.query.txId)) {
      handleError(req, res, 500, 'Not an array');
      return;
    }
    const txIds: string[] = [];
    for (const _txId in req.query.txId) {
      if (typeof req.query.txId[_txId] === 'string') {
        const txid = req.query.txId[_txId].toString();
        if (TXID_REGEX.test(txid)) {
          txIds.push(txid);
        }
      }
    }

    const times = mempool.getFirstSeenForTransactions(txIds);
    res.json(times);
  }

  private async $getBatchedOutspends(req: Request, res: Response): Promise<IEsploraApi.Outspend[][] | void> {
    const txids_csv = req.query.txids;
    if (!txids_csv || typeof txids_csv !== 'string') {
      handleError(req, res, 500, 'Invalid txids format');
      return;
    }
    const txids = txids_csv.split(',');
    if (txids.length > 50) {
      handleError(req, res, 400, 'Too many txids requested');
      return;
    }
    if (txids.some((txid) => !TXID_REGEX.test(txid))) {
      handleError(req, res, 400, 'Invalid txids format');
      return;
    }

    try {
      const batchedOutspends = await bitcoinApi.$getBatchedOutspends(txids);
      res.json(batchedOutspends);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get batched outspends');
    }
  }

  private async $getCpfpInfo(req: Request, res: Response) {
    if (!TXID_REGEX.test(req.params.txId)) {
      handleError(req, res, 501, `Invalid transaction ID`);
      return;
    }

    const tx = mempool.getMempool()[req.params.txId];
    if (tx) {
      if (tx?.cpfpChecked) {
        res.json({
          ancestors: tx.ancestors,
          bestDescendant: tx.bestDescendant || null,
          descendants: tx.descendants || null,
          effectiveFeePerVsize: tx.effectiveFeePerVsize || null,
          sigops: tx.sigops,
          fee: tx.fee,
          adjustedVsize: tx.adjustedVsize,
          acceleration: tx.acceleration,
          acceleratedBy: tx.acceleratedBy || undefined,
          acceleratedAt: tx.acceleratedAt || undefined,
          feeDelta: tx.feeDelta || undefined,
        });
        return;
      }

      const cpfpInfo = calculateMempoolTxCpfp(tx, mempool.getMempool());

      res.json(cpfpInfo);
      return;
    } else {
      let cpfpInfo;
      if (config.DATABASE.ENABLED) {
        try {
          cpfpInfo = await transactionRepository.$getCpfpInfo(req.params.txId);
        } catch (e) {
          handleError(req, res, 500, 'Failed to get CPFP info');
          return;
        }
      }
      if (cpfpInfo) {
        res.json(cpfpInfo);
        return;
      } else {
        res.json({
          ancestors: []
        });
        return;
      }
    }
  }

  private getBackendInfo(req: Request, res: Response) {
    res.json(backendInfo.getBackendInfo());
  }

  private async getTransaction(req: Request, res: Response) {
    if (!TXID_REGEX.test(req.params.txId)) {
      handleError(req, res, 501, `Invalid transaction ID`);
      return;
    }
    try {
      const transaction = await transactionUtils.$getTransactionExtended(req.params.txId, true, false, false, true);
      res.json(transaction);
    } catch (e) {
      let statusCode = 500;
      if (e instanceof Error && e instanceof Error && e.message && e.message.indexOf('No such mempool or blockchain transaction') > -1) {
        statusCode = 404;
        handleError(req, res, statusCode, 'No such mempool or blockchain transaction');
        return;
      }
      handleError(req, res, statusCode, 'Failed to get transaction');
    }
  }

  private async getRawTransaction(req: Request, res: Response) {
    if (!TXID_REGEX.test(req.params.txId)) {
      handleError(req, res, 501, `Invalid transaction ID`);
      return;
    }
    try {
      const transaction: IEsploraApi.Transaction = await bitcoinApi.$getRawTransaction(req.params.txId, true);
      res.setHeader('content-type', 'text/plain');
      res.send(transaction.hex);
    } catch (e) {
      let statusCode = 500;
      if (e instanceof Error && e.message && e.message.indexOf('No such mempool or blockchain transaction') > -1) {
        statusCode = 404;
        handleError(req, res, statusCode, 'No such mempool or blockchain transaction');
        return;
      }
      handleError(req, res, statusCode, 'Failed to get raw transaction');
    }
  }

  /**
   * Takes the PSBT as text/plain body, parses it, and adds the full
   * parent transaction to each input that doesn't already have it.
   * This is used for BTCPayServer / Trezor users which need access to
   * the full parent transaction even with segwit inputs.
   * It will respond with a text/plain PSBT in the same format (hex|base64).
   */
  private async postPsbtCompletion(req: Request, res: Response): Promise<void> {
    res.setHeader('content-type', 'text/plain');
    const notFoundError = `Couldn't get transaction hex for parent of input`;
    try {
      let psbt: bitcoinjs.Psbt;
      let format: 'hex' | 'base64';
      let isModified = false;
      try {
        psbt = bitcoinjs.Psbt.fromBase64(req.body);
        format = 'base64';
      } catch (e1) {
        try {
          psbt = bitcoinjs.Psbt.fromHex(req.body);
          format = 'hex';
        } catch (e2) {
          throw new Error(`Unable to parse PSBT`);
        }
      }
      for (const [index, input] of psbt.data.inputs.entries()) {
        if (!input.nonWitnessUtxo) {
          // Buffer.from ensures it won't be modified in place by reverse()
          const txid = Buffer.from(psbt.txInputs[index].hash)
            .reverse()
            .toString('hex');

          let transactionHex: string;
          // If missing transaction, return 404 status error
          try {
            transactionHex = await bitcoinApi.$getTransactionHex(txid);
            if (!transactionHex) {
              throw new Error('');
            }
          } catch (err) {
            throw new Error(`${notFoundError} #${index} @ ${txid}`);
          }

          psbt.updateInput(index, {
            nonWitnessUtxo: Buffer.from(transactionHex, 'hex'),
          });
          if (!isModified) {
            isModified = true;
          }
        }
      }
      if (isModified) {
        res.send(format === 'hex' ? psbt.toHex() : psbt.toBase64());
      } else {
        // Not modified
        // 422 Unprocessable Entity
        // https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/422
        handleError(req, res, 422, `Psbt had no missing nonWitnessUtxos.`);
      }
    } catch (e: any) {
      if (e instanceof Error && new RegExp(notFoundError).test(e.message)) {
        handleError(req, res, 404, notFoundError);
      } else {
        handleError(req, res, 500, 'Failed to process PSBT');
      }
    }
  }

  private async getTransactionStatus(req: Request, res: Response) {
    if (!TXID_REGEX.test(req.params.txId)) {
      handleError(req, res, 501, `Invalid transaction ID`);
      return;
    }
    try {
      const transaction = await transactionUtils.$getTransactionExtended(req.params.txId, true);
      res.json(transaction.status);
    } catch (e) {
      let statusCode = 500;
      if (e instanceof Error && e.message && e.message.indexOf('No such mempool or blockchain transaction') > -1) {
        statusCode = 404;
        handleError(req, res, statusCode, 'No such mempool or blockchain transaction');
        return;
      }
      handleError(req, res, statusCode, 'Failed to get transaction status');
    }
  }

  private async getStrippedBlockTransactions(req: Request, res: Response) {
    if (!BLOCK_HASH_REGEX.test(req.params.hash)) {
      handleError(req, res, 501, `Invalid block hash`);
      return;
    }
    try {
      const transactions = await blocks.$getStrippedBlockTransactions(req.params.hash);
      res.setHeader('Expires', new Date(Date.now() + 1000 * 3600 * 24 * 30).toUTCString());
      res.json(transactions);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get block summary');
    }
  }

  private async getStrippedBlockTransaction(req: Request, res: Response) {
    if (!BLOCK_HASH_REGEX.test(req.params.hash)) {
      handleError(req, res, 501, `Invalid block hash`);
      return;
    }
    if (!TXID_REGEX.test(req.params.txid)) {
      handleError(req, res, 501, `Invalid transaction ID`);
      return;
    }
    try {
      const transaction = await blocks.$getSingleTxFromSummary(req.params.hash, req.params.txid);
      if (!transaction) {
        handleError(req, res, 404, `Transaction not found in summary`);
        return;
      }
      res.setHeader('Expires', new Date(Date.now() + 1000 * 3600 * 24 * 30).toUTCString());
      res.json(transaction);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get transaction from summary');
    }
  }

  private async getBlock(req: Request, res: Response) {
    if (!BLOCK_HASH_REGEX.test(req.params.hash)) {
      handleError(req, res, 501, `Invalid block hash`);
      return;
    }
    try {
      const block = await blocks.$getBlock(req.params.hash);

      const blockAge = new Date().getTime() / 1000 - block.timestamp;
      const day = 24 * 3600;
      let cacheDuration;
      if (blockAge > 365 * day) {
        cacheDuration = 30 * day;
      } else if (blockAge > 30 * day) {
        cacheDuration = 10 * day;
      } else {
        cacheDuration = 600;
      }

      res.setHeader('Expires', new Date(Date.now() + 1000 * cacheDuration).toUTCString());
      res.json(block);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get block');
    }
  }

  private async getBlockHeader(req: Request, res: Response) {
    if (!BLOCK_HASH_REGEX.test(req.params.hash)) {
      handleError(req, res, 501, `Invalid block hash`);
      return;
    }
    try {
      const blockHeader = await bitcoinApi.$getBlockHeader(req.params.hash);
      res.setHeader('content-type', 'text/plain');
      res.send(blockHeader);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get block header');
    }
  }

  private async getBlockAuditSummary(req: Request, res: Response) {
    if (!BLOCK_HASH_REGEX.test(req.params.hash)) {
      handleError(req, res, 501, `Invalid block hash`);
      return;
    }
    try {
      const auditSummary = await blocks.$getBlockAuditSummary(req.params.hash);
      if (auditSummary) {
        res.setHeader('Expires', new Date(Date.now() + 1000 * 3600 * 24 * 30).toUTCString());
        res.json(auditSummary);
      } else {
        handleError(req, res, 404, `Audit not available`);
        return;
      }
    } catch (e) {
      handleError(req, res, 500, 'Failed to get block audit summary');
    }
  }

  private async $getBlockTxAuditSummary(req: Request, res: Response) {
    if (!BLOCK_HASH_REGEX.test(req.params.hash)) {
      handleError(req, res, 501, `Invalid block hash`);
      return;
    }
    if (!TXID_REGEX.test(req.params.txid)) {
      handleError(req, res, 501, `Invalid transaction ID`);
      return;
    }
    try {
      const auditSummary = await blocks.$getBlockTxAuditSummary(req.params.hash, req.params.txid);
      if (auditSummary) {
        res.setHeader('Expires', new Date(Date.now() + 1000 * 3600 * 24 * 30).toUTCString());
        res.json(auditSummary);
      } else {
        handleError(req, res, 404, `Transaction audit not available`);
        return;
      }
    } catch (e) {
      handleError(req, res, 500, 'Failed to get transaction audit summary');
    }
  }

  private async getBlocks(req: Request, res: Response) {
    try {
      if (['mainnet', 'testnet', 'signet'].includes(config.MEMPOOL.NETWORK)) { // Bitcoin
        const height = req.params.height === undefined ? undefined : parseInt(req.params.height, 10);
        res.setHeader('Expires', new Date(Date.now() + 1000 * 60).toUTCString());
        res.json(await blocks.$getBlocks(height, 15));
      } else { // Liquid
        return await this.getLegacyBlocks(req, res);
      }
    } catch (e) {
      handleError(req, res, 500, 'Failed to get blocks');
    }
  }

  private async getBlocksByBulk(req: Request, res: Response) {
    try {
      if (['mainnet', 'testnet', 'signet'].includes(config.MEMPOOL.NETWORK) === false) { // Liquid - Not implemented
        handleError(req, res, 404, `This API is only available for Bitcoin networks`);
        return;
      }
      if (config.MEMPOOL.MAX_BLOCKS_BULK_QUERY <= 0) {
        handleError(req, res, 404, `This API is disabled. Set config.MEMPOOL.MAX_BLOCKS_BULK_QUERY to a positive number to enable it.`);
        return;
      }
      if (!Common.indexingEnabled()) {
        handleError(req, res, 404, `Indexing is required for this API`);
        return;
      }

      const from = parseInt(req.params.from, 10);
      if (!req.params.from || from < 0) {
        handleError(req, res, 400, `Parameter 'from' must be a block height (integer)`);
        return;
      }
      const to = req.params.to === undefined ? await bitcoinApi.$getBlockHeightTip() : parseInt(req.params.to, 10);
      if (to < 0) {
        handleError(req, res, 400, `Parameter 'to' must be a block height (integer)`);
        return;
      }
      if (from > to) {
        handleError(req, res, 400, `Parameter 'to' must be a higher block height than 'from'`);
        return;
      }
      if ((to - from + 1) > config.MEMPOOL.MAX_BLOCKS_BULK_QUERY) {
        handleError(req, res, 400, `You can only query ${config.MEMPOOL.MAX_BLOCKS_BULK_QUERY} blocks at once.`);
        return;
      }

      res.setHeader('Expires', new Date(Date.now() + 1000 * 60).toUTCString());
      res.json(await blocks.$getBlocksBetweenHeight(from, to));

    } catch (e) {
      handleError(req, res, 500, 'Failed to get blocks');
    }
  }

  private async getLegacyBlocks(req: Request, res: Response) {
    try {
      const returnBlocks: IEsploraApi.Block[] = [];
      const tip = blocks.getCurrentBlockHeight();
      const fromHeight = Math.min(parseInt(req.params.height, 10) || tip, tip);

      // Check if block height exist in local cache to skip the hash lookup
      const blockByHeight = blocks.getBlocks().find((b) => b.height === fromHeight);
      let startFromHash: string | null = null;
      if (blockByHeight) {
        startFromHash = blockByHeight.id;
      } else {
        startFromHash = await bitcoinApi.$getBlockHash(fromHeight);
      }

      let nextHash = startFromHash;
      for (let i = 0; i < 15 && nextHash; i++) {
        const localBlock = blocks.getBlocks().find((b) => b.id === nextHash);
        if (localBlock) {
          returnBlocks.push(localBlock);
          nextHash = localBlock.previousblockhash;
        } else {
          const block = await bitcoinApi.$getBlock(nextHash);
          returnBlocks.push(block);
          nextHash = block.previousblockhash;
        }
      }

      res.setHeader('Expires', new Date(Date.now() + 1000 * 60).toUTCString());
      res.json(returnBlocks);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get blocks');
    }
  }

  private async getBlockTransactions(req: Request, res: Response) {
    if (!BLOCK_HASH_REGEX.test(req.params.hash)) {
      handleError(req, res, 501, `Invalid block hash`);
      return;
    }
    try {
      loadingIndicators.setProgress('blocktxs-' + req.params.hash, 0);

      const txIds = await bitcoinApi.$getTxIdsForBlock(req.params.hash);
      const transactions: TransactionExtended[] = [];
      const startingIndex = Math.max(0, parseInt(req.params.index || '0', 10));

      const endIndex = Math.min(startingIndex + 10, txIds.length);
      for (let i = startingIndex; i < endIndex; i++) {
        try {
          const transaction = await transactionUtils.$getTransactionExtended(txIds[i], true, true);
          transactions.push(transaction);
          loadingIndicators.setProgress('blocktxs-' + req.params.hash, (i - startingIndex + 1) / (endIndex - startingIndex) * 100);
        } catch (e) {
          logger.debug('getBlockTransactions error: ' + (e instanceof Error ? e.message : e));
        }
      }
      res.json(transactions);
    } catch (e) {
      loadingIndicators.setProgress('blocktxs-' + req.params.hash, 100);
      handleError(req, res, 500, 'Failed to get block transactions');
    }
  }

  private async getBlockHeight(req: Request, res: Response) {
    try {
      const blockHash = await bitcoinApi.$getBlockHash(parseInt(req.params.height, 10));
      res.send(blockHash);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get block at height');
    }
  }

  private async getAddress(req: Request, res: Response) {
    if (config.MEMPOOL.BACKEND === 'none') {
      handleError(req, res, 405, 'Address lookups cannot be used with bitcoind as backend.');
      return;
    }
    if (!ADDRESS_REGEX.test(req.params.address)) {
      handleError(req, res, 501, `Invalid address`);
      return;
    }

    try {
      const addressData = await bitcoinApi.$getAddress(req.params.address);
      res.json(addressData);
    } catch (e) {
      if (e instanceof Error && e.message && (e.message.indexOf('too long') > 0 || e.message.indexOf('confirmed status') > 0)) {
        handleError(req, res, 413, e.message);
        return;
      }
      handleError(req, res, 500, 'Failed to get address');
    }
  }

  private async getAddressTransactions(req: Request, res: Response): Promise<void> {
    if (config.MEMPOOL.BACKEND === 'none') {
      handleError(req, res, 405, 'Address lookups cannot be used with bitcoind as backend.');
      return;
    }
    if (!ADDRESS_REGEX.test(req.params.address)) {
      handleError(req, res, 501, `Invalid address`);
      return;
    }

    try {
      let lastTxId: string = '';
      if (req.query.after_txid && typeof req.query.after_txid === 'string') {
        lastTxId = req.query.after_txid;
      }
      const transactions = await bitcoinApi.$getAddressTransactions(req.params.address, lastTxId);
      res.json(transactions);
    } catch (e) {
      if (e instanceof Error && e.message && (e.message.indexOf('too long') > 0 || e.message.indexOf('confirmed status') > 0)) {
        handleError(req, res, 413, e.message);
        return;
      }
      handleError(req, res, 500, 'Failed to get address transactions');
    }
  }

  private async getAddressTransactionSummary(req: Request, res: Response): Promise<void> {
    if (config.MEMPOOL.BACKEND !== 'esplora') {
      handleError(req, res, 405, 'Address summary lookups require mempool/electrs backend.');
      return;
    }
  }

  private async getScriptHash(req: Request, res: Response) {
    if (config.MEMPOOL.BACKEND === 'none') {
      handleError(req, res, 405, 'Address lookups cannot be used with bitcoind as backend.');
      return;
    }
    if (!SCRIPT_HASH_REGEX.test(req.params.scripthash)) {
      handleError(req, res, 501, `Invalid scripthash`);
      return;
    }

    try {
      // electrum expects scripthashes in little-endian
      const electrumScripthash = req.params.scripthash.match(/../g)?.reverse().join('') ?? '';
      const addressData = await bitcoinApi.$getScriptHash(electrumScripthash);
      res.json(addressData);
    } catch (e) {
      if (e instanceof Error && e.message && (e.message.indexOf('too long') > 0 || e.message.indexOf('confirmed status') > 0)) {
        handleError(req, res, 413, e.message);
        return;
      }
      handleError(req, res, 500, 'Failed to get script hash');
    }
  }

  private async getScriptHashTransactions(req: Request, res: Response): Promise<void> {
    if (config.MEMPOOL.BACKEND === 'none') {
      handleError(req, res, 405, 'Address lookups cannot be used with bitcoind as backend.');
      return;
    }
    if (!SCRIPT_HASH_REGEX.test(req.params.scripthash)) {
      handleError(req, res, 501, `Invalid scripthash`);
      return;
    }

    try {
      // electrum expects scripthashes in little-endian
      const electrumScripthash = req.params.scripthash.match(/../g)?.reverse().join('') ?? '';
      let lastTxId: string = '';
      if (req.query.after_txid && typeof req.query.after_txid === 'string') {
        lastTxId = req.query.after_txid;
      }
      const transactions = await bitcoinApi.$getScriptHashTransactions(electrumScripthash, lastTxId);
      res.json(transactions);
    } catch (e) {
      if (e instanceof Error && e.message && (e.message.indexOf('too long') > 0 || e.message.indexOf('confirmed status') > 0)) {
        handleError(req, res, 413, e.message);
        return;
      }
      handleError(req, res, 500, 'Failed to get script hash transactions');
    }
  }

  private async getScriptHashTransactionSummary(req: Request, res: Response): Promise<void> {
    if (config.MEMPOOL.BACKEND !== 'esplora') {
      handleError(req, res, 405, 'Scripthash summary lookups require mempool/electrs backend.');
      return;
    }
  }

  private async getAddressPrefix(req: Request, res: Response) {
    try {
      const addressPrefix = await bitcoinApi.$getAddressPrefix(req.params.prefix);
      res.send(addressPrefix);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get address prefix');
    }
  }

  private async getRecentMempoolTransactions(req: Request, res: Response) {
    const latestTransactions = Object.entries(mempool.getMempool())
      .sort((a, b) => (b[1].firstSeen || 0) - (a[1].firstSeen || 0))
      .slice(0, 10).map((tx) => Common.stripTransaction(tx[1]));

    res.json(latestTransactions);
  }

  private async getMempool(req: Request, res: Response) {
    const info = mempool.getMempoolInfo();
    res.json({
      count: info.size,
      vsize: info.bytes,
      total_fee: info.total_fee * 1e8,
      fee_histogram: []
    });
  }

  private async getMempoolTxIds(req: Request, res: Response) {
    try {
      const rawMempool = await bitcoinApi.$getRawMempool();
      res.send(rawMempool);
    } catch (e) {
      handleError(req, res, 500, e instanceof Error ? e.message : e);
    }
  }

  private async getBlockDefinitionHashes(req: Request, res: Response): Promise<void> {
    try {
      const result = await blocks.$getBlockDefinitionHashes();
      if (!result) {
        handleError(req, res, 503, `Service Temporarily Unavailable`);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.send(result);
    } catch (e) {
      handleError(req, res, 500, e instanceof Error ? e.message : e);
    }
  }

  private async getCurrentBlockDefinitionHash(req: Request, res: Response): Promise<void> {
    try {
      const currentSha = await poolsUpdater.getShaFromDb();
      if (!currentSha) {
        handleError(req, res, 503, `Service Temporarily Unavailable`);
        return;
      }
      res.setHeader('content-type', 'text/plain');
      res.send(currentSha);
    } catch (e) {
      handleError(req, res, 500, e instanceof Error ? e.message : e);
    }
  }

  private async getBlocksByDefinitionHash(req: Request, res: Response): Promise<void> {
    try {
      if (typeof(req.params.definitionHash) !== 'string') {
        res.status(400).send('Parameter "hash" must be a valid string');
        return;
      }
      const blocksHash = await blocks.$getBlocksByDefinitionHash(req.params.definitionHash as string);
      if (!blocksHash) {
        handleError(req, res, 503, `Service Temporarily Unavailable`);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.send(blocksHash);
    } catch (e) {
      handleError(req, res, 500, e instanceof Error ? e.message : e);
    }
  }

  private getBlockTipHeight(req: Request, res: Response) {
    try {
      const result = blocks.getCurrentBlockHeight();
      if (!result) {
        handleError(req, res, 503, `Service Temporarily Unavailable`);
        return;
      }
      res.setHeader('content-type', 'text/plain');
      res.send(result.toString());
    } catch (e) {
      handleError(req, res, 500, 'Failed to get height at tip');
    }
  }

  private async getBlockTipHash(req: Request, res: Response) {
    try {
      const result = await bitcoinApi.$getBlockHashTip();
      res.setHeader('content-type', 'text/plain');
      res.send(result);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get hash at tip');
    }
  }

  private async getRawBlock(req: Request, res: Response) {
    if (!BLOCK_HASH_REGEX.test(req.params.hash)) {
      handleError(req, res, 501, `Invalid block hash`);
      return;
    }
    try {
      const result = await bitcoinApi.$getRawBlock(req.params.hash);
      res.setHeader('content-type', 'application/octet-stream');
      res.send(result);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get raw block');
    }
  }

  private async getTxIdsForBlock(req: Request, res: Response) {
    if (!BLOCK_HASH_REGEX.test(req.params.hash)) {
      handleError(req, res, 501, `Invalid block hash`);
      return;
    }
    try {
      const result = await bitcoinApi.$getTxIdsForBlock(req.params.hash);
      res.json(result);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get txids for block');
    }
  }

  private async validateAddress(req: Request, res: Response) {
    if (!ADDRESS_REGEX.test(req.params.address)) {
      handleError(req, res, 501, `Invalid address`);
      return;
    }
    try {
      const result = await bitcoinClient.validateAddress(req.params.address);
      res.json(result);
    } catch (e) {
      handleError(req, res, 500, 'Failed to validate address');
    }
  }

  private async getRbfHistory(req: Request, res: Response) {
    if (!TXID_REGEX.test(req.params.txId)) {
      handleError(req, res, 501, `Invalid transaction ID`);
      return;
    }
    try {
      const replacements = rbfCache.getRbfTree(req.params.txId) || null;
      const replaces = rbfCache.getReplaces(req.params.txId) || null;
      res.json({
        replacements,
        replaces
      });
    } catch (e) {
      handleError(req, res, 500, 'Failed to get rbf history');
    }
  }

  private async getRbfReplacements(req: Request, res: Response) {
    try {
      const result = rbfCache.getRbfTrees(false);
      res.json(result);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get rbf trees');
    }
  }

  private async getFullRbfReplacements(req: Request, res: Response) {
    try {
      const result = rbfCache.getRbfTrees(true);
      res.json(result);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get full rbf replacements');
    }
  }

  private async getCachedTx(req: Request, res: Response) {
    if (!TXID_REGEX.test(req.params.txId)) {
      handleError(req, res, 501, `Invalid transaction ID`);
      return;
    }
    try {
      const result = rbfCache.getTx(req.params.txId);
      if (result) {
        res.json(result);
      } else {
        res.status(204).send();
      }
    } catch (e) {
      handleError(req, res, 500, 'Failed to get cached tx');
    }
  }

  private async getTransactionOutspends(req: Request, res: Response) {
    if (!TXID_REGEX.test(req.params.txId)) {
      handleError(req, res, 501, `Invalid transaction ID`);
      return;
    }
    try {
      const result = await bitcoinApi.$getOutspends(req.params.txId);
      res.json(result);
    } catch (e) {
      handleError(req, res, 500, 'Failed to get transaction outspends');
    }
  }

  private getDifficultyChange(req: Request, res: Response) {
    try {
      const da = difficultyAdjustment.getDifficultyAdjustment();
      if (da) {
        res.json(da);
      } else {
        handleError(req, res, 503, `Service Temporarily Unavailable`);
      }
    } catch (e) {
      handleError(req, res, 500, 'Failed to get difficulty change');
    }
  }

  private async $postTransaction(req: Request, res: Response) {
    res.setHeader('content-type', 'text/plain');
    try {
      const rawTx = Common.getTransactionFromRequest(req, false);
      const txIdResult = await bitcoinApi.$sendRawTransaction(rawTx);
      res.send(txIdResult);
    } catch (e: any) {
      handleError(req, res, 400, (e.message && e.code) ? 'sendrawtransaction RPC error: ' + JSON.stringify({ code: e.code })
        : 'Failed to send raw transaction');
    }
  }

  private async $postTransactionForm(req: Request, res: Response) {
    res.setHeader('content-type', 'text/plain');
    try {
      const txHex = Common.getTransactionFromRequest(req, true);
      const txIdResult = await bitcoinClient.sendRawTransaction(txHex);
      res.send(txIdResult);
    } catch (e: any) {
      handleError(req, res, 400, (e.message && e.code) ? 'sendrawtransaction RPC error: ' + JSON.stringify({ code: e.code })
        : 'Failed to send raw transaction');
    }
  }

  private async $testTransactions(req: Request, res: Response) {
    try {
      const rawTxs = Common.getTransactionsFromRequest(req);
      const maxfeerate = parseFloat(req.query.maxfeerate as string);
      const result = await bitcoinApi.$testMempoolAccept(rawTxs, maxfeerate);
      res.send(result);
    } catch (e: any) {
      handleError(req, res, 400, (e.message && e.code) ? 'testmempoolaccept RPC error: ' + JSON.stringify({ code: e.code })
        : 'Failed to test transactions');
    }
  }

  private async $submitPackage(req: Request, res: Response) {
    try {
      const rawTxs = Common.getTransactionsFromRequest(req);
      const maxfeerate = parseFloat(req.query.maxfeerate as string);
      const maxburnamount = parseFloat(req.query.maxburnamount as string);
      const result = await bitcoinClient.submitPackage(rawTxs, maxfeerate ?? undefined, maxburnamount ?? undefined);
      res.send(result);
    } catch (e: any) {
      handleError(req, res, 400, (e.message && e.code) ? 'submitpackage RPC error: ' + JSON.stringify({ code: e.code })
        : 'Failed to submit package');
    }
  }

}

export default new BitcoinRoutes();
