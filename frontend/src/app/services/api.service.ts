import { Injectable } from '@angular/core';
import { HttpClient, HttpParams, HttpResponse } from '@angular/common/http';
import { CpfpInfo, OptimizedMempoolStats, AddressInformation, LiquidPegs, ITranslators, PoolStat, BlockExtended, TransactionStripped, RewardStats, AuditScore, BlockSizesAndWeights,
  RbfTree, BlockAudit, CurrentPegs, AuditStatus, FederationAddress, FederationUtxo, RecentPeg, PegsVolume, AccelerationInfo, TestMempoolAcceptResult, WalletAddress, SubmitPackageResult } from '../interfaces/node-api.interface';
import { BehaviorSubject, Observable, catchError, filter, map, of, shareReplay, take, tap } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { Transaction } from '@interfaces/electrs.interface';
import { Conversion } from '@app/services/price.service';
import { StorageService } from '@app/services/storage.service';
import { WebsocketResponse } from '@interfaces/websocket.interface';
import { TxAuditStatus } from '@components/transaction/transaction.component';

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private apiBaseUrl: string; // base URL is protocol, hostname, and port
  private apiBasePath: string; // network path is /testnet, etc. or '' for mainnet

  private requestCache = new Map<string, { subject: BehaviorSubject<any>, expiry: number }>;
  public blockSummaryLoaded: { [hash: string]: boolean } = {};
  public blockAuditLoaded: { [hash: string]: boolean } = {};

  constructor(
    private httpClient: HttpClient,
    private stateService: StateService,
    private storageService: StorageService
  ) {
    this.apiBaseUrl = ''; // use relative URL by default
    if (!stateService.isBrowser) { // except when inside AU SSR process
      this.apiBaseUrl = this.stateService.env.NGINX_PROTOCOL + '://' + this.stateService.env.NGINX_HOSTNAME + ':' + this.stateService.env.NGINX_PORT;
    }
    this.apiBasePath = ''; // assume mainnet by default
    this.stateService.networkChanged$.subscribe((network) => {
      this.apiBasePath = network && network !== this.stateService.env.ROOT_NETWORK ? '/' + network : '';
    });
  }

  private generateCacheKey(functionName: string, params: any[]): string {
    return functionName + JSON.stringify(params);
  }

  // delete expired cache entries
  private cleanExpiredCache(): void {
    this.requestCache.forEach((value, key) => {
      if (value.expiry < Date.now()) {
        this.requestCache.delete(key);
      }
    });
  }

  cachedRequest<T, F extends (...args: any[]) => Observable<T>>(
    apiFunction: F,
    expireAfter: number, // in ms
    ...params: Parameters<F>
  ): Observable<T> {
    this.cleanExpiredCache();

    const cacheKey = this.generateCacheKey(apiFunction.name, params);
    if (!this.requestCache.has(cacheKey)) {
      const subject = new BehaviorSubject<T | null>(null);
      this.requestCache.set(cacheKey, { subject, expiry: Date.now() + expireAfter });

      apiFunction.bind(this)(...params).pipe(
        tap(data => {
          subject.next(data as T);
        }),
        catchError((error) => {
          subject.error(error);
          return of(null);
        }),
        shareReplay(1),
      ).subscribe();
    }

    return this.requestCache.get(cacheKey).subject.asObservable().pipe(filter(val => val !== null), take(1));
  }

  list2HStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/2h');
  }

  list24HStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/24h');
  }

  list1WStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/1w');
  }

  list1MStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/1m');
  }

  list3MStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/3m');
  }

  list6MStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/6m');
  }

  list1YStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/1y');
  }

  list2YStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/2y');
  }

  list3YStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/3y');
  }

  list4YStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/4y');
  }

  listAllTimeStatistics$(): Observable<OptimizedMempoolStats[]> {
    return this.httpClient.get<OptimizedMempoolStats[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/statistics/all');
  }

  getTransactionTimes$(txIds: string[]): Observable<number[]> {
    let params = new HttpParams();
    txIds.forEach((txId: string) => {
      params = params.append('txId[]', txId);
    });
    return this.httpClient.get<number[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/transaction-times', { params });
  }

  getAboutPageProfiles$(): Observable<any[]> {
    return this.httpClient.get<any[]>(this.apiBaseUrl + '/api/v1/services/sponsors');
  }

  getOgs$(): Observable<any> {
    return this.httpClient.get<any[]>(this.apiBaseUrl + '/api/v1/donations');
  }

  getTranslators$(): Observable<ITranslators> {
    return this.httpClient.get<ITranslators>(this.apiBaseUrl + '/api/v1/translators');
  }

  getContributor$(): Observable<any[]> {
    return this.httpClient.get<any[]>(this.apiBaseUrl + '/api/v1/contributors');
  }

  getInitData$(): Observable<WebsocketResponse> {
    return this.httpClient.get<WebsocketResponse>(this.apiBaseUrl + this.apiBasePath + '/api/v1/init-data');
  }

  getCpfpinfo$(txid: string): Observable<CpfpInfo> {
    return this.httpClient.get<CpfpInfo>(this.apiBaseUrl + this.apiBasePath + '/api/v1/cpfp/' + txid);
  }

  validateAddress$(address: string): Observable<AddressInformation> {
    return this.httpClient.get<AddressInformation>(this.apiBaseUrl + this.apiBasePath + '/api/v1/validate-address/' + address);
  }

  getRbfHistory$(txid: string): Observable<{ replacements: RbfTree, replaces: string[] }> {
    return this.httpClient.get<{ replacements: RbfTree, replaces: string[] }>(this.apiBaseUrl + this.apiBasePath + '/api/v1/tx/' + txid + '/rbf');
  }

  getRbfCachedTx$(txid: string): Observable<Transaction> {
    return this.httpClient.get<Transaction>(this.apiBaseUrl + this.apiBasePath + '/api/v1/tx/' + txid + '/cached');
  }

  getRbfList$(fullRbf: boolean, after?: string): Observable<RbfTree[]> {
    return this.httpClient.get<RbfTree[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/' + (fullRbf ? 'fullrbf/' : '') + 'replacements/' + (after || ''));
  }

  liquidPegs$(): Observable<CurrentPegs> {
    return this.httpClient.get<CurrentPegs>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/pegs');
  }

  pegsVolume$(): Observable<PegsVolume[]> {
    return this.httpClient.get<PegsVolume[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/pegs/volume');
  }

  listLiquidPegsMonth$(): Observable<LiquidPegs[]> {
    return this.httpClient.get<LiquidPegs[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/pegs/month');
  }

  liquidReserves$(): Observable<CurrentPegs> {
    return this.httpClient.get<CurrentPegs>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves');
  }

  listLiquidReservesMonth$(): Observable<LiquidPegs[]> {
    return this.httpClient.get<LiquidPegs[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/month');
  }

  federationAuditSynced$(): Observable<AuditStatus> {
    return this.httpClient.get<AuditStatus>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/status');
  }

  federationAddresses$(): Observable<FederationAddress[]> {
    return this.httpClient.get<FederationAddress[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/addresses');
  }

  federationUtxos$(): Observable<FederationUtxo[]> {
    return this.httpClient.get<FederationUtxo[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/utxos');
  }

  expiredUtxos$(): Observable<FederationUtxo[]> {
    return this.httpClient.get<FederationUtxo[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/utxos/expired');
  }

  emergencySpentUtxos$(): Observable<FederationUtxo[]> {
    return this.httpClient.get<FederationUtxo[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/utxos/emergency-spent');
  }

  recentPegsList$(count: number = 0): Observable<RecentPeg[]> {
    return this.httpClient.get<RecentPeg[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/pegs/list/' + count);
  }

  pegsCount$(): Observable<any> {
    return this.httpClient.get<number>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/pegs/count');
  }

  federationAddressesNumber$(): Observable<any> {
    return this.httpClient.get<any>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/addresses/total');
  }

  federationUtxosNumber$(): Observable<any> {
    return this.httpClient.get<any>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/utxos/total');
  }

  emergencySpentUtxosStats$(): Observable<any> {
    return this.httpClient.get<any>(this.apiBaseUrl + this.apiBasePath + '/api/v1/liquid/reserves/utxos/emergency-spent/stats');
  }

  listFeaturedAssets$(network: string = 'liquid'): Observable<any[]> {
    if (network === 'liquid') return this.httpClient.get<any[]>(this.apiBaseUrl + '/api/v1/assets/featured');
    return of([]);
  }

  getAssetGroup$(id: string): Observable<any> {
    return this.httpClient.get<any[]>(this.apiBaseUrl + '/api/v1/assets/group/' + id);
  }

  postTransaction$(hexPayload: string): Observable<any> {
    return this.httpClient.post<any>(this.apiBaseUrl + this.apiBasePath + '/api/tx', hexPayload, { responseType: 'text' as 'json'});
  }

  testTransactions$(rawTxs: string[], maxfeerate?: number): Observable<TestMempoolAcceptResult[]> {
    return this.httpClient.post<TestMempoolAcceptResult[]>(this.apiBaseUrl + this.apiBasePath + `/api/txs/test${maxfeerate != null ? '?maxfeerate=' + maxfeerate.toFixed(8) : ''}`, rawTxs);
  }

  submitPackage$(rawTxs: string[], maxfeerate?: number, maxburnamount?: number): Observable<SubmitPackageResult> {
    const queryParams = [];

    if (maxfeerate) {
      queryParams.push(`maxfeerate=${maxfeerate}`);
    }

    if (maxburnamount) {
      queryParams.push(`maxburnamount=${maxburnamount}`);
    }
    return this.httpClient.post<SubmitPackageResult>(this.apiBaseUrl + this.apiBasePath + '/api/v1/txs/package' + (queryParams.length > 0 ? `?${queryParams.join('&')}` : ''), rawTxs);
  }

  getTransactionStatus$(txid: string): Observable<any> {
    return this.httpClient.get<any>(this.apiBaseUrl + this.apiBasePath + '/api/tx/' + txid + '/status');
  }

  listPools$(interval: string | undefined) : Observable<any> {
    return this.httpClient.get<any>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/pools` +
      (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
    )
    .pipe(
      map((response) => {
        const pools = interval !== undefined ? response.body.pools : response.body;
        pools.forEach((pool) => {
          if ((interval !== undefined && pool.poolUniqueId === 0) || (interval === undefined && pool.unique_id === 0)) {
            pool.name = $localize`:@@e5d8bb389c702588877f039d72178f219453a72d:Unknown`;
          }
        });
        return response;
      })
    );
  }  

  getPoolStats$(slug: string): Observable<PoolStat> {
    return this.httpClient.get<PoolStat>(this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/pool/${slug}`)
    .pipe(
      map((poolStats) => {
        if (poolStats.pool.unique_id === 0) {
          poolStats.pool.name = $localize`:@@e5d8bb389c702588877f039d72178f219453a72d:Unknown`;
        }
        return poolStats;
      })
    );
  }

  getPoolHashrate$(slug: string): Observable<any> {
    return this.httpClient.get<any>(this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/pool/${slug}/hashrate`);
  }

  getPoolBlocks$(slug: string, fromHeight: number): Observable<BlockExtended[]> {
    return this.httpClient.get<BlockExtended[]>(
        this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/pool/${slug}/blocks` +
        (fromHeight !== undefined ? `/${fromHeight}` : '')
      );
  }

  getBlocks$(from: number): Observable<BlockExtended[]> {
    return this.httpClient.get<BlockExtended[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/blocks` +
      (from !== undefined ? `/${from}` : ``)
    );
  }

  getBlock$(hash: string): Observable<BlockExtended> {
    return this.httpClient.get<BlockExtended>(this.apiBaseUrl + this.apiBasePath + '/api/v1/block/' + hash);
  }

  getBlockDataFromTimestamp$(timestamp: number): Observable<any> {
    return this.httpClient.get<number>(this.apiBaseUrl + this.apiBasePath + '/api/v1/mining/blocks/timestamp/' + timestamp);
  }

  getStrippedBlockTransactions$(hash: string): Observable<TransactionStripped[]> {
    this.setBlockSummaryLoaded(hash);
    return this.httpClient.get<TransactionStripped[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/block/' + hash + '/summary');
  }

  getStrippedBlockTransaction$(hash: string, txid: string): Observable<TransactionStripped> {
    return this.httpClient.get<TransactionStripped>(this.apiBaseUrl + this.apiBasePath + '/api/v1/block/' + hash + '/tx/' + txid + '/summary');
  }

  getDifficultyAdjustments$(interval: string | undefined): Observable<any> {
    return this.httpClient.get<any[]>(
        this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/difficulty-adjustments` +
        (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
      );
  }

  getHistoricalHashrate$(interval: string | undefined): Observable<any> {
    return this.httpClient.get<any[]>(
        this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/hashrate` +
        (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
      );
  }

  getHistoricalPoolsHashrate$(interval: string | undefined): Observable<any> {
    return this.httpClient.get<any[]>(
        this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/hashrate/pools` +
        (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
      );
  }

  getHistoricalBlockFees$(interval: string | undefined) : Observable<any> {
    return this.httpClient.get<any[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/blocks/fees` +
      (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
    );
  }

  getBlockFeesFromTimespan$(from: number, to: number): Observable<any> {
    return this.httpClient.get<any[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/blocks/fees?from=${from}&to=${to}`, { observe: 'response' }
    );
  }

  getHistoricalBlockRewards$(interval: string | undefined) : Observable<any> {
    return this.httpClient.get<any[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/blocks/rewards` +
      (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
    );
  }

  getHistoricalBlockFeeRates$(interval: string | undefined) : Observable<any> {
    return this.httpClient.get<any[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/blocks/fee-rates` +
      (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
    );
  }

  getHistoricalBlockSizesAndWeights$(interval: string | undefined) : Observable<HttpResponse<BlockSizesAndWeights>> {
    return this.httpClient.get<BlockSizesAndWeights>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/blocks/sizes-weights` +
      (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
    );
  }

  getHistoricalBlocksHealth$(interval: string | undefined) : Observable<any> {
    return this.httpClient.get<any[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/blocks/predictions` +
      (interval !== undefined ? `/${interval}` : ''), { observe: 'response' }
    );
  }

  getBlockAudit$(hash: string) : Observable<BlockAudit> {
    this.setBlockAuditLoaded(hash);
    return this.httpClient.get<BlockAudit>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/block/${hash}/audit-summary`
    );
  }

  getBlockTxAudit$(hash: string, txid: string) : Observable<TxAuditStatus> {
    return this.httpClient.get<TxAuditStatus>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/block/${hash}/tx/${txid}/audit`
    );
  }

  getBlockAuditScores$(from: number): Observable<AuditScore[]> {
    return this.httpClient.get<AuditScore[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/blocks/audit/scores` +
      (from !== undefined ? `/${from}` : ``)
    );
  }

  getBlockAuditScore$(hash: string) : Observable<any> {
    return this.httpClient.get<any>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/blocks/audit/score/` + hash
    );
  }

  getRewardStats$(blockCount: number = 144): Observable<RewardStats> {
    return this.httpClient.get<RewardStats>(this.apiBaseUrl + this.apiBasePath + `/api/v1/mining/reward-stats/${blockCount}`);
  }

  getEnterpriseInfo$(name: string): Observable<any> {
    return this.httpClient.get<any>(this.apiBaseUrl + this.apiBasePath + `/api/v1/services/enterprise/info/` + name);
  }

  getChannelByTxIds$(txIds: string[]): Observable<any[]> {
    let params = new HttpParams();
    txIds.forEach((txId: string) => {
      params = params.append('txId[]', txId);
    });
    return this.httpClient.get<any[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/lightning/channels/txids/', { params });
  }

  lightningSearch$(searchText: string): Observable<{ nodes: any[], channels: any[] }> {
    let params = new HttpParams().set('searchText', searchText);
    // Don't request the backend if searchText is less than 3 characters
    if (searchText.length < 3) {
      return of({ nodes: [], channels: [] });
    }
    return this.httpClient.get<{ nodes: any[], channels: any[] }>(this.apiBaseUrl + this.apiBasePath + '/api/v1/lightning/search', { params });
  }

  getNodesPerIsp(): Observable<any> {
    return this.httpClient.get<any[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/lightning/nodes/isp-ranking');
  }

  getNodeForCountry$(country: string): Observable<any> {
    return this.httpClient.get<any[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/lightning/nodes/country/' + country);
  }

  getNodeForISP$(isp: string): Observable<any> {
    return this.httpClient.get<any[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/lightning/nodes/isp/' + isp);
  }

  getNodesPerCountry$(): Observable<any> {
    return this.httpClient.get<any[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/lightning/nodes/countries');
  }

  getWorldNodes$(): Observable<any> {
    return this.httpClient.get<any[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/lightning/nodes/world');
  }

  getChannelsGeo$(publicKey?: string, style?: 'graph' | 'nodepage' | 'widget' | 'channelpage'): Observable<any> {
    return this.httpClient.get<any[]>(
      this.apiBaseUrl + this.apiBasePath + '/api/v1/lightning/channels-geo' +
        (publicKey !== undefined ? `/${publicKey}`   : '') +
        (style     !== undefined ? `?style=${style}` : '')
    );
  }

  getHistoricalPrice$(timestamp: number | undefined, currency?: string): Observable<Conversion> {
    if (this.stateService.isAnyTestnet()) {
      return of({
        prices: [],
        exchangeRates: {
          USDEUR: 0,
          USDGBP: 0,
          USDCAD: 0,
          USDCHF: 0,
          USDAUD: 0,
          USDJPY: 0,
          USDBGN: 0,
          USDBRL: 0,
          USDCNY: 0,
          USDCZK: 0,
          USDDKK: 0,
          USDHKD: 0,
          USDHRK: 0,
          USDHUF: 0,
          USDIDR: 0,
          USDILS: 0,
          USDINR: 0,
          USDISK: 0,
          USDKRW: 0,
          USDMXN: 0,
          USDMYR: 0,
          USDNOK: 0,
          USDNZD: 0,
          USDPHP: 0,
          USDPLN: 0,
          USDRON: 0,
          USDRUB: 0,
          USDSEK: 0,
          USDSGD: 0,
          USDTHB: 0,
          USDTRY: 0,
          USDZAR: 0,
        }
      });
    }
    const queryParams = [];

    if (timestamp) {
      queryParams.push(`timestamp=${timestamp}`);
    }

    if (currency) {
      queryParams.push(`currency=${currency}`);
    }
    return this.httpClient.get<Conversion>(
      `${this.apiBaseUrl}${this.apiBasePath}/api/v1/historical-price` +
        (queryParams.length > 0 ? `?${queryParams.join('&')}` : '')
    );
  }

  getWallet$(walletName: string): Observable<Record<string, WalletAddress>> {
    return this.httpClient.get<Record<string, WalletAddress>>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/wallet/${walletName}`
    );
  }

  getAccelerationsByPool$(slug: string): Observable<AccelerationInfo[]> {
    return this.httpClient.get<AccelerationInfo[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/accelerations/pool/${slug}`
    );
  }

  getAccelerationsByHeight$(height: number): Observable<AccelerationInfo[]> {
    return this.httpClient.get<AccelerationInfo[]>(
      this.apiBaseUrl + this.apiBasePath + `/api/v1/accelerations/block/${height}`
    );
  }

  getRecentAccelerations$(interval: string | undefined): Observable<AccelerationInfo[]> {
    return this.httpClient.get<AccelerationInfo[]>(
      this.apiBaseUrl + this.apiBasePath + '/api/v1/accelerations/interval' + (interval !== undefined ? `/${interval}` : '')
    );
  }

  getAccelerationTotals$(pool?: string, interval?: string): Observable<{ cost: number, count: number }> {
    const queryParams = new URLSearchParams();
    if (pool) {
      queryParams.append('pool', pool);
    }
    if (interval) {
      queryParams.append('interval', interval);
    }
    const queryString = queryParams.toString();
    return this.httpClient.get<{ cost: number, count: number }>(
      this.apiBaseUrl + this.apiBasePath + '/api/v1/accelerations/total' + (queryString?.length ? '?' + queryString : '')
    );
  }

  logAccelerationRequest$(txid: string): Observable<any> {
    return this.httpClient.post(this.apiBaseUrl + this.apiBasePath + '/api/v1/acceleration/request/' + txid, '');
  }

  getPrevouts$(outpoints: {txid: string; vout: number}[]): Observable<any> {
    return this.httpClient.post(this.apiBaseUrl + this.apiBasePath + '/api/v1/prevouts', outpoints);
  }

  getCpfpLocalTx$(tx: any[]): Observable<CpfpInfo[]> {
    return this.httpClient.post<CpfpInfo[]>(this.apiBaseUrl + this.apiBasePath + '/api/v1/cpfp', tx);
  }

  // Cache methods
  async setBlockAuditLoaded(hash: string) {
    this.blockAuditLoaded[hash] = true;
  }

  getBlockAuditLoaded(hash) {
    return this.blockAuditLoaded[hash];
  }

  async setBlockSummaryLoaded(hash: string) {
    this.blockSummaryLoaded[hash] = true;
  }

  getBlockSummaryLoaded(hash) {
    return this.blockSummaryLoaded[hash];
  }
}
