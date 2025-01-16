import { Component, OnInit, OnDestroy, HostListener, Inject, ChangeDetectorRef, ChangeDetectionStrategy, NgZone } from '@angular/core';
import { ElectrsApiService } from '@app/services/electrs-api.service';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import {
  switchMap,
  filter,
  catchError,
  retryWhen,
  delay,
  mergeMap,
  tap,
  map,
  startWith
} from 'rxjs/operators';
import { Transaction } from '@interfaces/electrs.interface';
import { of, merge, Subscription, Observable, Subject, throwError, combineLatest, BehaviorSubject } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { CacheService } from '@app/services/cache.service';
import { WebsocketService } from '@app/services/websocket.service';
import { AudioService } from '@app/services/audio.service';
import { ApiService } from '@app/services/api.service';
import { SeoService } from '@app/services/seo.service';
import { seoDescriptionNetwork } from '@app/shared/common.utils';
import { Filter, TransactionFlags } from '@app/shared/filters.utils';
import { BlockExtended, CpfpInfo, RbfTree, MempoolPosition, DifficultyAdjustment, Acceleration, AccelerationPosition } from '@interfaces/node-api.interface';
import { PriceService } from '@app/services/price.service';
import { ServicesApiServices } from '@app/services/services-api.service';
import { EnterpriseService } from '@app/services/enterprise.service';
import { ZONE_SERVICE } from '@app/injection-tokens';
import { TrackerStage } from '@components/tracker/tracker-bar.component';
import { MiningService, MiningStats } from '@app/services/mining.service';
import { ETA, EtaService } from '@app/services/eta.service';
import { getTransactionFlags, getUnacceleratedFeeRate } from '@app/shared/transaction.utils';
import { RelativeUrlPipe } from '@app/shared/pipes/relative-url/relative-url.pipe';


interface Pool {
  id: number;
  name: string;
  slug: string;
}

interface AuditStatus {
  seen?: boolean;
  expected?: boolean;
  added?: boolean;
  prioritized?: boolean;
  delayed?: number;
  accelerated?: boolean;
  conflict?: boolean;
  coinbase?: boolean;
}

