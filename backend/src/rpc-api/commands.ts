module.exports = {
  addMultiSigAddress: 'addmultisigaddress',
  addNode: 'addnode', // bitcoind v0.8.0+
  backupWallet: 'backupwallet',
  createMultiSig: 'createmultisig',
  createRawTransaction: 'createrawtransaction', // bitcoind v0.7.0+
  decodeRawTransaction: 'decoderawtransaction', // bitcoind v0.7.0+
  decodeScript: 'decodescript',
  dumpPrivKey: 'dumpprivkey',
  dumpWallet: 'dumpwallet', // bitcoind v0.9.0+
  encryptWallet: 'encryptwallet',
  estimateFee: 'estimatefee', // bitcoind v0.10.0x
  estimatePriority: 'estimatepriority', // bitcoind v0.10.0+
  estimateSmartFee: 'estimatesmartfee',
  generate: 'generate', // bitcoind v0.11.0+
  getAccount: 'getaccount',
  getAccountAddress: 'getaccountaddress',
  getAddedNodeInfo: 'getaddednodeinfo', // bitcoind v0.8.0+
  getAddressesByAccount: 'getaddressesbyaccount',
  getBalance: 'getbalance',
  getBestBlockHash: 'getbestblockhash', // bitcoind v0.9.0+
  getBlock: 'getblock',
  getBlockStats: 'getblockstats',
  getBlockFilter: 'getblockfilter',
  getBlockchainInfo: 'getblockchaininfo', // bitcoind v0.9.2+
  getBlockCount: 'getblockcount',
  getBlockHash: 'getblockhash',
  getBlockHeader: 'getblockheader',
  getBlockTemplate: 'getblocktemplate', // bitcoind v0.7.0+
  getChainTips: 'getchaintips', // bitcoind v0.10.0+
  getChainTxStats: 'getchaintxstats',
  getConnectionCount: 'getconnectioncount',
  getDifficulty: 'getdifficulty',
  getGenerate: 'getgenerate',
  getInfo: 'getinfo',
  getMempoolAncestors: 'getmempoolancestors',
  getMempoolDescendants: 'getmempooldescendants',
  getMempoolEntry: 'getmempoolentry',
  getMempoolInfo: 'getmempoolinfo', // bitcoind v0.10+
  getMiningInfo: 'getmininginfo',
  getNetTotals: 'getnettotals',
  getNetworkInfo: 'getnetworkinfo', // bitcoind v0.9.2+
  getNetworkHashPs: 'getnetworkhashps', // bitcoind v0.9.0+
  getNewAddress: 'getnewaddress',
  getPeerInfo: 'getpeerinfo', // bitcoind v0.7.0+
  getRawChangeAddress: 'getrawchangeaddress', // bitcoin v0.9+
  getRawMemPool: 'getrawmempool', // bitcoind v0.7.0+
  getRawTransaction: 'getrawtransaction', // bitcoind v0.7.0+
  getReceivedByAccount: 'getreceivedbyaccount',
  getReceivedByAddress: 'getreceivedbyaddress',
  getTransaction: 'gettransaction',
  getTxOut: 'gettxout', // bitcoind v0.7.0+
  getTxOutProof: 'gettxoutproof', // bitcoind v0.11.0+
  getTxOutSetInfo: 'gettxoutsetinfo', // bitcoind v0.7.0+
  getTxSpendingPrevOut: 'gettxspendingprevout', // bitcoind #24539
  getUnconfirmedBalance: 'getunconfirmedbalance', // bitcoind v0.9.0+
  getWalletInfo: 'getwalletinfo', // bitcoind v0.9.2+
  help: 'help',
  importAddress: 'importaddress', // bitcoind v0.10.0+
  importPrivKey: 'importprivkey',
  importWallet: 'importwallet', // bitcoind v0.9.0+
  keypoolRefill: 'keypoolrefill',
  keyPoolRefill: 'keypoolrefill',
  listAccounts: 'listaccounts',
  listAddressGroupings: 'listaddressgroupings', // bitcoind v0.7.0+
  listLockUnspent: 'listlockunspent', // bitcoind v0.8.0+
  listReceivedByAccount: 'listreceivedbyaccount',
  listReceivedByAddress: 'listreceivedbyaddress',
  listSinceBlock: 'listsinceblock',
  listTransactions: 'listtransactions',
  listUnspent: 'listunspent', // bitcoind v0.7.0+
  lockUnspent: 'lockunspent', // bitcoind v0.8.0+
  move: 'move',
  ping: 'ping', // bitcoind v0.9.0+
  prioritiseTransaction: 'prioritisetransaction', // bitcoind v0.10.0+
  sendFrom: 'sendfrom',
  sendMany: 'sendmany',
  sendRawTransaction: 'sendrawtransaction', // bitcoind v0.7.0+
  sendToAddress: 'sendtoaddress',
  setAccount: 'setaccount',
  setGenerate: 'setgenerate',
  setTxFee: 'settxfee',
  signMessage: 'signmessage',
  signRawTransaction: 'signrawtransaction', // bitcoind v0.7.0+
  stop: 'stop',
  submitBlock: 'submitblock', // bitcoind v0.7.0+
  submitPackage: 'submitpackage',
  validateAddress: 'validateaddress',
  verifyChain: 'verifychain', // bitcoind v0.9.0+
  verifyMessage: 'verifymessage',
  verifyTxOutProof: 'verifytxoutproof', // bitcoind v0.11.0+
  walletLock: 'walletlock',
  walletPassphrase: 'walletpassphrase',
  walletPassphraseChange: 'walletpassphrasechange',
  getTxoutSetinfo: 'gettxoutsetinfo',
  getIndexInfo: 'getindexinfo',
  testMempoolAccept: 'testmempoolaccept',
};
