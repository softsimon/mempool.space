import fetch from 'node-fetch-commonjs';
import config from './config';
import http from 'node:http';
import https from 'node:https';

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });
const agentSelector = function(_parsedURL: any) {
    if (_parsedURL.protocol == 'http:') {
        return httpAgent;
    } else {
        return httpsAgent;
    }
}

interface Match {
  render: boolean;
  title: string;
  description: string;
  fallbackImg: string;
  staticImg?: string;
  networkMode: string;
  params?: string[];
  sip?: SipTemplate;
}

interface SipTemplate {
  template: string;
  getData: Function;
}

async function sipFetchJSON(url, defaultVal = null) {
  try {
    const response = await fetch(url, { agent: agentSelector });
    return response.ok ? response.json() : defaultVal;
  } catch (error) {
    return defaultVal;
  }
}

const routes = {
  about: {
    title: "About",
    fallbackImg: '/resources/previews/about.jpg',
  },
  acceleration: {
    title: "Acceleration",
    fallbackImg: '/resources/previews/accelerator.jpg',
  },
  accelerator: {
    title: "Mempool Accelerator",
    fallbackImg: '/resources/previews/accelerator.jpg',
  },
  block: {
    render: true,
    params: 1,
    getTitle(path) {
      return `Block: ${path[0]}`;
    },
    sip: {
      template: 'block',
      async getData (params: string[]) {
        if (params?.length) {
          let blockId = params[0];
          if (blockId.length !== 64) {
            blockId = await (await fetch(config.API.ESPLORA + `/block-height/${blockId}`, { agent: agentSelector })).text();
          }
          const [block, transactions] = await Promise.all([
            sipFetchJSON(config.API.MEMPOOL + `/block/${blockId}`),
            sipFetchJSON(config.API.ESPLORA + `/block/${blockId}/txids`),
          ])
          return {
            block,
            transactions,
            canonicalPath: `/block/${blockId}`,
          };
        }
      }
    }
  },
  address: {
    render: true,
    params: 1,
    getTitle(path) {
      return `Address: ${path[0]}`;
    }
  },
  wallet: {
    render: true,
    params: 1,
    getTitle(path) {
      return `Wallet: ${path[0]}`;
    }
  },
  blocks: {
    title: "Blocks",
    fallbackImg: '/resources/previews/blocks.jpg',
  },
  docs: {
    title: "Docs",
    fallbackImg: '/resources/previews/faq.jpg',
    routes: {
      faq: {
        title: "FAQ",
        fallbackImg: '/resources/previews/faq.jpg',
      },
      api: {
        title: "API Docs",
        fallbackImg: '/resources/previews/docs-api.jpg',
      }
    }
  },
  tx: {
    render: true,
    params: 1,
    getTitle(path) {
      return `Transaction: ${path[0]}`;
    },
    sip: {
      template: 'tx',
      async getData (params: string[]) {
        if (params?.length) {
          let txid = params[0];
          const [transaction, times, cpfp, rbf, outspends]: any[] = await Promise.all([
            sipFetchJSON(config.API.ESPLORA + `/tx/${txid}`),
            sipFetchJSON(config.API.MEMPOOL + `/transaction-times?txId[]=${txid}`),
            sipFetchJSON(config.API.MEMPOOL + `/cpfp/${txid}`),
            sipFetchJSON(config.API.MEMPOOL + `/tx/${txid}/rbf`),
            sipFetchJSON(config.API.MEMPOOL + `/outspends?txId[]=${txid}`),
          ])
          const features = transaction ? {
            segwit: transaction.vin.some((v) => v.prevout && ['v0_p2wsh', 'v0_p2wpkh'].includes(v.prevout.scriptpubkey_type)),
            taproot: transaction.vin.some((v) => v.prevout && v.prevout.scriptpubkey_type === 'v1_p2tr'),
            rbf: transaction.vin.some((v) => v.sequence < 0xfffffffe),
          } : {};
          return {
            transaction,
            times,
            cpfp,
            rbf,
            outspends,
            features,
            hex2ascii: function(hex) {
              const opPush = hex.split(' ').filter((_, i, a) => i > 0 && /^OP_PUSH/.test(a[i - 1]));
              if (opPush[0]) {
                hex = opPush[0];
              }
              if (!hex) {
                return '';
              }
              const bytes: number[] = [];
              for (let i = 0; i < hex.length; i += 2) {
                bytes.push(parseInt(hex.substr(i, 2), 16));
              }
              return new TextDecoder('utf8').decode(Uint8Array.from(bytes)).replace(/\uFFFD/g, '').replace(/\\0/g, '');
            },
          }
        }
      }
    },
    routes: {
      push: {
        title: "Push Transaction",
        fallbackImg: '/resources/previews/tx-push.jpg',
      }
    }
  },
  enterprise: {
    title: "Mempool Enterprise",
    fallbackImg: '/resources/previews/enterprise.jpg',
  },
  lightning: {
    title: "Lightning",
    fallbackImg: '/resources/previews/lightning.jpg',
    routes: {
      node: {
        render: true,
        params: 1,
        getTitle(path) {
          return `Lightning Node: ${path[0]}`;
        }
      },
      channel: {
        render: true,
        params: 1,
        getTitle(path) {
          return `Lightning Channel: ${path[0]}`;
        }
      },
      nodes: {
        routes: {
          isp: {
            render: true,
            params: 1,
            getTitle(path) {
              return `Lightning ISP: ${path[0]}`;
            }
          }
        }
      },
      group: {
        render: true,
        params: 1,
        getTitle(path) {
          return `Lightning Node Group: ${path[0]}`;
        }
      }
    }
  },
  mining: {
    title: "Mining",
    fallbackImg: '/resources/previews/mining.jpg',
    routes: {
      pool: {
        render: true,
        params: 1,
        getTitle(path) {
          return `Mining Pool: ${path[0]}`;
        }
      }
    }
  },
  "privacy-policy": {
    title: "Privacy Policy",
    fallbackImg: '/resources/previews/privacy-policy.jpg',
  },
  rbf: {
    title: "RBF",
    fallbackImg: '/resources/previews/rbf.jpg',
  },
  sponsor: {
    title: "Community Sponsors",
    fallbackImg: '/resources/previews/sponsor.jpg',
  },
  "terms-of-service": {
    title: "Terms of Service",
    fallbackImg: '/resources/previews/terms-of-service.jpg',
  },
  "trademark-policy": {
    title: "Trademark Policy",
    fallbackImg: '/resources/previews/trademark-policy.jpg',
  },
  research: {
    title: "Mempool Research",
    fallbackImg: '/resources/previews/research.jpg',
  },
};

