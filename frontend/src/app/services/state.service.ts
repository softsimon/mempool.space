import { Inject, Injectable, PLATFORM_ID, LOCALE_ID } from '@angular/core';
import { ReplaySubject, BehaviorSubject, Subject, fromEvent, Observable } from 'rxjs';
import { Transaction } from '@interfaces/electrs.interface';
import { AccelerationDelta, HealthCheckHost, IBackendInfo, MempoolBlock, MempoolBlockUpdate, MempoolInfo, Recommendedfees, ReplacedTransaction, ReplacementInfo, StratumJob, isMempoolState } from '@interfaces/websocket.interface';
import { Acceleration, AccelerationPosition, BlockExtended, CpfpInfo, DifficultyAdjustment, MempoolPosition, OptimizedMempoolStats, RbfTree, TransactionStripped } from '@interfaces/node-api.interface';
import { Router, NavigationStart } from '@angular/router';
import { isPlatformBrowser } from '@angular/common';
import { filter, map, scan, share, shareReplay } from 'rxjs/operators';
import { StorageService } from '@app/services/storage.service';
import { hasTouchScreen } from '@app/shared/pipes/bytes-pipe/utils';
import { ActiveFilter } from '@app/shared/filters.utils';

export interface MarkBlockState {
  blockHeight?: number;
  txid?: string;
  mempoolBlockIndex?: number;
  txFeePerVSize?: number;
  mempoolPosition?: MempoolPosition;
  accelerationPositions?: AccelerationPosition[];
}

export interface ILoadingIndicators { [name: string]: number; }

export interface Customization {
  domains: string[];
  theme: string;
  enterprise?: string;
  branding: {
    name: string;
    site_id?: number;
    title: string;
    img?: string;
    header_img?: string;
    footer_img?: string;
    rounded_corner: boolean;
  },
  meta: {
    title: string;
    description: string;
    image: {
      src: string;
      type: string;
      width: string;
      height: string;
    };
  };
  dashboard: {
    widgets: {
      component: string;
      mobileOrder?: number;
      props: { [key: string]: any };
    }[];
  };
}

export interface Env {
  MAINNET_ENABLED: boolean;
  TESTNET_ENABLED: boolean;
  TESTNET4_ENABLED: boolean;
  SIGNET_ENABLED: boolean;
  LIQUID_ENABLED: boolean;
  LIQUID_TESTNET_ENABLED: boolean;
  ITEMS_PER_PAGE: number;
  KEEP_BLOCKS_AMOUNT: number;
  OFFICIAL_MEMPOOL_SPACE: boolean;
  BASE_MODULE: string;
  ROOT_NETWORK: string;
  NGINX_PROTOCOL?: string;
  NGINX_HOSTNAME?: string;
  NGINX_PORT?: string;
  BLOCK_WEIGHT_UNITS: number;
  MEMPOOL_BLOCKS_AMOUNT: number;
  GIT_COMMIT_HASH: string;
  PACKAGE_JSON_VERSION: string;
  MEMPOOL_WEBSITE_URL: string;
  LIQUID_WEBSITE_URL: string;
  MINING_DASHBOARD: boolean;
  LIGHTNING: boolean;
  AUDIT: boolean;
  MAINNET_BLOCK_AUDIT_START_HEIGHT: number;
  TESTNET_BLOCK_AUDIT_START_HEIGHT: number;
  TESTNET4_BLOCK_AUDIT_START_HEIGHT: number;
  SIGNET_BLOCK_AUDIT_START_HEIGHT: number;
  MAINNET_TX_FIRST_SEEN_START_HEIGHT: number;
  TESTNET_TX_FIRST_SEEN_START_HEIGHT: number;
  TESTNET4_TX_FIRST_SEEN_START_HEIGHT: number;
  SIGNET_TX_FIRST_SEEN_START_HEIGHT: number;
  HISTORICAL_PRICE: boolean;
  ACCELERATOR: boolean;
  ACCELERATOR_BUTTON: boolean;
  PUBLIC_ACCELERATIONS: boolean;
  ADDITIONAL_CURRENCIES: boolean;
  GIT_COMMIT_HASH_MEMPOOL_SPACE?: string;
  PACKAGE_JSON_VERSION_MEMPOOL_SPACE?: string;
  STRATUM_ENABLED: boolean;
  SERVICES_API?: string;
  customize?: Customization;
  PROD_DOMAINS: string[];
}

