# Mempool Backend

These instructions are mostly intended for developers. 

If you choose to use these instructions for a production setup, be aware that you will still probably need to do additional configuration for your specific OS, environment, use-case, etc. We do our best here to provide a good starting point, but only proceed if you know what you're doing. Mempool only provides support for custom setups to project sponsors through [Mempool Enterprise®](https://mempool.space/enterprise).

See other ways to set up Mempool on [the main README](/../../#installation-methods).

Jump to a section in this doc:
- [Set Up the Backend](#setup)
- [Development Tips](#development-tips)

## Setup

### 1. Clone Mempool Repository

Get the latest Mempool code:

```
git clone https://github.com/mempool/mempool
cd mempool
```

Check out the latest release:

```
latestrelease=$(curl -s https://api.github.com/repos/mempool/mempool/releases/latest|grep tag_name|head -1|cut -d '"' -f4)
git checkout $latestrelease
```

### 2. Configure Bitcoin Core

Turn on `txindex`, enable RPC, and set RPC credentials in `bitcoin.conf`:

```
txindex=1
server=1
rpcuser=mempool
rpcpassword=mempool
```

### 3. Configure Electrum Server

[Pick an Electrum Server implementation](https://mempool.space/docs/faq#address-lookup-issues), configure it, and make sure it's synced.

**This step is optional.** You can run Mempool without configuring an Electrum Server for it, but address lookups will be disabled.

### 4. Configure MariaDB

_Mempool needs MariaDB v10.5 or later. If you already have MySQL installed, make sure to migrate any existing databases **before** installing MariaDB._

Get MariaDB from your operating system's package manager:

```
# Debian, Ubuntu, etc.
apt-get install mariadb-server mariadb-client

# macOS
brew install mariadb
mysql.server start
```

Create a database and grant privileges:

```
MariaDB [(none)]> drop database mempool;
Query OK, 0 rows affected (0.00 sec)

MariaDB [(none)]> create database mempool;
Query OK, 1 row affected (0.00 sec)

MariaDB [(none)]> grant all privileges on mempool.* to 'mempool'@'%' identified by 'mempool';
Query OK, 0 rows affected (0.00 sec)
```

### 5. Prepare Mempool Backend

#### Build

_Make sure to use Node.js 20.x and npm 9.x or newer_

_The build process requires [Rust](https://www.rust-lang.org/tools/install) to be installed._

Install dependencies with `npm` and build the backend:

```
cd backend
npm install --no-install-links # npm@9.4.2 and later can omit the --no-install-links
npm run build
```

#### Configure

In the backend folder, make a copy of the sample config file:

```
cp mempool-config.sample.json mempool-config.json
```

Edit `mempool-config.json` as needed. 

In particular, make sure:
- the correct Bitcoin Core RPC credentials are specified in `CORE_RPC`
- the correct `BACKEND` is specified in `MEMPOOL`:
  - "electrum" if you're using [romanz/electrs](https://github.com/romanz/electrs) or [cculianu/Fulcrum](https://github.com/cculianu/Fulcrum)
  - "esplora" if you're using [mempool/electrs](https://github.com/mempool/electrs)
  - "none" if you're not using any Electrum Server

You can use the `generate-config.js` script to define your configuration in a non-interactive way.
Basic usage:

```
node generate-config.js ELECTRUM.PORT=50001 CORE_RPC.COOKIE=true CORE_RPC.COOKIE_PATH=/var/lib/bitcoind/.cookie REPLICATION.SERVERS='["example1.com","example2.com"]'
```

This will create the `mempool-config.json` file using all default values from the sample file
except for the custom values specified.

The special parameters `SOURCE_CONFIG_FILE` and `DEST_CONFIG_FILE` allows specifying a custom source
template and/or a custom destination file.

If present, they must be accessible valid paths on the local filesystem.

```
node generate-config.js ELECTRUM.PORT=50001 SOURCE_CONFIG_FILE=another-sample.json DEST_CONFIG_FILE=/etc/mempool/backend.json
```

### 6. Run Mempool Backend

Run the Mempool backend:

```
npm run start

```
You can also set env var `MEMPOOL_CONFIG_FILE` to specify a custom config file location:
```
MEMPOOL_CONFIG_FILE=/path/to/mempool-config.json npm run start
```

When it's running, you should see output like this:

```
Mempool updated in 0.189 seconds
Updating mempool
Mempool updated in 0.096 seconds
Updating mempool
Mempool updated in 0.099 seconds
Updating mempool
Calculated fee for transaction 1 / 10
Calculated fee for transaction 2 / 10
Calculated fee for transaction 3 / 10
Calculated fee for transaction 4 / 10
Calculated fee for transaction 5 / 10
Calculated fee for transaction 6 / 10
Calculated fee for transaction 7 / 10
Calculated fee for transaction 8 / 10
Calculated fee for transaction 9 / 10
Calculated fee for transaction 10 / 10
Mempool updated in 0.243 seconds
Updating mempool
```

### 7. Set Up Mempool Frontend
With the backend configured and running, proceed to set up the [Mempool frontend](../frontend#manual-setup).

## Development Tips

### Set Up Backend Watchers

The Mempool backend is static. TypeScript scripts are compiled into the `dist` folder and served through a Node.js web server. 

As a result, for development purposes, you may find it helpful to set up backend watchers to avoid the manual shutdown/recompile/restart command-line cycle.

First, install `nodemon` and `ts-node`:

```
npm install -g ts-node nodemon
```

Then, run the watcher:

```
nodemon src/index.ts --ignore cache/
```

`nodemon` should be in npm's global binary folder. If needed, you can determine where that is with `npm -g bin`.

### Useful Regtest Commands

Helpful link: https://gist.github.com/System-Glitch/cb4e87bf1ae3fec9925725bb3ebe223a

Run bitcoind on regtest:
   ```
   bitcoind -regtest
   ```

Create a new wallet, if needed:
   ```
   bitcoin-cli -regtest createwallet test
   ```

Load wallet (this command may take a while if you have a lot of UTXOs):
   ```
   bitcoin-cli -regtest loadwallet test
   ```

Get a new address:
   ```
   address=$(bitcoin-cli -regtest getnewaddress)
   ```

Mine blocks to the previously generated address. You need at least 101 blocks before you can spend. This will take some time to execute (~1 min):
   ```
   bitcoin-cli -regtest generatetoaddress 101 $address
   ```

Send 0.1 BTC at 5 sat/vB to another address:
   ```
   bitcoin-cli -named -regtest sendtoaddress address=$(bitcoin-cli -regtest getnewaddress) amount=0.1 fee_rate=5
   ```

See more example of `sendtoaddress`:
   ```
   bitcoin-cli sendtoaddress # will print the help
   ```

Mini script to generate random network activity (random TX count with random tx fee-rate). It's slow so don't expect to use this to test mempool spam, except if you let it run for a long time, or maybe with multiple regtest nodes connected to each other.
   ```
   #!/bin/bash
   address=$(bitcoin-cli -regtest getnewaddress)
   bitcoin-cli -regtest generatetoaddress 101 $address
   for i in {1..1000000}
   do
      for y in $(seq 1 "$(jot -r 1 1 1000)")
      do
         bitcoin-cli -regtest -named sendtoaddress address=$address amount=0.01 fee_rate=$(jot -r 1 1 100)
      done
      bitcoin-cli -regtest generatetoaddress 1 $address
      sleep 5
   done
   ```

Generate block at regular interval (every 10 seconds in this example):
   ```
   watch -n 10 "bitcoin-cli -regtest generatetoaddress 1 $address"
   ```

### Mining pools update

By default, mining pools will be not automatically updated regularly (`config.MEMPOOL.AUTOMATIC_POOLS_UPDATE` is set to `false`). 

To manually update your mining pools, you can use the `--update-pools` command line flag when you run the nodejs backend. For example `npm run start --update-pools`. This will trigger the mining pools update and automatically re-index appropriate blocks.

You can enable the automatic mining pools update by settings `config.MEMPOOL.AUTOMATIC_POOLS_UPDATE` to `true` in your `mempool-config.json`.

When a `coinbase tag` or `coinbase address` change is detected, pool assignments for all relevant blocks (tagged to that pool or the `unknown` mining pool, starting from height 130635) are updated using the new criteria.

### Re-index tables

You can manually force the nodejs backend to drop all data from a specified set of tables for future re-index. This is mostly useful for the mining dashboard and the lightning explorer.

Use the `--reindex` command to specify a list of comma separated table which will be truncated at start. Note that a 5 seconds delay will be observed before truncating tables in order to give you a chance to cancel (CTRL+C) in case of misuse of the command.

Usage:
```
npm run start --reindex=blocks,hashrates
```
Example output:
```
Feb 13 14:55:27 [63246] WARN: <lightning> Indexed data for "hashrates" tables will be erased in 5 seconds (using '--reindex')
Feb 13 14:55:32 [63246] NOTICE: <lightning> Table hashrates has been truncated
```

Reference: https://github.com/mempool/mempool/pull/1269
