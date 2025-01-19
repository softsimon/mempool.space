import { Router, NavigationStart } from '@angular/router';
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { StateService } from '@app/services/state.service';
import { StorageService } from '@app/services/storage.service';
import { MenuGroup } from '@interfaces/services.interface';
import { Observable, of, ReplaySubject, tap, catchError, share, filter, switchMap, map } from 'rxjs';
import { IBackendInfo } from '@interfaces/websocket.interface';
import { Acceleration, AccelerationHistoryParams } from '@interfaces/node-api.interface';
import { AccelerationStats } from '@components/acceleration/acceleration-stats/acceleration-stats.component';

export interface IUser {
  username: string;
  email: string | null;
  passwordIsSet: boolean;
  snsId: string;
  type: 'enterprise' | 'community' | 'mining_pool';
  subscription_tag: string;
  status: 'pending' | 'verified' | 'disabled';
  features: string | null;
  countryCode: string | null;
  imageMd5: string;
  ogRank: number | null;
}

@Injectable({
  providedIn: 'root'
})
export class ServicesApiServices {
  apiBaseUrl: string; // base URL is protocol, hostname, and port
  apiBasePath: string; // network path is /testnet, etc. or '' for mainnet

  userSubject$ = new ReplaySubject<IUser | null>(1);
  currentAuth = null;

  constructor(
    private httpClient: HttpClient,
    private stateService: StateService,
    private storageService: StorageService,
    private router: Router,
  ) {
    this.currentAuth = localStorage.getItem('auth');

    this.apiBaseUrl = ''; // use relative URL by default
    if (!stateService.isBrowser) { // except when inside AU SSR process
      this.apiBaseUrl = this.stateService.env.NGINX_PROTOCOL + '://' + this.stateService.env.NGINX_HOSTNAME + ':' + this.stateService.env.NGINX_PORT;
    }
    this.apiBasePath = ''; // assume mainnet by default
    this.stateService.networkChanged$.subscribe((network) => {
      this.apiBasePath = network ? '/' + network : '';
    });

    if (this.stateService.env.GIT_COMMIT_HASH_MEMPOOL_SPACE) {
      this.getServicesBackendInfo$().subscribe(version => {
        this.stateService.servicesBackendInfo$.next(version);
      })
    }

    this.getUserInfo$().subscribe();
    this.router.events.pipe(
      filter((event) => event instanceof NavigationStart && this.currentAuth !== localStorage.getItem('auth')),
      switchMap(() => this.getUserInfo$()),
    ).subscribe();
  }

  /**
   * Do not call directly, userSubject$ instead
   */
  private getUserInfo$() {
    return this.getUserInfoApi$().pipe(
      tap((user) => {
        this.userSubject$.next(user);
      }),
      catchError((e) => {
        if (e.error === 'User does not exists') {
          this.userSubject$.next(null);
          this.logout$().subscribe();
          return of(null);
        }
        this.userSubject$.next(null);
        return of(null);
      }),
      share(),
    )
  }

  /**
   * Do not call directly, userSubject$ instead
   */
  private getUserInfoApi$(): Observable<any> {
    const auth = this.storageService.getAuth();
    if (!auth) {
      return of(null);
    }

    return this.httpClient.get<any>(`${this.stateService.env.SERVICES_API}/account`);
  }

  getUserMenuGroups$(): Observable<MenuGroup[]> {
    const auth = this.storageService.getAuth();
    if (!auth) {
      return of(null);
    }

    return this.httpClient.get<MenuGroup[]>(`${this.stateService.env.SERVICES_API}/account/menu`);
  }

  logout$(): Observable<any> {
    const auth = this.storageService.getAuth();
    if (!auth) {
      return of(null);
    }

    localStorage.removeItem('auth');
    return this.httpClient.post(`${this.stateService.env.SERVICES_API}/auth/logout`, {});
  }

  getJWT$() {
    if (!this.stateService.env.OFFICIAL_MEMPOOL_SPACE) {
      return of(null);
    }
    return this.httpClient.get<any>(`${this.stateService.env.SERVICES_API}/auth/getJWT`);
  }

  getServicesBackendInfo$(): Observable<IBackendInfo> {
    return this.httpClient.get<IBackendInfo>(`${this.stateService.env.SERVICES_API}/version`);
  }

  estimate$(txInput: string) {
    return this.httpClient.post<any>(`${this.stateService.env.SERVICES_API}/accelerator/estimate`, { txInput: txInput }, { observe: 'response' });
  }

  accelerate$(txInput: string, userBid: number) {
    return this.httpClient.post<any>(`${this.stateService.env.SERVICES_API}/accelerator/accelerate`, { txInput: txInput, userBid: userBid});
  }

  accelerateWithCashApp$(txInput: string, token: string, cashtag: string, referenceId: string, userApprovedUSD: number) {
    return this.httpClient.post<any>(`${this.stateService.env.SERVICES_API}/accelerator/accelerate/cashapp`, { txInput: txInput, token: token, cashtag: cashtag, referenceId: referenceId, userApprovedUSD: userApprovedUSD });
  }