const defaultEnv: Env = {
  'MAINNET_ENABLED': true,
  'TESTNET_ENABLED': false,
  'TESTNET4_ENABLED': false,
  'SIGNET_ENABLED': false,
  'LIQUID_ENABLED': false,
  'LIQUID_TESTNET_ENABLED': false,
  'BASE_MODULE': 'mempool',
  'ROOT_NETWORK': '',
  'ITEMS_PER_PAGE': 10,
  'KEEP_BLOCKS_AMOUNT': 8,
  'OFFICIAL_MEMPOOL_SPACE': false,
  'NGINX_PROTOCOL': 'http',
  'NGINX_HOSTNAME': '127.0.0.1',
  'NGINX_PORT': '80',
  'BLOCK_WEIGHT_UNITS': 4000000,
  'MEMPOOL_BLOCKS_AMOUNT': 8,
  'GIT_COMMIT_HASH': '',
  'PACKAGE_JSON_VERSION': '',
  'MEMPOOL_WEBSITE_URL': 'https://mempool.space',
  'LIQUID_WEBSITE_URL': 'https://liquid.network',
  'MINING_DASHBOARD': true,
  'LIGHTNING': false,
  'AUDIT': false,
  'MAINNET_BLOCK_AUDIT_START_HEIGHT': 0,
  'TESTNET_BLOCK_AUDIT_START_HEIGHT': 0,
  'TESTNET4_BLOCK_AUDIT_START_HEIGHT': 0,
  'SIGNET_BLOCK_AUDIT_START_HEIGHT': 0,
  'MAINNET_TX_FIRST_SEEN_START_HEIGHT': 0,
  'TESTNET_TX_FIRST_SEEN_START_HEIGHT': 0,
  'TESTNET4_TX_FIRST_SEEN_START_HEIGHT': 0,
  'SIGNET_TX_FIRST_SEEN_START_HEIGHT': 0,
  'HISTORICAL_PRICE': true,
  'ACCELERATOR': false,
  'ACCELERATOR_BUTTON': true,
  'PUBLIC_ACCELERATIONS': false,
  'ADDITIONAL_CURRENCIES': false,
  'STRATUM_ENABLED': false,
  'SERVICES_API': 'https://mempool.space/api/v1/services',
  'PROD_DOMAINS': [],
};

@Injectable({
  providedIn: 'root'
})
export class StateService {
  referrer: string = '';
  isBrowser: boolean = isPlatformBrowser(this.platformId);
  isMempoolSpaceBuild = window['isMempoolSpaceBuild'] ?? false;
  backend: 'esplora' | 'electrum' | 'none' = 'esplora';
  network = '';
  lightningNetworks = ['', 'mainnet', 'bitcoin', 'testnet', 'signet'];
  lightning = false;
  blockVSize: number;
  env: Env;
  latestBlockHeight = -1;
  blocks: BlockExtended[] = [];
  mempoolSequence: number;
  mempoolBlockState: { block: number, transactions: { [txid: string]: TransactionStripped} };