export const networks = {
  bitcoin: {
    title: 'The Mempool Open Source Project®',
    description: 'Explore the full Bitcoin ecosystem with The Mempool Open Source Project®. See the real-time status of your transactions, get network info, and more.',
    fallbackImg: '/resources/previews/mempool-space-preview.jpg',
    routes: {
      ...routes // all routes supported
    }
  },
  liquid: {
    title: 'The Mempool Open Source Project®',
    description: 'Explore the full Bitcoin ecosystem with The Mempool Open Source Project®. See Liquid transactions & assets, get network info, and more.',
    fallbackImg: '/resources/liquid/liquid-network-preview.png',
    routes: { // only block, address & tx routes supported
      block: routes.block,
      address: routes.address,
      tx: routes.tx
    }
  },
  bisq: {
    fallbackImg: '/resources/bisq/bisq-markets-preview.png',
    routes: {} // no routes supported
  },
  onbtc: {
    networkName: 'ONBTC',
    title: 'National Bitcoin Office of El Salvador',
    description: 'The National Bitcoin Office (ONBTC) of El Salvador under President @nayibbukele',
    fallbackImg: '/resources/onbtc/onbtc-preview.jpg',
    routes: { // only dynamic routes supported
      block: routes.block,
      address: routes.address,
      tx: routes.tx,
      mining: {
        title: "Mining",
        routes: {
          pool: routes.mining.routes.pool,
        }
      },
      lightning: {
        title: "Lightning",
        routes: routes.lightning.routes,
      }
    }
  },
  bitb: {
    networkName: 'BITB',
    title: 'BITB | Bitwise Bitcoin ETF',
    description: 'BITB provides low-cost access to bitcoin through a professionally managed fund',
    fallbackImg: '/resources/bitb/bitb-preview.jpg',
    routes: { // only dynamic routes supported
      block: routes.block,
      address: routes.address,
      wallet: routes.wallet,
      tx: routes.tx,
      mining: {
        title: "Mining",
        routes: {
          pool: routes.mining.routes.pool,
        }
      },
      lightning: {
        title: "Lightning",
        routes: routes.lightning.routes,
      }
    }
  },
  meta: {
    networkName: 'Metaplanet',
    title: 'Metaplanet Inc.',
    description: 'Secure the Future with Bitcoin',
    fallbackImg: '/resources/meta/meta-preview.png',
    routes: { // only dynamic routes supported
      block: routes.block,
      address: routes.address,
      wallet: routes.wallet,
      tx: routes.tx,
      mining: {
        title: "Mining",
        routes: {
          pool: routes.mining.routes.pool,
        }
      },
      lightning: {
        title: "Lightning",
        routes: routes.lightning.routes,
      }
    }
  },
  river: {
    networkName: 'River',
    title: 'River | Invest in Bitcoin with confidence',
    description: 'Easily buy Bitcoin in minutes. Zero fees on recurring buys. Invest in Bitcoin with confidence with world-class security.',
    fallbackImg: '/resources/river/river-preview.jpg',
    routes: { // only dynamic routes supported
      block: routes.block,
      address: routes.address,
      wallet: routes.wallet,
      tx: routes.tx,
      mining: {
        title: "Mining",
        routes: {
          pool: routes.mining.routes.pool,
        }
      },
      lightning: {
        title: "Lightning",
        routes: routes.lightning.routes,
      }
    }
  }
};