  accelerateWithApplePay$(txInput: string, token: string, cardTag: string, referenceId: string, userApprovedUSD: number) {
    return this.httpClient.post<any>(`${this.stateService.env.SERVICES_API}/accelerator/accelerate/applePay`, { txInput: txInput, cardTag: cardTag, token: token, referenceId: referenceId, userApprovedUSD: userApprovedUSD });
  }

  accelerateWithGooglePay$(txInput: string, token: string, verificationToken: string, cardTag: string, referenceId: string, userApprovedUSD: number, userChallenged: boolean) {
    return this.httpClient.post<any>(`${this.stateService.env.SERVICES_API}/accelerator/accelerate/googlePay`, { txInput: txInput, cardTag: cardTag, token: token, verificationToken: verificationToken, referenceId: referenceId, userApprovedUSD: userApprovedUSD, userChallenged: userChallenged });
  }

  accelerateWithCardOnFile$(txInput: string, token: string, verificationToken: string, referenceId: string, userApprovedUSD: number, userChallenged: boolean) {
    return this.httpClient.post<any>(`${this.stateService.env.SERVICES_API}/accelerator/accelerate/cardOnFile`, { txInput: txInput, token: token, verificationToken: verificationToken, referenceId: referenceId, userApprovedUSD: userApprovedUSD, userChallenged: userChallenged });
  }

  getAccelerations$(): Observable<Acceleration[]> {
    return this.httpClient.get<Acceleration[]>(`${this.stateService.env.SERVICES_API}/accelerator/accelerations`);
  }

  getAggregatedAccelerationHistory$(params: AccelerationHistoryParams): Observable<any> {
    return this.httpClient.get<any>(`${this.stateService.env.SERVICES_API}/accelerator/accelerations/history/aggregated`, { params: { ...params }, observe: 'response' });
  }

  getAccelerationHistory$(params: AccelerationHistoryParams): Observable<Acceleration[]> {
    return this.httpClient.get<Acceleration[]>(`${this.stateService.env.SERVICES_API}/accelerator/accelerations/history`, { params: { ...params } });
  }

  getAllAccelerationHistory$(params: AccelerationHistoryParams, limit?: number, findTxid?: string): Observable<Acceleration[]> {
    const getPage$ = (page: number, accelerations: Acceleration[] = []): Observable<{ page: number, total: number, accelerations: Acceleration[] }> => {
      return this.getAccelerationHistoryObserveResponse$({...params, page}).pipe(
        map((response) => ({
          page,
          total: parseInt(response.headers.get('X-Total-Count'), 10) || 0,
          accelerations: accelerations.concat(response.body || []),
        })),
        switchMap(({page, total, accelerations}) => {
          if (accelerations.length >= Math.min(total, limit ?? Infinity) || (findTxid && accelerations.find((acc) => acc.txid === findTxid))) {
            return of({ page, total, accelerations });
          } else {
            return getPage$(page + 1, accelerations);
          }
        }),
      );
    };

    return getPage$(1).pipe(
      map(({ accelerations }) => accelerations),
    );
  }

  getAccelerationHistoryObserveResponse$(params: AccelerationHistoryParams): Observable<any> {
    return this.httpClient.get<any>(`${this.stateService.env.SERVICES_API}/accelerator/accelerations/history`, { params: { ...params }, observe: 'response'});
  }

  getAccelerationStats$(params: AccelerationHistoryParams): Observable<AccelerationStats> {
    return this.httpClient.get<AccelerationStats>(`${this.stateService.env.SERVICES_API}/accelerator/accelerations/stats`, { params: { ...params } });
  }

  setupSquare$(): Observable<{squareAppId: string, squareLocationId: string}> {
    return this.httpClient.get<{squareAppId: string, squareLocationId: string}>(`${this.stateService.env.SERVICES_API}/square/setup`);
  }

  getFaucetStatus$() {
    return this.httpClient.get<{ address?: string, min: number, max: number, code: 'ok' | 'faucet_not_available' | 'faucet_maximum_reached' | 'faucet_too_soon'}>(`${this.stateService.env.SERVICES_API}/testnet4/faucet/status`, { responseType: 'json' });
  }

  requestTestnet4Coins$(address: string, sats: number) {
    return this.httpClient.get<{txid: string}>(`${this.stateService.env.SERVICES_API}/testnet4/faucet/request?address=${address}&sats=${sats}`, { responseType: 'json' });
  }

  generateBTCPayAcceleratorInvoice$(txid: string, sats: number): Observable<any> {
    const params = {
      product: txid,
      amount: sats,
    };
    return this.httpClient.post<any>(`${this.stateService.env.SERVICES_API}/payments/bitcoin`, params);
  }

  retreiveInvoice$(invoiceId: string): Observable<any[]> {
    return this.httpClient.get<any[]>(`${this.stateService.env.SERVICES_API}/payments/bitcoin/invoice?id=${invoiceId}`);
  }

  getPaymentStatus$(orderId: string): Observable<any> {
    return this.httpClient.get<any>(`${this.stateService.env.SERVICES_API}/payments/bitcoin/check?order_id=${orderId}`, { observe: 'response' });
  }
}
