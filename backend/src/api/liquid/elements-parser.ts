import { IBitcoinApi } from '../bitcoin/bitcoin-api.interface';
import bitcoinClient from '../bitcoin/bitcoin-client';
import bitcoinSecondClient from '../bitcoin/bitcoin-second-client';
import { Common } from '../common';
import DB from '../../database';
import logger from '../../logger';

const federationChangeAddresses = ['bc1qxvay4an52gcghxq5lavact7r6qe9l4laedsazz8fj2ee2cy47tlqff4aj4', '3EiAcrzq1cELXScc98KeCswGWZaPGceT1d'];
const auditBlockOffsetWithTip = 1; // Wait for 1 block confirmation before processing the block in the audit process to reduce the risk of reorgs

class ElementsParser {
  private isRunning = false;
  private isUtxosUpdatingRunning = false;

  constructor() { }

  public async $parse() {
    if (this.isRunning) {
      return;
    }
    try {
      this.isRunning = true;
      const result = await bitcoinClient.getChainTips();
      const tip = result[0].height;
      const latestBlockHeight = await this.$getLatestBlockHeightFromDatabase();
      for (let height = latestBlockHeight + 1; height <= tip; height++) {
        const blockHash: IBitcoinApi.ChainTips = await bitcoinClient.getBlockHash(height);
        const block: IBitcoinApi.Block = await bitcoinClient.getBlock(blockHash, 2);
        await this.$parseBlock(block);
        await this.$saveLatestBlockToDatabase(block.height);
      }
      this.isRunning = false;
    } catch (e) {
      this.isRunning = false;
      throw new Error(e instanceof Error ? e.message : 'Error');
    }
  }

  protected async $parseBlock(block: IBitcoinApi.Block) {
    for (const tx of block.tx) {
      await this.$parseInputs(tx, block);
      await this.$parseOutputs(tx, block);
    }
  }

  protected async $parseInputs(tx: IBitcoinApi.Transaction, block: IBitcoinApi.Block) {
    for (const [index, input] of tx.vin.entries()) {
      if (input.is_pegin) {
        await this.$parsePegIn(input, index, tx.txid, block);
      }
    }
  }

  protected async $parsePegIn(input: IBitcoinApi.Vin, vindex: number, txid: string, block: IBitcoinApi.Block) {
    const bitcoinTx: IBitcoinApi.Transaction = await bitcoinSecondClient.getRawTransaction(input.txid, true);
    const bitcoinBlock: IBitcoinApi.Block = await bitcoinSecondClient.getBlock(bitcoinTx.blockhash);
    const prevout = bitcoinTx.vout[input.vout || 0];
    const outputAddress = prevout.scriptPubKey.address || (prevout.scriptPubKey.addresses && prevout.scriptPubKey.addresses[0]) || '';
    await this.$savePegToDatabase(block.height, block.time, prevout.value * 100000000, txid, vindex,
      outputAddress, bitcoinTx.txid, prevout.n, bitcoinBlock.height, bitcoinBlock.time, 1);
  }

  protected async $parseOutputs(tx: IBitcoinApi.Transaction, block: IBitcoinApi.Block) {
    for (const output of tx.vout) {
      if (output.scriptPubKey.pegout_chain) {
        await this.$savePegToDatabase(block.height, block.time, 0 - output.value * 100000000, tx.txid, output.n,
          (output.scriptPubKey.pegout_address || ''), '', 0, 0, 0, 0);
      }
      if (!output.scriptPubKey.pegout_chain && output.scriptPubKey.type === 'nulldata'
        && output.value && output.value > 0 && output.asset && output.asset === Common.nativeAssetId) {
        await this.$savePegToDatabase(block.height, block.time, 0 - output.value * 100000000, tx.txid, output.n,
          (output.scriptPubKey.pegout_address || ''), '', 0, 0, 0, 1);
      }
    }
  }

