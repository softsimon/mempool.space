const fs = require('fs');

let PROXY_CONFIG = require('./proxy.conf');

PROXY_CONFIG.forEach(entry => {
  const hostname = process.env.CYPRESS_REROUTE_TESTNET ?  'node201.fmt.mempool.space' : 'mempool-staging.fra.mempool.space';
  entry.target = entry.target.replace("mempool.space", hostname);
  entry.target = entry.target.replace("liquid.network", "liquid-staging.fmt.mempool.space");
});

module.exports = PROXY_CONFIG;