  backend$ = new BehaviorSubject<'esplora' | 'electrum' | 'none'>('esplora');
  networkChanged$ = new ReplaySubject<string>(1);
  lightningChanged$ = new ReplaySubject<boolean>(1);
  blocksSubject$ = new BehaviorSubject<BlockExtended[]>([]);
  blocks$: Observable<BlockExtended[]>;
  transactions$ = new BehaviorSubject<TransactionStripped[]>(null);
  conversions$ = new ReplaySubject<Record<string, number>>(1);
  bsqPrice$ = new ReplaySubject<number>(1);
  mempoolInfo$ = new ReplaySubject<MempoolInfo>(1);
  mempoolBlocks$ = new ReplaySubject<MempoolBlock[]>(1);
  mempoolBlockUpdate$ = new Subject<MempoolBlockUpdate>();
  liveMempoolBlockTransactions$: Observable<{ block: number, transactions: { [txid: string]: TransactionStripped} }>;
  accelerations$ = new Subject<AccelerationDelta>();
  liveAccelerations$: Observable<Acceleration[]>;
  stratumJobUpdate$ = new Subject<{ state: Record<string, StratumJob> } | { job: StratumJob }>();
  stratumJobs$ = new BehaviorSubject<Record<string, StratumJob>>({});
  txConfirmed$ = new Subject<[string, BlockExtended]>();
  txReplaced$ = new Subject<ReplacedTransaction>();
  txRbfInfo$ = new Subject<RbfTree>();
  rbfLatest$ = new Subject<RbfTree[]>();
  rbfLatestSummary$ = new Subject<ReplacementInfo[]>();
  utxoSpent$ = new Subject<object>();
  difficultyAdjustment$ = new ReplaySubject<DifficultyAdjustment>(1);
  mempoolTransactions$ = new Subject<Transaction>();
  mempoolTxPosition$ = new BehaviorSubject<{ txid: string, position: MempoolPosition, cpfp: CpfpInfo | null, accelerationPositions?: AccelerationPosition[] }>(null);
  mempoolRemovedTransactions$ = new Subject<Transaction>();
  multiAddressTransactions$ = new Subject<{ [address: string]: { mempool: Transaction[], confirmed: Transaction[], removed: Transaction[] }}>();
  blockTransactions$ = new Subject<Transaction>();
  walletTransactions$ = new Subject<Transaction[]>();
  isLoadingWebSocket$ = new ReplaySubject<boolean>(1);
  isLoadingMempool$ = new BehaviorSubject<boolean>(true);
  vbytesPerSecond$ = new ReplaySubject<number>(1);
  previousRetarget$ = new ReplaySubject<number>(1);
  backendInfo$ = new ReplaySubject<IBackendInfo>(1);
  servicesBackendInfo$ = new ReplaySubject<IBackendInfo>(1);
  loadingIndicators$ = new ReplaySubject<ILoadingIndicators>(1);
  recommendedFees$ = new ReplaySubject<Recommendedfees>(1);
  chainTip$ = new ReplaySubject<number>(-1);
  serverHealth$ = new Subject<HealthCheckHost[]>();

  live2Chart$ = new Subject<OptimizedMempoolStats>();

  viewAmountMode$: BehaviorSubject<'btc' | 'sats' | 'fiat'>;
  timezone$: BehaviorSubject<string>;
  connectionState$ = new BehaviorSubject<0 | 1 | 2>(2);
  isTabHidden$: Observable<boolean>;

  markBlock$ = new BehaviorSubject<MarkBlockState>({});
  keyNavigation$ = new Subject<KeyboardEvent>();
  searchText$ = new BehaviorSubject<string>('');

  blockScrolling$: Subject<boolean> = new Subject<boolean>();
  resetScroll$: Subject<boolean> = new Subject<boolean>();
  timeLtr: BehaviorSubject<boolean>;
  hideFlow: BehaviorSubject<boolean>;
  hideAudit: BehaviorSubject<boolean>;
  fiatCurrency$: BehaviorSubject<string>;
  rateUnits$: BehaviorSubject<string>;
  blockDisplayMode$: BehaviorSubject<string>;

  searchFocus$: Subject<boolean> = new Subject<boolean>();
  menuOpen$: BehaviorSubject<boolean> = new BehaviorSubject(false);

  activeGoggles$: BehaviorSubject<ActiveFilter> = new BehaviorSubject({ mode: 'and', filters: [], gradient: 'age' });