  protected async $savePegToDatabase(height: number, blockTime: number, amount: number, txid: string,
    txindex: number, bitcoinaddress: string, bitcointxid: string, bitcoinindex: number, bitcoinblock: number, bitcoinBlockTime: number, final_tx: number): Promise<void> {
    const query = `INSERT IGNORE INTO elements_pegs(
        block, datetime, amount, txid, txindex, bitcoinaddress, bitcointxid, bitcoinindex, final_tx
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const params: (string | number)[] = [
      height, blockTime, amount, txid, txindex, bitcoinaddress, bitcointxid, bitcoinindex, final_tx
    ];
    await DB.query(query, params);
    logger.debug(`Saved L-BTC peg from Liquid block height #${height} with TXID ${txid}.`);

    if (amount > 0) { // Peg-in
  
      // Add the address to the federation addresses table
      await DB.query(`INSERT IGNORE INTO federation_addresses (bitcoinaddress) VALUES (?)`, [bitcoinaddress]);

      // Add the UTXO to the federation txos table
      const query_utxos = `INSERT IGNORE INTO federation_txos (txid, txindex, bitcoinaddress, amount, blocknumber, blocktime, unspent, lastblockupdate, lasttimeupdate, timelock, expiredAt, emergencyKey, pegtxid, pegindex, pegblocktime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      const params_utxos: (string | number)[] = [bitcointxid, bitcoinindex, bitcoinaddress, amount, bitcoinblock, bitcoinBlockTime, 1, bitcoinblock - 1, 0, 4032, 0, 0, txid, txindex, blockTime];
      await DB.query(query_utxos, params_utxos);
      const [minBlockUpdate] = await DB.query(`SELECT MIN(lastblockupdate) AS lastblockupdate FROM federation_txos WHERE unspent = 1`)
      await this.$saveLastBlockAuditToDatabase(minBlockUpdate[0]['lastblockupdate']);
      logger.debug(`Saved new Federation UTXO ${bitcointxid}:${bitcoinindex} belonging to ${bitcoinaddress} to federation txos`);

    }
  }

  protected async $getLatestBlockHeightFromDatabase(): Promise<number> {
    const query = `SELECT number FROM state WHERE name = 'last_elements_block'`;
    const [rows] = await DB.query(query);
    return rows[0]['number'];
  }

  protected async $saveLatestBlockToDatabase(blockHeight: number) {
    const query = `UPDATE state SET number = ? WHERE name = 'last_elements_block'`;
    await DB.query(query, [blockHeight]);
  }

  ///////////// FEDERATION AUDIT //////////////

  public async $updateFederationUtxos() {
    if (this.isUtxosUpdatingRunning) {
      return;
    }

    this.isUtxosUpdatingRunning = true;

    try {
      let auditProgress = await this.$getAuditProgress();
      // If no peg in transaction was found in the database, return
      if (!auditProgress.lastBlockAudit) {
        logger.debug(`No Federation UTXOs found in the database. Waiting for some to be confirmed before starting the Federation UTXOs audit`);
        this.isUtxosUpdatingRunning = false;
        return;
      }

      const bitcoinBlocksToSync = await this.$getBitcoinBlockchainState();
      // If the bitcoin blockchain is not synced yet, return
      if (bitcoinBlocksToSync.bitcoinHeaders > bitcoinBlocksToSync.bitcoinBlocks + 1) {
        logger.debug(`Bitcoin client is not synced yet. ${bitcoinBlocksToSync.bitcoinHeaders - bitcoinBlocksToSync.bitcoinBlocks} blocks remaining to sync before the Federation audit process can start`);
        this.isUtxosUpdatingRunning = false;
        return;
      }

      auditProgress.lastBlockAudit++;

      // Logging
      let indexedThisRun = 0;
      let timer = Date.now() / 1000;
      const startedAt = Date.now() / 1000;
      const indexingSpeeds: number[] = [];

      while (auditProgress.lastBlockAudit <= auditProgress.confirmedTip) {

        // First, get the current UTXOs that need to be scanned in the block
        const utxos = await this.$getFederationUtxosToScan(auditProgress.lastBlockAudit);

        // Get the peg-out addresses that need to be scanned
        const redeemAddresses = await this.$getRedeemAddressesToScan();

        // The fast way: check if these UTXOs are still unspent as of the current block with gettxout
        let spentAsTip: any[];
        let unspentAsTip: any[];
        if (auditProgress.confirmedTip - auditProgress.lastBlockAudit <= 150) { // If the audit status is not too far in the past, we can use gettxout (fast way)
          const utxosToParse = await this.$getFederationUtxosToParse(utxos);
          spentAsTip = utxosToParse.spentAsTip;
          unspentAsTip = utxosToParse.unspentAsTip;
          logger.debug(`Found ${utxos.length} Federation UTXOs and ${redeemAddresses.length} Peg-Out Addresses to scan in Bitcoin block height #${auditProgress.lastBlockAudit} / #${auditProgress.confirmedTip}`);
          logger.debug(`${unspentAsTip.length} / ${utxos.length} Federation UTXOs are unspent as of tip`);
        } else { // If the audit status is too far in the past, it is useless and wasteful to look for still unspent txos since they will all be spent as of the tip
          spentAsTip = utxos;
          unspentAsTip = [];

          // Logging
          const elapsedSeconds = (Date.now() / 1000) - timer;
          if (elapsedSeconds > 5) {
            const runningFor = (Date.now() / 1000) - startedAt;
            const blockPerSeconds = indexedThisRun / elapsedSeconds;
            indexingSpeeds.push(blockPerSeconds);
            if (indexingSpeeds.length > 100) indexingSpeeds.shift(); // Keep the length of the up to 100 last indexing speeds
            const meanIndexingSpeed = indexingSpeeds.reduce((a, b) => a + b, 0) / indexingSpeeds.length;
            const eta = (auditProgress.confirmedTip - auditProgress.lastBlockAudit) / meanIndexingSpeed;
            logger.debug(`Scanning ${utxos.length} Federation UTXOs and ${redeemAddresses.length} Peg-Out Addresses at Bitcoin block height #${auditProgress.lastBlockAudit} / #${auditProgress.confirmedTip} | ~${meanIndexingSpeed.toFixed(2)} blocks/sec | elapsed: ${(runningFor / 60).toFixed(0)} minutes | ETA: ${(eta / 60).toFixed(0)} minutes`);
            timer = Date.now() / 1000;
            indexedThisRun = 0;
          }
        }

        // The slow way: parse the block to look for the spending tx
        const blockHash: IBitcoinApi.ChainTips = await bitcoinSecondClient.getBlockHash(auditProgress.lastBlockAudit);
        const block: IBitcoinApi.Block = await bitcoinSecondClient.getBlock(blockHash, 2);
        await this.$parseBitcoinBlock(block, spentAsTip, unspentAsTip, auditProgress.confirmedTip, redeemAddresses);

        // Finally, update the lastblockupdate of the remaining UTXOs and save to the database
        const [minBlockUpdate] = await DB.query(`SELECT MIN(lastblockupdate) AS lastblockupdate FROM federation_txos WHERE unspent = 1`)
        await this.$saveLastBlockAuditToDatabase(minBlockUpdate[0]['lastblockupdate']);

        auditProgress = await this.$getAuditProgress();
        auditProgress.lastBlockAudit++;
        indexedThisRun++;
      }