@Component({
  selector: 'app-tracker',
  templateUrl: './tracker.component.html',
  styleUrls: ['./tracker.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TrackerComponent implements OnInit, OnDestroy {
  network = '';
  tx: Transaction;
  txId: string;
  txInBlockIndex: number;
  mempoolPosition: MempoolPosition;
  accelerationPositions: AccelerationPosition[];
  isLoadingTx = true;
  loadingCachedTx = false;
  loadingPosition = true;
  error: any = undefined;
  waitingForTransaction = false;
  latestBlock: BlockExtended;
  transactionTime = -1;
  subscription: Subscription;
  fetchCpfpSubscription: Subscription;
  fetchRbfSubscription: Subscription;
  fetchCachedTxSubscription: Subscription;
  fetchAccelerationSubscription: Subscription;
  txReplacedSubscription: Subscription;
  mempoolPositionSubscription: Subscription;
  mempoolBlocksSubscription: Subscription;
  blocksSubscription: Subscription;
  miningSubscription: Subscription;
  currencyChangeSubscription: Subscription;
  rbfTransaction: undefined | Transaction;
  replaced: boolean = false;
  latestReplacement: string;
  rbfReplaces: string[];
  rbfInfo: RbfTree;
  cpfpInfo: CpfpInfo | null;
  hasCpfp: boolean = false;
  accelerationInfo: Acceleration | null = null;
  sigops: number | null;
  adjustedVsize: number | null;
  pool: Pool | null;
  auditStatus: AuditStatus | null;
  isAcceleration: boolean = false;
  filters: Filter[] = [];
  showCpfpDetails = false;
  miningStats: MiningStats;
  fetchCpfp$ = new Subject<string>();
  fetchRbfHistory$ = new Subject<string>();
  fetchCachedTx$ = new Subject<string>();
  fetchAcceleration$ = new Subject<string>();
  fetchMiningInfo$ = new Subject<{ hash: string, height: number, txid: string }>();
  txChanged$ = new BehaviorSubject<boolean>(false); // triggered whenever this.tx changes (long term, we should refactor to make this.tx an observable itself)
  isAccelerated$ = new BehaviorSubject<boolean>(false); // refactor this to make isAccelerated an observable itself
  ETA$: Observable<ETA | null>;
  isCached: boolean = false;
  now = Date.now();
  da$: Observable<DifficultyAdjustment>;
  isMobile: boolean;

  trackerStage: TrackerStage = 'waiting';

  blockchainHeight: number = 100;
  blockchainWidth: number = 600;

  hasEffectiveFeeRate: boolean;
  accelerateCtaType: 'alert' | 'button' = 'button';
  acceleratorAvailable: boolean = this.stateService.env.ACCELERATOR && this.stateService.network === '';
  eligibleForAcceleration: boolean = false;
  accelerationFlowCompleted = false;
  scrollIntoAccelPreview = false;
  auditEnabled: boolean = this.stateService.env.AUDIT && this.stateService.env.BASE_MODULE === 'mempool' && this.stateService.env.MINING_DASHBOARD === true;

  enterpriseInfo: any;
  enterpriseInfo$: Subscription;
  officialMempoolSpace = this.stateService.env.OFFICIAL_MEMPOOL_SPACE;

  constructor(
    private route: ActivatedRoute,
    private electrsApiService: ElectrsApiService,
    public stateService: StateService,
    private etaService: EtaService,
    private cacheService: CacheService,
    private websocketService: WebsocketService,
    private audioService: AudioService,
    private apiService: ApiService,
    private servicesApiService: ServicesApiServices,
    private seoService: SeoService,
    private priceService: PriceService,
    private enterpriseService: EnterpriseService,
    private miningService: MiningService,
    private router: Router,
    private cd: ChangeDetectorRef,
    private zone: NgZone,
    @Inject(ZONE_SERVICE) private zoneService: any,
  ) {}

  ngOnInit() {
    this.onResize();

    this.acceleratorAvailable = this.stateService.env.OFFICIAL_MEMPOOL_SPACE && this.stateService.env.ACCELERATOR && this.stateService.network === '';

    this.miningService.getMiningStats('1w').subscribe(stats => {
      this.miningStats = stats;
    });

    this.enterpriseService.page();

    this.enterpriseInfo$ = this.enterpriseService.info$.subscribe(info => {
      this.enterpriseInfo = info;
    });

    this.websocketService.want(['blocks', 'mempool-blocks']);
    this.stateService.networkChanged$.subscribe(
      (network) => {
        this.network = network;
        this.acceleratorAvailable = this.stateService.env.OFFICIAL_MEMPOOL_SPACE && this.stateService.env.ACCELERATOR && this.stateService.network === '';
      }
    );

    this.da$ = this.stateService.difficultyAdjustment$.pipe(
      tap(() => {
        this.now = Date.now();
      })
    );

    this.blocksSubscription = this.stateService.blocks$.subscribe((blocks) => {
      this.latestBlock = blocks[0];
    });

    this.fetchCpfpSubscription = this.fetchCpfp$
      .pipe(
        switchMap((txId) =>
          this.apiService
            .getCpfpinfo$(txId)
            .pipe(retryWhen((errors) => errors.pipe(
              mergeMap((error) => {
                if (!this.tx?.status || this.tx.status.confirmed) {
                  return throwError(error);
                } else {
                  return of(null);
                }
              }),
              delay(2000)
            )),
            catchError(() => {
              return of(null);
            })
          )
        ),
        catchError(() => {
          return of(null);
        })
      )
      .subscribe((cpfpInfo) => {
        this.setCpfpInfo(cpfpInfo);
      });

    this.fetchRbfSubscription = this.fetchRbfHistory$
    .pipe(
      switchMap((txId) =>
        this.apiService
          .getRbfHistory$(txId)
      ),
      catchError(() => {
        return of(null);
      })
    ).subscribe((rbfResponse) => {
      this.rbfInfo = rbfResponse?.replacements;
      this.rbfReplaces = rbfResponse?.replaces || null;
      if (this.rbfInfo) {
        // link to the latest pending version
        this.latestReplacement = this.rbfInfo.tx.txid;
        // or traverse the rbf tree to find a confirmed version
        if (this.rbfInfo.mined) {
          const stack = [this.rbfInfo];
          let found = false;
          while (stack.length && !found) {
            const top = stack.pop();
            if (top?.tx.mined) {
              found = true;
              this.latestReplacement = top.tx.txid;
              break;
            } else {
              stack.push(...top.replaces);
            }
          }
        }
      }
    });

    this.fetchCachedTxSubscription = this.fetchCachedTx$
    .pipe(
      tap(() => {
        this.loadingCachedTx = true;
      }),
      switchMap((txId) =>
        this.apiService
          .getRbfCachedTx$(txId)
      ),
      catchError(() => {
        return of(null);
      })
    ).subscribe((tx) => {
      this.loadingCachedTx = false;
      if (!tx) {
        this.seoService.logSoft404();
        return;
      }
      this.seoService.clearSoft404();

      if (!this.tx) {
        this.tx = tx;
        this.checkAccelerationEligibility();
        this.isCached = true;
        if (tx.fee === undefined) {
          this.tx.fee = 0;
        }
        this.tx.feePerVsize = tx.fee / (tx.weight / 4);
        this.isLoadingTx = false;
        this.error = undefined;
        this.waitingForTransaction = false;
        this.transactionTime = tx.firstSeen || 0;

        this.fetchRbfHistory$.next(this.tx.txid);
        this.txChanged$.next(true);
      }
    });

    this.fetchAccelerationSubscription = this.fetchAcceleration$.pipe(
      filter(() => this.stateService.env.ACCELERATOR === true),
      tap(() => {
        this.accelerationInfo = null;
      }),
      switchMap((blockHash: string) => {
        return this.servicesApiService.getAllAccelerationHistory$({ blockHash }, null, this.txId);
      }),
      catchError(() => {
        return of(null);
      })
    ).subscribe((accelerationHistory) => {
      for (const acceleration of accelerationHistory) {
        if (acceleration.txid === this.txId && (acceleration.status === 'completed' || acceleration.status === 'completed_provisional') && acceleration.pools.includes(acceleration.minedByPoolUniqueId)) {
          const boostCost = acceleration.boostCost || acceleration.bidBoost;
          acceleration.acceleratedFeeRate = Math.max(acceleration.effectiveFee, acceleration.effectiveFee + boostCost) / acceleration.effectiveVsize;
          acceleration.boost = boostCost;

          this.accelerationInfo = acceleration;
          this.setIsAccelerated();
        }
      }
    });

    this.miningSubscription = this.fetchMiningInfo$.pipe(
      filter((target) => target.txid === this.txId),
      tap(() => {
        this.pool = null;
        this.auditStatus = null;
      }),
      switchMap(({ hash, height, txid }) => {
        const foundBlock = this.cacheService.getCachedBlock(height) || null;
        const auditAvailable = this.isAuditAvailable(height);
        const isCoinbase = this.tx.vin.some(v => v.is_coinbase);
        const fetchAudit = auditAvailable && !isCoinbase;
        return combineLatest([
          foundBlock ? of(foundBlock.extras.pool) : this.apiService.getBlock$(hash).pipe(
            map(block => {
              return block.extras.pool;
            }),
            catchError(() => {
              return of(null);
            })
          ),
          fetchAudit ? this.apiService.getBlockAudit$(hash).pipe(
            map(audit => {
              const isAdded = audit.addedTxs.includes(txid);
              const isPrioritized = audit.prioritizedTxs.includes(txid);
              const isAccelerated = audit.acceleratedTxs.includes(txid);
              const isConflict = audit.fullrbfTxs.includes(txid);
              const isExpected = audit.template.some(tx => tx.txid === txid);
              return {
                seen: isExpected || isPrioritized || isAccelerated,
                expected: isExpected,
                added: isAdded,
                prioritized: isPrioritized,
                conflict: isConflict,
                accelerated: isAccelerated,
              };
            }),
            catchError(() => {
              return of(null);
            })
          ) : of(isCoinbase ? { coinbase: true } : null)
        ]);
      }),
      catchError(() => {
        return of(null);
      })
    ).subscribe(([pool, auditStatus]) => {
      this.pool = pool;
      this.auditStatus = auditStatus;
    });

    this.mempoolPositionSubscription = this.stateService.mempoolTxPosition$.subscribe(txPosition => {
      this.now = Date.now();
      if (txPosition && txPosition.txid === this.txId && txPosition.position) {
        this.loadingPosition = false;
        this.mempoolPosition = txPosition.position;
        this.accelerationPositions = txPosition.accelerationPositions;
        if (this.tx && !this.tx.status.confirmed) {
          const txFeePerVSize = getUnacceleratedFeeRate(this.tx, this.tx.acceleration || this.mempoolPosition?.accelerated);
          this.stateService.markBlock$.next({
            txid: txPosition.txid,
            txFeePerVSize,
            mempoolPosition: this.mempoolPosition,
            accelerationPositions: this.accelerationPositions,
          });
          this.txInBlockIndex = this.mempoolPosition.block;

          if (txPosition.cpfp !== undefined) {
            this.setCpfpInfo(txPosition.cpfp);
          }

          if (txPosition.position?.accelerated) {
            this.tx.acceleration = true;
            this.tx.acceleratedBy = txPosition.position?.acceleratedBy;
          }

          if (this.replaced) {
            this.trackerStage = 'replaced';
          }

          if (this.mempoolPosition.accelerated && this.showAccelerationSummary) {
            setTimeout(() => {
              this.accelerationFlowCompleted = true;
            }, 2000);
          }
        }
      } else {
        this.mempoolPosition = null;
        this.accelerationPositions = null;
      }
    });

    this.subscription = this.zoneService.wrapObservable(this.route.paramMap
      .pipe(
        switchMap((params: ParamMap) => {
          const urlMatch = (params.get('id') || '').split(':');
          if (urlMatch.length === 2 && urlMatch[1].length === 64) {
            const vin = parseInt(urlMatch[0], 10);
            this.txId = urlMatch[1];
          } else {
            this.txId = urlMatch[0];
          }
          this.seoService.setTitle(
            $localize`:@@bisq.transaction.browser-title:Transaction: ${this.txId}:INTERPOLATION:`
          );
          const network = this.stateService.network === 'liquid' || this.stateService.network === 'liquidtestnet' ? 'Liquid' : 'Bitcoin';
          const seoDescription = seoDescriptionNetwork(this.stateService.network);
          this.seoService.setDescription($localize`:@@meta.description.bitcoin.transaction:Get real-time status, addresses, fees, script info, and more for ${network}${seoDescription} transaction with txid ${this.txId}.`);
          this.resetTransaction();
          return merge(
            of(true),
            this.stateService.connectionState$.pipe(
              filter(
                (state) => state === 2 && this.tx && !this.tx.status?.confirmed
              )
            )
          );
        }),
        switchMap(() => {
          let transactionObservable$: Observable<Transaction>;
          const cached = this.cacheService.getTxFromCache(this.txId);
          if (cached && cached.fee !== -1) {
            transactionObservable$ = of(cached);
          } else {
            transactionObservable$ = this.electrsApiService
              .getTransaction$(this.txId)
              .pipe(
                catchError(this.handleLoadElectrsTransactionError.bind(this))
              );
          }
          return merge(
            transactionObservable$,
            this.stateService.mempoolTransactions$
          );
        }),
      ))
      .subscribe((tx: Transaction) => {
          if (!tx) {
            this.loadingPosition = false;
            this.fetchCachedTx$.next(this.txId);
            this.seoService.logSoft404();
            return;
          }
          this.seoService.clearSoft404();

          this.tx = tx;
          this.checkAccelerationEligibility();
          this.isCached = false;
          if (tx.fee === undefined) {
            this.tx.fee = 0;
          }
          if (this.tx.sigops != null) {
            this.sigops = this.tx.sigops;
            this.adjustedVsize = Math.max(this.tx.weight / 4, this.sigops * 5);
          }
          this.tx.feePerVsize = tx.fee / (tx.weight / 4);
          this.txChanged$.next(true);
          this.isLoadingTx = false;
          this.error = undefined;
          this.loadingCachedTx = false;
          this.waitingForTransaction = false;
          this.websocketService.startTrackTransaction(tx.txid);

          if (!tx.status?.confirmed) {
            this.trackerStage = 'pending';
            if (tx.firstSeen) {
              this.transactionTime = tx.firstSeen;
            } else {
              this.getTransactionTime();
            }
          } else {
            this.trackerStage = 'confirmed';
            this.loadingPosition = false;
            this.fetchAcceleration$.next(tx.status.block_hash);
            this.fetchMiningInfo$.next({ hash: tx.status.block_hash, height: tx.status.block_height, txid: tx.txid });
            this.transactionTime = 0;
          }

          if (this.tx?.status?.confirmed) {
            this.stateService.markBlock$.next({
              blockHeight: tx.status.block_height,
            });
            this.fetchCpfp$.next(this.tx.txid);
          } else {
            const txFeePerVSize = getUnacceleratedFeeRate(this.tx, this.tx.acceleration || this.mempoolPosition?.accelerated);
            if (tx.cpfpChecked) {
              this.stateService.markBlock$.next({
                txid: tx.txid,
                txFeePerVSize,
                mempoolPosition: this.mempoolPosition,
                accelerationPositions: this.accelerationPositions,
              });
              this.setCpfpInfo({
                ancestors: tx.ancestors,
                bestDescendant: tx.bestDescendant,
              });
              const hasRelatives = !!(tx.ancestors?.length || tx.bestDescendant);
              this.hasEffectiveFeeRate = hasRelatives || (tx.effectiveFeePerVsize && (Math.abs(tx.effectiveFeePerVsize - tx.feePerVsize) > 0.01));
            } else {
              this.fetchCpfp$.next(this.tx.txid);
            }
          }
          this.fetchRbfHistory$.next(this.tx.txid);
          this.currencyChangeSubscription?.unsubscribe();
          this.currencyChangeSubscription = this.stateService.fiatCurrency$.pipe(
            switchMap((currency) => {
              return tx.status.block_time ? this.priceService.getBlockPrice$(tx.status.block_time, true, currency).pipe(
                tap((price) => tx['price'] = price),
              ) : of(undefined);
            })
          ).subscribe();

          this.cd.detectChanges();
        },
        (error) => {
          this.error = error;
          this.seoService.logSoft404();
          this.isLoadingTx = false;
        }
      );

    this.stateService.txConfirmed$.subscribe(([txConfirmed, block]) => {
      if (txConfirmed && this.tx && !this.tx.status.confirmed && txConfirmed === this.tx.txid) {
        this.tx.status = {
          confirmed: true,
          block_height: block.height,
          block_hash: block.id,
          block_time: block.timestamp,
        };
        this.txChanged$.next(true);
        this.trackerStage = 'confirmed';
        this.stateService.markBlock$.next({ blockHeight: block.height });
        if (this.tx.acceleration || (this.accelerationInfo && ['accelerating', 'completed_provisional', 'completed'].includes(this.accelerationInfo.status))) {
          this.audioService.playSound('wind-chimes-harp-ascend');
        } else {
          this.audioService.playSound('magic');
        }
        this.fetchAcceleration$.next(block.id);
        this.fetchMiningInfo$.next({ hash: block.id, height: block.height, txid: this.tx.txid });
      }
    });

    this.txReplacedSubscription = this.stateService.txReplaced$.subscribe((rbfTransaction) => {
      if (!this.tx) {
        this.error = new Error();
        this.loadingCachedTx = false;
        this.waitingForTransaction = false;
      }
      this.rbfTransaction = rbfTransaction;
      this.replaced = true;
      this.trackerStage = 'replaced';
      if (!this.rbfInfo) {
        this.latestReplacement = this.rbfTransaction.txid;
      }
      this.stateService.markBlock$.next({});

      if (rbfTransaction && !this.tx) {
        this.fetchCachedTx$.next(this.txId);
      }
    });

    this.mempoolBlocksSubscription = this.stateService.mempoolBlocks$.subscribe((mempoolBlocks) => {
      this.now = Date.now();

      if (!this.tx || this.mempoolPosition) {
        return;
      }

      const txFeePerVSize =
        this.tx.effectiveFeePerVsize || this.tx.fee / (this.tx.weight / 4);

      let found = false;
      this.txInBlockIndex = 0;
      for (const block of mempoolBlocks) {
        for (let i = 0; i < block.feeRange.length - 1 && !found; i++) {
          if (
            txFeePerVSize <= block.feeRange[i + 1] &&
            txFeePerVSize >= block.feeRange[i]
          ) {
            this.txInBlockIndex = mempoolBlocks.indexOf(block);
            found = true;
          }
        }
      }
      if (!found && mempoolBlocks.length && txFeePerVSize < mempoolBlocks[mempoolBlocks.length - 1].feeRange[0]) {
        this.txInBlockIndex = 7;
      }
    });

    this.ETA$ = combineLatest([
      this.stateService.mempoolTxPosition$.pipe(startWith(null)),
      this.stateService.mempoolBlocks$.pipe(startWith(null)),
      this.stateService.difficultyAdjustment$.pipe(startWith(null)),
      this.isAccelerated$,
      this.txChanged$,
    ]).pipe(
      filter(([position, mempoolBlocks, da, isAccelerated]) => {
        return this.tx && !this.tx?.status?.confirmed && position && this.tx.txid === position.txid;
      }),
      map(([position, mempoolBlocks, da, isAccelerated]) => {
        return this.etaService.calculateETA(
          this.network,
          this.tx,
          mempoolBlocks,
          position,
          da,
          this.miningStats,
          isAccelerated,
          this.accelerationPositions,
        );
      }),
      tap(eta => {
        if (this.replaced) {
          this.trackerStage = 'replaced'
        } else if (eta?.blocks === 0) {
          this.trackerStage = 'next';
        } else if (eta?.blocks < 3){
          this.trackerStage = 'soon';
        } else {
          this.trackerStage = 'pending';
        }
      })
    )
  }

  handleLoadElectrsTransactionError(error: any): Observable<any> {
    if (error.status === 404 && /^[a-fA-F0-9]{64}$/.test(this.txId)) {
      this.websocketService.startMultiTrackTransaction(this.txId);
      this.waitingForTransaction = true;
    }
    this.error = error;
    this.seoService.logSoft404();
    this.isLoadingTx = false;
    return of(false);
  }

  getTransactionTime() {
    this.apiService
      .getTransactionTimes$([this.tx.txid])
      .subscribe((transactionTimes) => {
        if (transactionTimes?.length) {
          this.transactionTime = transactionTimes[0];
        }
      });
  }

  setCpfpInfo(cpfpInfo: CpfpInfo): void {
    if (!cpfpInfo || !this.tx) {
      this.cpfpInfo = null;
      this.hasCpfp = false;
      this.hasEffectiveFeeRate = false;
      return;
    }
    const firstCpfp = this.cpfpInfo == null;
    // merge ancestors/descendants
    const relatives = [...(cpfpInfo.ancestors || []), ...(cpfpInfo.descendants || [])];
    if (cpfpInfo.bestDescendant && !cpfpInfo.descendants?.length) {
      relatives.push(cpfpInfo.bestDescendant);
    }
    const hasRelatives = !!relatives.length;
    if (!cpfpInfo.effectiveFeePerVsize && hasRelatives) {
      const totalWeight =
        this.tx.weight +
        relatives.reduce((prev, val) => prev + val.weight, 0);
      const totalFees =
        this.tx.fee +
        relatives.reduce((prev, val) => prev + val.fee, 0);
      this.tx.effectiveFeePerVsize = totalFees / (totalWeight / 4);
    } else {
      this.tx.effectiveFeePerVsize = cpfpInfo.effectiveFeePerVsize || this.tx.effectiveFeePerVsize || this.tx.feePerVsize || (this.tx.fee / (this.tx.weight / 4));
    }
    if (cpfpInfo.acceleration) {
      this.tx.acceleration = cpfpInfo.acceleration;
      this.tx.acceleratedBy = cpfpInfo.acceleratedBy;
      this.setIsAccelerated(firstCpfp);
    }
    this.txChanged$.next(true);

    this.cpfpInfo = cpfpInfo;
    if (this.cpfpInfo.adjustedVsize && this.cpfpInfo.sigops != null) {
      this.sigops = this.cpfpInfo.sigops;
      this.adjustedVsize = this.cpfpInfo.adjustedVsize;
    }
    this.hasCpfp =!!(this.cpfpInfo && (this.cpfpInfo.bestDescendant || this.cpfpInfo.descendants?.length || this.cpfpInfo.ancestors?.length));
    this.hasEffectiveFeeRate = hasRelatives || (this.tx.effectiveFeePerVsize && (Math.abs(this.tx.effectiveFeePerVsize - this.tx.feePerVsize) > 0.01));
  }

  isAuditAvailable(blockHeight: number): boolean {
    if (!this.auditEnabled) {
      return false;
    }
    switch (this.stateService.network) {
      case 'testnet':
        if (blockHeight < this.stateService.env.TESTNET_BLOCK_AUDIT_START_HEIGHT) {
          return false;
        }
        break;
      case 'signet':
        if (blockHeight < this.stateService.env.SIGNET_BLOCK_AUDIT_START_HEIGHT) {
          return false;
        }
        break;
      default:
        if (blockHeight < this.stateService.env.MAINNET_BLOCK_AUDIT_START_HEIGHT) {
          return false;
        }
    }
    return true;
  }

  setIsAccelerated(initialState: boolean = false) {
    this.isAcceleration = (this.tx.acceleration || (this.accelerationInfo && this.pool && this.accelerationInfo.pools.some(pool => (pool === this.pool.id))));
    if (this.isAcceleration) {
      // this immediately returns cached stats if we fetched them recently
      this.miningService.getMiningStats('1w').subscribe(stats => {
        this.miningStats = stats;
        this.isAccelerated$.next(this.isAcceleration); // hack to trigger recalculation of ETA without adding another source observable
      });
      this.accelerationFlowCompleted = true;
    }
    this.isAccelerated$.next(this.isAcceleration);
  }

  dismissAccelAlert(): void {
    this.accelerateCtaType = 'button';
  }

  onAccelerateClicked() {
    if (!this.txId) {
      return;
    }
    this.accelerationFlowCompleted = false;
    if (this.showAccelerationSummary) {
      this.scrollIntoAccelPreview = true;
    }
    return false;
  }

  get isLoading(): boolean {
    return this.isLoadingTx || this.loadingCachedTx || this.loadingPosition;
  }

  checkAccelerationEligibility() {
    if (this.tx) {
      this.tx.flags = getTransactionFlags(this.tx, null, null, this.tx.status?.block_time, this.stateService.network);
      const replaceableInputs = (this.tx.flags & (TransactionFlags.sighash_none | TransactionFlags.sighash_acp)) > 0n;
      const highSigop = (this.tx.sigops * 20) > this.tx.weight;
      this.eligibleForAcceleration = !replaceableInputs && !highSigop;
    } else {
      this.eligibleForAcceleration = false;
    }
  }

  get showAccelerationSummary(): boolean {
    return (
      this.tx
      && !this.replaced
      && !this.isCached
      && this.acceleratorAvailable
      && this.eligibleForAcceleration
      && !this.accelerationFlowCompleted
    );
  }

  resetTransaction() {
    this.error = undefined;
    this.tx = null;
    this.txChanged$.next(true);
    this.waitingForTransaction = false;
    this.isLoadingTx = true;
    this.loadingPosition = true;
    this.rbfTransaction = undefined;
    this.replaced = false;
    this.latestReplacement = '';
    this.transactionTime = -1;
    this.cpfpInfo = null;
    this.adjustedVsize = null;
    this.sigops = null;
    this.hasEffectiveFeeRate = false;
    this.rbfInfo = null;
    this.rbfReplaces = [];
    this.filters = [];
    this.showCpfpDetails = false;
    this.accelerationInfo = null;
    this.txInBlockIndex = null;
    this.mempoolPosition = null;
    this.pool = null;
    this.auditStatus = null;
    this.accelerationPositions = null;
    this.eligibleForAcceleration = false;
    this.trackerStage = 'waiting';
    document.body.scrollTo(0, 0);
    this.leaveTransaction();
  }

  leaveTransaction() {
    this.websocketService.stopTrackingTransaction();
    this.stateService.markBlock$.next({});
  }

  roundToOneDecimal(cpfpTx: any): number {
    return +(cpfpTx.fee / (cpfpTx.weight / 4)).toFixed(1);
  }

  @HostListener('window:resize', ['$event'])
  onResize(): void {
    this.isMobile = window.innerWidth < 850;
    this.blockchainWidth = Math.min(600, window.innerWidth);
    this.blockchainHeight = this.blockchainWidth / 5;
  }

  ngOnDestroy() {
    this.subscription.unsubscribe();
    this.fetchCpfpSubscription.unsubscribe();
    this.fetchRbfSubscription.unsubscribe();
    this.fetchCachedTxSubscription.unsubscribe();
    this.fetchAccelerationSubscription.unsubscribe();
    this.txReplacedSubscription.unsubscribe();
    this.mempoolBlocksSubscription.unsubscribe();
    this.mempoolPositionSubscription.unsubscribe();
    this.mempoolBlocksSubscription.unsubscribe();
    this.blocksSubscription.unsubscribe();
    this.miningSubscription?.unsubscribe();
    this.currencyChangeSubscription?.unsubscribe();
    this.enterpriseInfo$?.unsubscribe();
    this.leaveTransaction();
  }
}
