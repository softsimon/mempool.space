import { ChangeDetectionStrategy, Component, HostListener, Inject, OnDestroy, OnInit, PLATFORM_ID } from '@angular/core';
import { SeoService } from '@app/services/seo.service';
import { OpenGraphService } from '@app/services/opengraph.service';
import { WebsocketService } from '@app/services/websocket.service';
import { Acceleration, BlockExtended } from '@interfaces/node-api.interface';
import { StateService } from '@app/services/state.service';
import { Observable, Subscription, catchError, combineLatest, distinctUntilChanged, map, of, share, switchMap, tap } from 'rxjs';
import { Color } from '@components/block-overview-graph/sprite-types';
import { hexToColor } from '@components/block-overview-graph/utils';
import TxView from '@components/block-overview-graph/tx-view';
import { feeLevels, defaultMempoolFeeColors, contrastMempoolFeeColors } from '@app/app.constants';
import { ServicesApiServices } from '@app/services/services-api.service';
import { detectWebGL } from '@app/shared/graphs.utils';
import { AudioService } from '@app/services/audio.service';
import { ThemeService } from '@app/services/theme.service';

const acceleratedColor: Color = hexToColor('8F5FF6');
const normalColors = defaultMempoolFeeColors.map(hex => hexToColor(hex + '5F'));
const contrastColors = contrastMempoolFeeColors.map(hex => hexToColor(hex.slice(0,6) + '5F'));

interface AccelerationBlock extends BlockExtended {
  accelerationCount: number,
}

@Component({
  selector: 'app-accelerator-dashboard',
  templateUrl: './accelerator-dashboard.component.html',
  styleUrls: ['./accelerator-dashboard.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AcceleratorDashboardComponent implements OnInit, OnDestroy {
  blocks$: Observable<AccelerationBlock[]>;
  accelerations$: Observable<Acceleration[]>;
  pendingAccelerations$: Observable<Acceleration[]>;
  minedAccelerations$: Observable<Acceleration[]>;
  loadingBlocks: boolean = true;
  webGlEnabled = true;
  seen: Set<string> = new Set();
  firstLoad = true;
  timespan: '24h' | '1m' | '1y' | 'all' = '1y';

  accelerationDeltaSubscription: Subscription;

  graphHeight: number = 300;
  theme: ThemeService;

  constructor(
    private seoService: SeoService,
    private ogService: OpenGraphService,
    private websocketService: WebsocketService,
    private serviceApiServices: ServicesApiServices,
    private audioService: AudioService,
    private stateService: StateService,
    @Inject(PLATFORM_ID) private platformId: Object,
  ) {
    this.webGlEnabled = this.stateService.isBrowser && detectWebGL();
    this.seoService.setTitle($localize`:@@6b867dc61c6a92f3229f1950f9f2d414790cce95:Accelerator Dashboard`);
    this.ogService.setManualOgImage('accelerator.jpg');
  }

  ngOnInit(): void {
    this.onResize();
    this.websocketService.want(['blocks', 'mempool-blocks', 'stats']);
    this.websocketService.startTrackAccelerations();

    this.pendingAccelerations$ = this.stateService.liveAccelerations$.pipe(
      share(),
    );
    this.accelerationDeltaSubscription = this.stateService.accelerations$.subscribe((delta) => {
      if (!delta.reset) {
        let hasNewAcceleration = false;
        for (const acc of delta.added) {
          if (!this.seen.has(acc.txid)) {
            hasNewAcceleration = true;
          }
          this.seen.add(acc.txid);
        }
        for (const txid of delta.removed) {
          this.seen.delete(txid);
        }
        if (hasNewAcceleration) {
          this.audioService.playSound('bright-harmony');
        }
      }
    });

    this.accelerations$ = this.stateService.chainTip$.pipe(
      distinctUntilChanged(),
      switchMap(() => {
        return this.serviceApiServices.getAccelerationHistory$({}).pipe(
          catchError(() => {
            return of([]);
          }),
        );
      }),
      share(),
    );

    this.minedAccelerations$ = this.stateService.chainTip$.pipe(
      distinctUntilChanged(),
      switchMap(() => {
        return this.serviceApiServices.getAccelerationHistory$({ status: 'completed_provisional,completed', pageLength: 6 }).pipe(
          catchError(() => {
            return of([]);
          }),
        );
      }),
      share(),
    );

    this.blocks$ = combineLatest([
      this.accelerations$,
      this.stateService.blocks$.pipe(
        switchMap((blocks) => {
          if (this.stateService.env.MINING_DASHBOARD === true) {
            for (const block of blocks) {
              // @ts-ignore: Need to add an extra field for the template
              block.extras.pool.logo = `/resources/mining-pools/` +
                block.extras.pool.name.toLowerCase().replace(' ', '').replace('.', '') + '.svg';
            }
          }
          return of(blocks as AccelerationBlock[]);
        }),
        tap(() => {
          this.loadingBlocks = false;
        })
      )
    ]).pipe(
      switchMap(([accelerations, blocks]) => {
        const blockMap = {};
        for (const block of blocks) {
          blockMap[block.height] = block;
        }
        const accelerationsByBlock: { [ height: number ]: Acceleration[] } = {};
        for (const acceleration of accelerations) {
          if (['completed_provisional', 'failed_provisional', 'completed'].includes(acceleration.status) && acceleration.pools.includes(blockMap[acceleration.blockHeight]?.extras.pool.id)) {
            if (!accelerationsByBlock[acceleration.blockHeight]) {
              accelerationsByBlock[acceleration.blockHeight] = [];
            }
            accelerationsByBlock[acceleration.blockHeight].push(acceleration);
          }
        }
        return of(blocks.slice(0, 6).map(block => {
          block.accelerationCount = (accelerationsByBlock[block.id] || []).length;
          return block;
        }));
      })
    );
  }

  getAcceleratorColor(tx: TxView): Color {
    if (tx.status === 'accelerated' || tx.acc) {
      return acceleratedColor;
    } else {
      const rate = tx.fee / tx.vsize; // color by simple single-tx fee rate
      const feeLevelIndex = feeLevels.findIndex((feeLvl) => Math.max(1, rate) < feeLvl) - 1;
      return this.theme.theme === 'contrast' || this.theme.theme === 'bukele' ? contrastColors[feeLevelIndex] || contrastColors[contrastColors.length - 1] : normalColors[feeLevelIndex] || normalColors[normalColors.length - 1];
    }
  }

  setTimespan(timespan): boolean {
    this.timespan = timespan;
    return false;
  }

  ngOnDestroy(): void {
    this.accelerationDeltaSubscription.unsubscribe();
    this.websocketService.stopTrackAccelerations();
  }

  @HostListener('window:resize', ['$event'])
  onResize(): void {
    if (window.innerWidth >= 992) {
      this.graphHeight = 380;
    } else if (window.innerWidth >= 768) {
      this.graphHeight = 300;
    } else {
      this.graphHeight = 270;
    }
  }
}