export function matchRoute(network: string, path: string, matchFor: string = 'render'): Match {
  const match: Match = {
    render: false,
    title: '',
    description: '',
    fallbackImg: '',
    networkMode: 'mainnet'
  }

  const parts = path.slice(1).split('/').filter(p => p.length);

  if (parts[0] === 'preview') {
    parts.shift();
  }
  if (['testnet', 'testnet4', 'signet'].includes(parts[0])) {
    match.networkMode = parts.shift() || 'mainnet';
  }

  let route = networks[network] || networks.bitcoin;
  match.fallbackImg = route.fallbackImg;
  match.title = route.title;
  match.description = route.description;

  // traverse the route tree until we run out of route or tree, or hit a renderable match
  while (!route[matchFor] && route.routes && parts.length && route.routes[parts[0]]) {
    route = route.routes[parts[0]];
    parts.shift();
    if (route.fallbackImg) {
      match.fallbackImg = route.fallbackImg;
    }
    if (route.description) {
      match.description = route.description;
    }
  }

  // enough route parts left for title & rendering
  if (route[matchFor] && parts.length >= route.params) {
    match.render = route.render;
    match.sip = route.sip;
    match.params = parts;
  }
  // only use set a static image for exact matches
  if (!parts.length && route.staticImg) {
    match.staticImg = route.staticImg;
  }
  // apply the title function if present
  if (route.getTitle && typeof route.getTitle === 'function') {
    match.title = route.getTitle(parts);
  } else if (route.title) {
    match.title = route.title;
  }

  return match;
}