      this.isUtxosUpdatingRunning = false;
    } catch (e) {
      this.isUtxosUpdatingRunning = false;
      throw new Error(e instanceof Error ? e.message : 'Error');
    } 
  }

  // Get the UTXOs that need to be scanned in block height (UTXOs that were last updated in the block height - 1)
  protected async $getFederationUtxosToScan(height: number) { 
    const query = `SELECT txid, txindex, bitcoinaddress, amount, blocknumber, timelock, expiredAt FROM federation_txos WHERE lastblockupdate = ? AND unspent = 1`;
    const [rows] = await DB.query(query, [height - 1]);
    return rows as any[];
  }

  // Returns the UTXOs that are spent as of tip and need to be scanned
  protected async $getFederationUtxosToParse(utxos: any[]): Promise<any> {
    const spentAsTip: any[] = [];
    const unspentAsTip: any[] = [];

    for (const utxo of utxos) {
      const result = await bitcoinSecondClient.getTxOut(utxo.txid, utxo.txindex, false);
      result ? unspentAsTip.push(utxo) : spentAsTip.push(utxo);
    }
    
    return {spentAsTip, unspentAsTip};
  }

  protected async $parseBitcoinBlock(block: IBitcoinApi.Block, spentAsTip: any[], unspentAsTip: any[], confirmedTip: number, redeemAddressesData: any[] = []) {
    const redeemAddresses: string[] = redeemAddressesData.map(redeemAddress => redeemAddress.bitcoinaddress);
    for (const tx of block.tx) {
      let mightRedeemInThisTx = false;
      // Check if the Federation UTXOs that was spent as of tip are spent in this block
      for (const input of tx.vin) {
        const txo = spentAsTip.find(txo => txo.txid === input.txid && txo.txindex === input.vout);
        if (txo) {
          mightRedeemInThisTx = true; // A Federation UTXO is spent in this block: we might find a peg-out address in the outputs
          if (txo.expiredAt > 0 ) {
            if (input.txinwitness?.length !== 13) { // Check if the witness data of the input contains the 11 signatures: if it doesn't, emergency keys are being used
              await DB.query(`UPDATE federation_txos SET unspent = 0, lastblockupdate = ?, lasttimeupdate = ?, emergencyKey = 1 WHERE txid = ? AND txindex = ?`, [block.height, block.time, txo.txid, txo.txindex]);
              logger.debug(`Expired Federation UTXO ${txo.txid}:${txo.txindex} (${txo.amount} sats) was spent in block ${block.height} using emergency keys!`);
             } else {
              await DB.query(`UPDATE federation_txos SET unspent = 0, lastblockupdate = ?, lasttimeupdate = ? WHERE txid = ? AND txindex = ?`, [block.height, block.time, txo.txid, txo.txindex]);
              logger.debug(`Expired Federation UTXO ${txo.txid}:${txo.txindex} (${txo.amount} sats) was spent in block ${block.height} using regular 11-of-15 signatures`);
            }
          } else {
            await DB.query(`UPDATE federation_txos SET unspent = 0, lastblockupdate = ?, lasttimeupdate = ? WHERE txid = ? AND txindex = ?`, [block.height, block.time, txo.txid, txo.txindex]);
            logger.debug(`Federation UTXO ${txo.txid}:${txo.txindex} (${txo.amount} sats) was spent in block ${block.height}`);
          }
          // Remove the TXO from the utxo array
          spentAsTip.splice(spentAsTip.indexOf(txo), 1);
        }
      }
      // Check if an output is sent to a change address of the federation
      for (const output of tx.vout) {
        if (output.scriptPubKey.address && federationChangeAddresses.includes(output.scriptPubKey.address)) {
          // Check that the UTXO was not already added in the DB by previous scans
          const [rows_check] = await DB.query(`SELECT txid FROM federation_txos WHERE txid = ? AND txindex = ?`, [tx.txid, output.n]) as any[];
          if (rows_check.length === 0) {
            const timelock = output.scriptPubKey.address === federationChangeAddresses[0] ? 4032 : 2016; // P2WSH change address has a 4032 timelock, P2SH change address has a 2016 timelock
            const query_utxos = `INSERT INTO federation_txos (txid, txindex, bitcoinaddress, amount, blocknumber, blocktime, unspent, lastblockupdate, lasttimeupdate, timelock, expiredAt, emergencyKey, pegtxid, pegindex, pegblocktime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            const params_utxos: (string | number)[] = [tx.txid, output.n, output.scriptPubKey.address, output.value * 100000000, block.height, block.time, 1, block.height, 0, timelock, 0, 0, '', 0, 0];
            await DB.query(query_utxos, params_utxos);
            // Add the UTXO to the utxo array
            spentAsTip.push({
              txid: tx.txid,
              txindex: output.n,
              bitcoinaddress: output.scriptPubKey.address,
              amount: output.value * 100000000,
              blocknumber: block.height,
              timelock: timelock,
              expiredAt: 0,
            });
            logger.debug(`Added new Federation UTXO ${tx.txid}:${output.n} (${Math.round(output.value * 100000000)} sats), change address: ${output.scriptPubKey.address}`);
          }
        }
        if (mightRedeemInThisTx && output.scriptPubKey.address && redeemAddresses.includes(output.scriptPubKey.address)) {
          // Find the number of times output.scriptPubKey.address appears in redeemAddresses. There can be address reuse for peg-outs...
          const matchingAddress: any[] = redeemAddressesData.filter(redeemAddress => redeemAddress.bitcoinaddress === output.scriptPubKey.address && -redeemAddress.amount === Math.round(output.value * 100000000));
          if (matchingAddress.length > 0) {
            if (matchingAddress.length > 1) {
              // If there are more than one peg out address with the same amount, we can't know which one redeemed the UTXO: we take the oldest one
              matchingAddress.sort((a, b) => a.datetime - b.datetime);
              logger.debug(`Found redeem txid ${tx.txid}:${output.n} to peg-out address ${matchingAddress[0].bitcoinaddress}, amount ${matchingAddress[0].amount}, datetime ${matchingAddress[0].datetime}`);
            } else {
              logger.debug(`Found redeem txid ${tx.txid}:${output.n} to peg-out address ${matchingAddress[0].bitcoinaddress}, amount ${matchingAddress[0].amount}`);
            }
            const query_add_redeem = `UPDATE elements_pegs SET bitcointxid = ?, bitcoinindex = ? WHERE bitcoinaddress = ? AND amount = ? AND datetime = ?`;
            const params_add_redeem: (string | number)[] = [tx.txid, output.n, matchingAddress[0].bitcoinaddress, matchingAddress[0].amount, matchingAddress[0].datetime];
            await DB.query(query_add_redeem, params_add_redeem);
            const index = redeemAddressesData.indexOf(matchingAddress[0]);
            redeemAddressesData.splice(index, 1);
            redeemAddresses.splice(index, 1);
          } else { // The output amount does not match the peg-out amount... log it
            logger.debug(`Found redeem txid ${tx.txid}:${output.n} to peg-out address ${output.scriptPubKey.address} but output amount ${Math.round(output.value * 100000000)} does not match the peg-out amount!`);
          }
        }
      }
    }

    for (const utxo of spentAsTip) {   
      if (utxo.expiredAt === 0 && block.height >= utxo.blocknumber + utxo.timelock) { // The UTXO is expiring in this block
        await DB.query(`UPDATE federation_txos SET lastblockupdate = ?, expiredAt = ? WHERE txid = ? AND txindex = ?`, [block.height, block.time, utxo.txid, utxo.txindex]);
      } else {
        await DB.query(`UPDATE federation_txos SET lastblockupdate = ? WHERE txid = ? AND txindex = ?`, [block.height, utxo.txid, utxo.txindex]);
      }
    }

    for (const utxo of unspentAsTip) {
      if (utxo.expiredAt === 0 && block.height >= utxo.blocknumber + utxo.timelock) { // The UTXO is expiring in this block
        await DB.query(`UPDATE federation_txos SET lastblockupdate = ?, expiredAt = ? WHERE txid = ? AND txindex = ?`, [confirmedTip, block.time, utxo.txid, utxo.txindex]);
      } else if (utxo.expiredAt === 0 && confirmedTip >= utxo.blocknumber + utxo.timelock) { // The UTXO is expiring before the tip: we need to keep track of it
        await DB.query(`UPDATE federation_txos SET lastblockupdate = ? WHERE txid = ? AND txindex = ?`, [utxo.blocknumber + utxo.timelock - 1, utxo.txid, utxo.txindex]); 
      } else {
      await DB.query(`UPDATE federation_txos SET lastblockupdate = ? WHERE txid = ? AND txindex = ?`, [confirmedTip, utxo.txid, utxo.txindex]);
      }
    }
  }

  protected async $saveLastBlockAuditToDatabase(blockHeight: number) {
    const query = `UPDATE state SET number = ? WHERE name = 'last_bitcoin_block_audit'`;
    await DB.query(query, [blockHeight]);
  }

  // Get the bitcoin block where the audit process was last updated
  protected async $getAuditProgress(): Promise<any> {
    const lastblockaudit = await this.$getLastBlockAudit();
    const bitcoinBlocksToSync = await this.$getBitcoinBlockchainState();
    return {
      lastBlockAudit: lastblockaudit,
      confirmedTip: bitcoinBlocksToSync.bitcoinBlocks - auditBlockOffsetWithTip,
    };
  }

  // Get the bitcoin blocks remaining to be synced
  protected async $getBitcoinBlockchainState(): Promise<any> {
    const result = await bitcoinSecondClient.getBlockchainInfo();
    return {
      bitcoinBlocks: result.blocks,
      bitcoinHeaders: result.headers,
    }
  }

  protected async $getLastBlockAudit(): Promise<number> {
    const query = `SELECT number FROM state WHERE name = 'last_bitcoin_block_audit'`;
    const [rows] = await DB.query(query);
    return rows[0]['number'];
  }

  protected async $getRedeemAddressesToScan(): Promise<any[]> {
    const query = `SELECT datetime, amount, bitcoinaddress FROM elements_pegs where amount < 0 AND bitcoinaddress != '' AND bitcointxid = '';`;
    const [rows]: any[] = await DB.query(query);
    return rows;
  }

  protected isDust(amount: number, feeRate: number): boolean {
    return amount <= (450 * feeRate); // A P2WSH 11-of-15 multisig input is around 450 bytes
  }

  ///////////// DATA QUERY //////////////

  public async $getAuditStatus(): Promise<any> {
    const lastBlockAudit = await this.$getLastBlockAudit();
    const bitcoinBlocksToSync = await this.$getBitcoinBlockchainState();
    return {
      bitcoinBlocks: bitcoinBlocksToSync.bitcoinBlocks,
      bitcoinHeaders: bitcoinBlocksToSync.bitcoinHeaders,
      lastBlockAudit: lastBlockAudit,
      isAuditSynced: bitcoinBlocksToSync.bitcoinHeaders - bitcoinBlocksToSync.bitcoinBlocks <= 2 && bitcoinBlocksToSync.bitcoinBlocks - lastBlockAudit <= 3,
    };
  }

  public async $getPegDataByMonth(): Promise<any> {
    const query = `SELECT SUM(amount) AS amount, DATE_FORMAT(FROM_UNIXTIME(datetime), '%Y-%m-01') AS date FROM elements_pegs GROUP BY DATE_FORMAT(FROM_UNIXTIME(datetime), '%Y%m')`;
    const [rows] = await DB.query(query);
    return rows;
  }

  public async $getFederationReservesByMonth(): Promise<any> {
    const query = `
    SELECT SUM(amount) AS amount, DATE_FORMAT(FROM_UNIXTIME(blocktime), '%Y-%m-01') AS date FROM federation_txos 
    WHERE
        (blocktime > UNIX_TIMESTAMP(LAST_DAY(FROM_UNIXTIME(blocktime) - INTERVAL 1 MONTH) + INTERVAL 1 DAY))
      AND 
        ((unspent = 1) OR (unspent = 0 AND lasttimeupdate > UNIX_TIMESTAMP(LAST_DAY(FROM_UNIXTIME(blocktime)) + INTERVAL 1 DAY)))
      AND 
        (expiredAt = 0 OR expiredAt > UNIX_TIMESTAMP(LAST_DAY(FROM_UNIXTIME(blocktime)) + INTERVAL 1 DAY))
    GROUP BY 
        date;`;          
    const [rows] = await DB.query(query);
    return rows;
  }

  // Get the current L-BTC pegs and the last Liquid block it was updated
  public async $getCurrentLbtcSupply(): Promise<any> {
    const [rows] = await DB.query(`SELECT SUM(amount) AS LBTC_supply FROM elements_pegs;`);
    const lastblockupdate = await this.$getLatestBlockHeightFromDatabase();
    const hash = await bitcoinClient.getBlockHash(lastblockupdate);
    return {
      amount: rows[0]['LBTC_supply'],
      lastBlockUpdate: lastblockupdate,
      hash: hash
    };
  }

  // Get the current reserves of the federation and the last Bitcoin block it was updated
  public async $getCurrentFederationReserves(): Promise<any> {
    const [rows] = await DB.query(`SELECT SUM(amount) AS total_balance FROM federation_txos WHERE unspent = 1 AND expiredAt = 0;`);
    const lastblockaudit = await this.$getLastBlockAudit();
    const hash = await bitcoinSecondClient.getBlockHash(lastblockaudit);
    return {
      amount: rows[0]['total_balance'],
      lastBlockUpdate: lastblockaudit,
      hash: hash
    };
  }

  // Get all of the federation addresses, most balances first
  public async $getFederationAddresses(): Promise<any> {
    const query = `SELECT bitcoinaddress, SUM(amount) AS balance FROM federation_txos WHERE unspent = 1 AND expiredAt = 0 GROUP BY bitcoinaddress ORDER BY balance DESC;`;
    const [rows] = await DB.query(query);
    return rows;
  }

  // Get all of the UTXOs held by the federation, most recent first
  public async $getFederationUtxos(): Promise<any> {
    const query = `SELECT txid, txindex, bitcoinaddress, amount, blocknumber, blocktime, pegtxid, pegindex, pegblocktime, timelock, expiredAt FROM federation_txos WHERE unspent = 1 AND expiredAt = 0 ORDER BY blocktime DESC;`;
    const [rows] = await DB.query(query);
    return rows;
  }

  // Get expired UTXOs, most recent first
  public async $getExpiredUtxos(): Promise<any> {
    const query = `SELECT txid, txindex, bitcoinaddress, amount, blocknumber, blocktime, pegtxid, pegindex, pegblocktime, timelock, expiredAt FROM federation_txos WHERE unspent = 1 AND expiredAt > 0 ORDER BY blocktime DESC;`;
    const [rows]: any[] = await DB.query(query);
    const feeRate = Math.round((await bitcoinSecondClient.estimateSmartFee(1)).feerate * 100000000 / 1000);
    for (const row of rows) {
      row.isDust = this.isDust(row.amount, feeRate);
    }
    return rows;
  }

    // Get utxos that were spent using emergency keys
    public async $getEmergencySpentUtxos(): Promise<any> {
      const query = `SELECT txid, txindex, bitcoinaddress, amount, blocknumber, blocktime, pegtxid, pegindex, pegblocktime, timelock, expiredAt FROM federation_txos WHERE emergencyKey = 1 ORDER BY blocktime DESC;`;
      const [rows] = await DB.query(query);
      return rows;
    }
  
  // Get the total number of federation addresses
  public async $getFederationAddressesNumber(): Promise<any> {
    const query = `SELECT COUNT(DISTINCT bitcoinaddress) AS address_count FROM federation_txos WHERE unspent = 1 AND expiredAt = 0;`;
    const [rows] = await DB.query(query);
    return rows[0];
  }

  // Get the total number of federation utxos
  public async $getFederationUtxosNumber(): Promise<any> {
    const query = `SELECT COUNT(*) AS utxo_count FROM federation_txos WHERE unspent = 1 AND expiredAt = 0;`;
    const [rows] = await DB.query(query);
    return rows[0];
  }

  // Get the total number of emergency spent utxos and their total amount
  public async $getEmergencySpentUtxosStats(): Promise<any> {
    const query = `SELECT COUNT(*) AS utxo_count, SUM(amount) AS total_amount FROM federation_txos WHERE emergencyKey = 1;`;
    const [rows] = await DB.query(query);
    return rows[0];
  }

  // Get recent pegs in / out
  public async $getPegsList(count: number = 0): Promise<any> {
    const query = `SELECT txid, txindex, amount, bitcoinaddress, bitcointxid, bitcoinindex, datetime AS blocktime FROM elements_pegs ORDER BY block DESC LIMIT 15 OFFSET ?;`;
    const [rows] = await DB.query(query, [count]);
    return rows;
  }

  // Get all peg in / out from the last month
  public async $getPegsVolumeDaily(): Promise<any> {
    const pegInQuery = await DB.query(`SELECT SUM(amount) AS volume, COUNT(*) AS number FROM elements_pegs WHERE amount > 0 and datetime > UNIX_TIMESTAMP(TIMESTAMPADD(DAY, -1, CURRENT_TIMESTAMP()));`);
    const pegOutQuery = await DB.query(`SELECT SUM(amount) AS volume, COUNT(*) AS number FROM elements_pegs WHERE amount < 0 and datetime > UNIX_TIMESTAMP(TIMESTAMPADD(DAY, -1, CURRENT_TIMESTAMP()));`);
    return [
      pegInQuery[0][0],
      pegOutQuery[0][0]
    ];
  }

  // Get the total pegs number
  public async $getPegsCount(): Promise<any> {
    const [rows] = await DB.query(`SELECT COUNT(*) AS pegs_count FROM elements_pegs;`);
    return rows[0];
  }
}

export default new ElementsParser();