  constructor(
    @Inject(PLATFORM_ID) private platformId: any,
    @Inject(LOCALE_ID) private locale: string,
    private router: Router,
    private storageService: StorageService,
  ) {
    this.referrer = window.document.referrer;

    const browserWindow = window || {};
    // @ts-ignore
    const browserWindowEnv = browserWindow.__env || {};
    if (browserWindowEnv.PROD_DOMAINS && typeof(browserWindowEnv.PROD_DOMAINS) === 'string') {
      browserWindowEnv.PROD_DOMAINS = browserWindowEnv.PROD_DOMAINS.split(',');
    }

    this.env = Object.assign(defaultEnv, browserWindowEnv);

    if (defaultEnv.BASE_MODULE !== 'mempool') {
      this.env.MINING_DASHBOARD = false;
    }

    if (document.location.hostname.endsWith('.onion')) {
      this.env.SERVICES_API = 'http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/api/v1/services';
    }

    if (this.isBrowser) {
      this.setNetworkBasedonUrl(window.location.pathname);
      this.setLightningBasedonUrl(window.location.pathname);
      this.isTabHidden$ = fromEvent(document, 'visibilitychange').pipe(map(() => this.isHidden()), shareReplay());
    } else {
      this.setNetworkBasedonUrl('/');
      this.setLightningBasedonUrl('/');
      this.isTabHidden$ = new BehaviorSubject(false);
    }

    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.setNetworkBasedonUrl(event.url);
        this.setLightningBasedonUrl(event.url);
      }
    });

    this.liveMempoolBlockTransactions$ = this.mempoolBlockUpdate$.pipe(scan((acc: { block: number, transactions: { [txid: string]: TransactionStripped } }, change: MempoolBlockUpdate): { block: number, transactions: { [txid: string]: TransactionStripped } } => {
      if (isMempoolState(change)) {
        const txMap = {};
        change.transactions.forEach(tx => {
          txMap[tx.txid] = tx;
        });
        this.mempoolBlockState = {
          block: change.block,
          transactions: txMap
        };
        return this.mempoolBlockState;
      } else {
        change.added.forEach(tx => {
          acc.transactions[tx.txid] = tx;
        });
        change.removed.forEach(txid => {
          delete acc.transactions[txid];
        });
        change.changed.forEach(tx => {
          if (acc.transactions[tx.txid]) {
            acc.transactions[tx.txid].rate = tx.rate;
            acc.transactions[tx.txid].acc = tx.acc;
          }
        });
        this.mempoolBlockState = {
          block: change.block,
          transactions: acc.transactions
        };
        return this.mempoolBlockState;
      }
    }, {}),
    share()
    );
    this.liveMempoolBlockTransactions$.subscribe();

    // Emits the full list of pending accelerations each time it changes
    this.liveAccelerations$ = this.accelerations$.pipe(
      scan((accelerations: { [txid: string]: Acceleration }, delta: AccelerationDelta) => {
        if (delta.reset) {
          accelerations = {};
        } else {
          for (const txid of delta.removed) {
            delete accelerations[txid];
          }
        }
        for (const acc of delta.added) {
          accelerations[acc.txid] = acc;
        }
        return accelerations;
      }, {}),
      map((accMap) => Object.values(accMap).sort((a,b) => b.added - a.added))
    );

    this.stratumJobUpdate$.pipe(
      scan((acc: Record<string, StratumJob>, update: { state: Record<string, StratumJob> } | { job: StratumJob }) => {
        if ('state' in update) {
          // Replace the entire state
          return update.state;
        } else {
          // Update or create a single job entry
          return {
            ...acc,
            [update.job.pool]: update.job
          };
        }
      }, {}),
      shareReplay(1)
    ).subscribe(val => {
      this.stratumJobs$.next(val);
    });

    this.networkChanged$.subscribe((network) => {
      this.transactions$ = new BehaviorSubject<TransactionStripped[]>(null);
      this.blocksSubject$.next([]);
    });

    this.blockVSize = this.env.BLOCK_WEIGHT_UNITS / 4;

    this.blocks$ = this.blocksSubject$.pipe(filter(blocks => blocks != null && blocks.length > 0));

    const savedTimePreference = this.storageService.getValue('time-preference-ltr');
    const rtlLanguage = (this.locale.startsWith('ar') || this.locale.startsWith('fa') || this.locale.startsWith('he'));
    // default time direction is right-to-left, unless locale is a RTL language
    this.timeLtr = new BehaviorSubject<boolean>(savedTimePreference === 'true' || (savedTimePreference == null && rtlLanguage));
    this.timeLtr.subscribe((ltr) => {
      this.storageService.setValue('time-preference-ltr', ltr ? 'true' : 'false');
    });

    const savedFlowPreference = this.storageService.getValue('flow-preference');
    this.hideFlow = new BehaviorSubject<boolean>(savedFlowPreference === 'hide');
    this.hideFlow.subscribe((hide) => {
      if (hide) {
        this.storageService.setValue('flow-preference', hide ? 'hide' : 'show');
      } else {
        this.storageService.removeItem('flow-preference');
      }
    });

    const savedAuditPreference = this.storageService.getValue('audit-preference');
    this.hideAudit = new BehaviorSubject<boolean>(savedAuditPreference === 'hide');
    this.hideAudit.subscribe((hide) => {
      this.storageService.setValue('audit-preference', hide ? 'hide' : 'show');
    });
    
    const fiatPreference = this.storageService.getValue('fiat-preference');
    this.fiatCurrency$ = new BehaviorSubject<string>(fiatPreference || 'USD');

    const rateUnitPreference = this.storageService.getValue('rate-unit-preference');
    this.rateUnits$ = new BehaviorSubject<string>(rateUnitPreference || 'vb');

    const blockDisplayModePreference = this.storageService.getValue('block-display-mode-preference');
    this.blockDisplayMode$ = new BehaviorSubject<string>(blockDisplayModePreference || 'fees');

    const viewAmountModePreference = this.storageService.getValue('view-amount-mode') as 'btc' | 'sats' | 'fiat';
    this.viewAmountMode$ = new BehaviorSubject<'btc' | 'sats' | 'fiat'>(viewAmountModePreference || 'btc');

    const timezonePreference = this.storageService.getValue('timezone-preference');
    this.timezone$ = new BehaviorSubject<string>(timezonePreference || 'local');

    this.backend$.subscribe(backend => {
      this.backend = backend;
    });
  }

  setNetworkBasedonUrl(url: string) {
    if (this.env.BASE_MODULE !== 'mempool' && this.env.BASE_MODULE !== 'liquid') {
      return;
    }
    // horrible network regex breakdown:
    // /^\/                                         starts with a forward slash...
    // (?:[a-z]{2}(?:-[A-Z]{2})?\/)?                optional locale prefix (non-capturing)
    // (?:preview\/)?                               optional "preview" prefix (non-capturing)
    // (testnet|signet)/                            network string (captured as networkMatches[1])
    // ($|\/)                                       network string must end or end with a slash
    let networkMatches: object = url.match(/^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?(?:preview\/)?(testnet4?|signet)($|\/)/);

    if (!networkMatches && this.env.ROOT_NETWORK) {
      networkMatches = { 1: this.env.ROOT_NETWORK };
    }

    switch (networkMatches && networkMatches[1]) {
      case 'signet':
        if (this.network !== 'signet') {
          this.network = 'signet';
          this.networkChanged$.next('signet');
        }
        return;
      case 'testnet':
        if (this.network !== 'testnet' && this.network !== 'liquidtestnet') {
          if (this.env.BASE_MODULE === 'liquid') {
            this.network = 'liquidtestnet';
            this.networkChanged$.next('liquidtestnet');
          } else {
            this.network = 'testnet';
            this.networkChanged$.next('testnet');
          }
        }
        return;
      case 'testnet4':
        if (this.network !== 'testnet4') {
          this.network = 'testnet4';
          this.networkChanged$.next('testnet4');
        }
        return;
      default:
        if (this.env.BASE_MODULE !== 'mempool') {
          if (this.network !== this.env.BASE_MODULE) {
            this.network = this.env.BASE_MODULE;
            this.networkChanged$.next(this.env.BASE_MODULE);
          }
        } else if (this.network !== '') {
          this.network = '';
          this.networkChanged$.next('');
        }
    }
  }

  setLightningBasedonUrl(url: string) {
    if (this.env.BASE_MODULE !== 'mempool') {
      return;
    }
    const networkMatches = url.match(/\/lightning\//);
    this.lightning = !!networkMatches;
    this.lightningChanged$.next(this.lightning);
  }

  networkSupportsLightning() {
    return this.env.LIGHTNING && this.lightningNetworks.includes(this.network);
  }

  getHiddenProp(){
    const prefixes = ['webkit', 'moz', 'ms', 'o'];
    if ('hidden' in document) { return 'hidden'; }
    for (const prefix of prefixes) {
      if ((prefix + 'Hidden') in document) {
        return prefix + 'Hidden';
      }
    }
    return null;
  }

  isHidden() {
    const prop = this.getHiddenProp();
    if (!prop) { return false; }
    return document[prop];
  }

  setBlockScrollingInProgress(value: boolean) {
    this.blockScrolling$.next(value);
  }

  isLiquid() {
    return this.network === 'liquid' || this.network === 'liquidtestnet';
  }

  isMainnet(): boolean {
    return this.env.ROOT_NETWORK === '' && this.network === '';
  }

  isAnyTestnet(): boolean {
    return ['testnet', 'testnet4', 'signet', 'liquidtestnet'].includes(this.network);
  }

  resetChainTip() {
    this.latestBlockHeight = -1;
    this.chainTip$.next(-1);
  }

  updateChainTip(height) {
    if (height > this.latestBlockHeight) {
      this.latestBlockHeight = height;
      this.chainTip$.next(height);
    }
  }

  resetBlocks(blocks: BlockExtended[]): void {
    this.blocks = blocks.reverse();
    this.blocksSubject$.next(blocks);
  }

  addBlock(block: BlockExtended): void {
    this.blocks.unshift(block);
    this.blocks = this.blocks.slice(0, this.env.KEEP_BLOCKS_AMOUNT);
    this.blocksSubject$.next(this.blocks);
  }

  focusSearchInputDesktop() {
    if (!hasTouchScreen()) {
      this.searchFocus$.next(true);
    }    
  }
}
