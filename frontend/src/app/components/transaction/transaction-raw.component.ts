import { Component, OnInit, HostListener, ViewChild, ElementRef, OnDestroy } from '@angular/core';
import { Transaction, Vout } from '@interfaces/electrs.interface';
import { StateService } from '../../services/state.service';
import { Filter, toFilters } from '../../shared/filters.utils';
import { decodeRawTransaction, getTransactionFlags, addInnerScriptsToVin, countSigops } from '../../shared/transaction.utils';
import { ETA, EtaService } from '../../services/eta.service';
import { combineLatest, firstValueFrom, map, Observable, startWith, Subscription } from 'rxjs';
import { WebsocketService } from '../../services/websocket.service';
import { ActivatedRoute, Router } from '@angular/router';
import { UntypedFormBuilder, UntypedFormGroup, Validators } from '@angular/forms';
import { ElectrsApiService } from '../../services/electrs-api.service';
import { SeoService } from '../../services/seo.service';
import { seoDescriptionNetwork } from '@app/shared/common.utils';
import { ApiService } from '../../services/api.service';
import { RelativeUrlPipe } from '@app/shared/pipes/relative-url/relative-url.pipe';
import { CpfpInfo } from '../../interfaces/node-api.interface';

@Component({
  selector: 'app-transaction-raw',
  templateUrl: './transaction-raw.component.html',
  styleUrls: ['./transaction-raw.component.scss'],
})
export class TransactionRawComponent implements OnInit, OnDestroy {

  pushTxForm: UntypedFormGroup;
  isLoading: boolean;
  isLoadingPrevouts: boolean;
  isLoadingCpfpInfo: boolean;
  offlineMode: boolean = false;
  transaction: Transaction;
  error: string;
  errorPrevouts: string;
  errorCpfpInfo: string;
  hasPrevouts: boolean;
  missingPrevouts: string[];
  isLoadingBroadcast: boolean;
  errorBroadcast: string;
  successBroadcast: boolean;

  isMobile: boolean;
  @ViewChild('graphContainer')
  graphContainer: ElementRef;
  graphExpanded: boolean = false;
  graphWidth: number = 1068;
  graphHeight: number = 360;
  inOutLimit: number = 150;
  maxInOut: number = 0;
  flowPrefSubscription: Subscription;
  hideFlow: boolean = this.stateService.hideFlow.value;
  flowEnabled: boolean;
  adjustedVsize: number;
  filters: Filter[] = [];
  hasEffectiveFeeRate: boolean;
  fetchCpfp: boolean;
  cpfpInfo: CpfpInfo | null;
  hasCpfp: boolean = false;
  showCpfpDetails = false;
  ETA$: Observable<ETA | null>;
  mempoolBlocksSubscription: Subscription;

  constructor(
    public route: ActivatedRoute,
    public router: Router,
    public stateService: StateService,
    public etaService: EtaService,
    public electrsApi: ElectrsApiService,
    public websocketService: WebsocketService,
    public formBuilder: UntypedFormBuilder,
    public seoService: SeoService,
    public apiService: ApiService,
    public relativeUrlPipe: RelativeUrlPipe,
  ) {}

  ngOnInit(): void {
    this.seoService.setTitle($localize`:@@meta.title.preview-tx:Preview Transaction`);
    this.seoService.setDescription($localize`:@@meta.description.preview-tx:Preview a transaction to the Bitcoin${seoDescriptionNetwork(this.stateService.network)} network using the transaction's raw hex data.`);
    this.websocketService.want(['blocks', 'mempool-blocks']);
    this.pushTxForm = this.formBuilder.group({
      txRaw: ['', Validators.required],
    });
  }

  async decodeTransaction(): Promise<void> {
    this.resetState();
    this.isLoading = true;
    try {
      const tx = decodeRawTransaction(this.pushTxForm.get('txRaw').value, this.stateService.network);
      await this.fetchPrevouts(tx);
      await this.fetchCpfpInfo(tx);
      this.processTransaction(tx);
    } catch (error) {
      this.error = error.message;
    } finally {
      this.isLoading = false;
    }
  }

  async fetchPrevouts(transaction: Transaction): Promise<void> {
    if (this.offlineMode) {
      return;
    }

    const prevoutsToFetch = transaction.vin.map((input) => ({ txid: input.txid, vout: input.vout }));

    if (!prevoutsToFetch.length || transaction.vin[0].is_coinbase) {
      this.hasPrevouts = true;
      return;
    }

    try {
      this.missingPrevouts = [];
      this.isLoadingPrevouts = true;

      const prevouts: { prevout: Vout, unconfirmed: boolean }[] = await firstValueFrom(this.apiService.getPrevouts$(prevoutsToFetch));

      if (prevouts?.length !== prevoutsToFetch.length) {
        throw new Error();
      }

      transaction.vin = transaction.vin.map((input, index) => {
        if (prevouts[index]) {
          input.prevout = prevouts[index].prevout;
          addInnerScriptsToVin(input);
        } else {
          this.missingPrevouts.push(`${input.txid}:${input.vout}`);
        }
        return input;
      });

      if (this.missingPrevouts.length) {
        throw new Error(`Some prevouts do not exist or are already spent (${this.missingPrevouts.length})`);
      }

      transaction.fee = transaction.vin.some(input => input.is_coinbase)
        ? 0
        : transaction.vin.reduce((fee, input) => {
          return fee + (input.prevout?.value || 0);
        }, 0) - transaction.vout.reduce((sum, output) => sum + output.value, 0);
      transaction.feePerVsize = transaction.fee / (transaction.weight / 4);
      transaction.sigops = countSigops(transaction);

      this.hasPrevouts = true;
      this.isLoadingPrevouts = false;
      this.fetchCpfp = prevouts.some(prevout => prevout?.unconfirmed);
    } catch (error) {
      console.log(error);
      this.errorPrevouts = error?.error?.error || error?.message;
      this.isLoadingPrevouts = false;
    }
  }

  async fetchCpfpInfo(transaction: Transaction): Promise<void> {
    // Fetch potential cpfp data if all prevouts were parsed successfully and at least one of them is unconfirmed
    if (this.hasPrevouts && this.fetchCpfp) {
      try {
        this.isLoadingCpfpInfo = true;
        const cpfpInfo: CpfpInfo[] = await firstValueFrom(this.apiService.getCpfpLocalTx$([{
          txid: transaction.txid,
          weight: transaction.weight,
          sigops: transaction.sigops,
          fee: transaction.fee,
          vin: transaction.vin,
          vout: transaction.vout
        }]));

        if (cpfpInfo?.[0]?.ancestors?.length) {
          const { ancestors, effectiveFeePerVsize } = cpfpInfo[0];
          transaction.effectiveFeePerVsize = effectiveFeePerVsize;
          this.cpfpInfo = { ancestors, effectiveFeePerVsize };
          this.hasCpfp = true;
          this.hasEffectiveFeeRate = true;
        }
        this.isLoadingCpfpInfo = false;
      } catch (error) {
        this.errorCpfpInfo = error?.error?.error || error?.message;
        this.isLoadingCpfpInfo = false;
      }
    }
  }

  processTransaction(tx: Transaction): void {
    this.transaction = tx;

    this.transaction.flags = getTransactionFlags(this.transaction, null, null, null, this.stateService.network);
    this.filters = this.transaction.flags ? toFilters(this.transaction.flags).filter(f => f.txPage) : [];
    if (this.transaction.sigops >= 0) {
      this.adjustedVsize = Math.max(this.transaction.weight / 4, this.transaction.sigops * 5);
    }

    this.setupGraph();
    this.setFlowEnabled();
    this.flowPrefSubscription = this.stateService.hideFlow.subscribe((hide) => {
      this.hideFlow = !!hide;
      this.setFlowEnabled();
    });
    this.setGraphSize();

    this.ETA$ = combineLatest([
      this.stateService.mempoolBlocks$.pipe(startWith(null)),
      this.stateService.difficultyAdjustment$.pipe(startWith(null)),
    ]).pipe(
      map(([mempoolBlocks, da]) => {
        return this.etaService.calculateETA(
          this.stateService.network,
          this.transaction,
          mempoolBlocks,
          null,
          da,
          null,
          null,
          null
        );
      })
    );

    this.mempoolBlocksSubscription = this.stateService.mempoolBlocks$.subscribe(() => {
      if (this.transaction) {
        this.stateService.markBlock$.next({
          txid: this.transaction.txid,
          txFeePerVSize: this.transaction.effectiveFeePerVsize || this.transaction.feePerVsize,
        });
      }
    });
  }

  async postTx(): Promise<string> {
    this.isLoadingBroadcast = true;
    this.errorBroadcast = null;
    return new Promise((resolve, reject) => {
      this.apiService.postTransaction$(this.pushTxForm.get('txRaw').value)
      .subscribe((result) => {
        this.isLoadingBroadcast = false;
        this.successBroadcast = true;
        this.transaction.txid = result;
        resolve(result);
      },
      (error) => {
        if (typeof error.error === 'string') {
          const matchText = error.error.replace(/\\/g, '').match('"message":"(.*?)"');
          this.errorBroadcast = 'Failed to broadcast transaction, reason: ' + (matchText && matchText[1] || error.error);
        } else if (error.message) {
          this.errorBroadcast = 'Failed to broadcast transaction, reason: ' + error.message;
        }
        this.isLoadingBroadcast = false;
        reject(this.error);
      });
    });
  }

  resetState() {
    this.transaction = null;
    this.error = null;
    this.errorPrevouts = null;
    this.errorBroadcast = null;
    this.successBroadcast = false;
    this.isLoading = false;
    this.isLoadingPrevouts = false;
    this.isLoadingCpfpInfo = false;
    this.isLoadingBroadcast = false;
    this.adjustedVsize = null;
    this.showCpfpDetails = false;
    this.hasCpfp = false;
    this.fetchCpfp = false;
    this.cpfpInfo = null;
    this.hasEffectiveFeeRate = false;
    this.filters = [];
    this.hasPrevouts = false;
    this.missingPrevouts = [];
    this.stateService.markBlock$.next({});
    this.mempoolBlocksSubscription?.unsubscribe();
  }

  resetForm() {
    this.resetState();
    this.pushTxForm.reset();
  }

  @HostListener('window:resize', ['$event'])
  setGraphSize(): void {
    this.isMobile = window.innerWidth < 850;
    if (this.graphContainer?.nativeElement && this.stateService.isBrowser) {
      setTimeout(() => {
        if (this.graphContainer?.nativeElement?.clientWidth) {
          this.graphWidth = this.graphContainer.nativeElement.clientWidth;
        } else {
          setTimeout(() => { this.setGraphSize(); }, 1);
        }
      }, 1);
    } else {
      setTimeout(() => { this.setGraphSize(); }, 1);
    }
  }

  setupGraph() {
    this.maxInOut = Math.min(this.inOutLimit, Math.max(this.transaction?.vin?.length || 1, this.transaction?.vout?.length + 1 || 1));
    this.graphHeight = this.graphExpanded ? this.maxInOut * 15 : Math.min(360, this.maxInOut * 80);
  }

  toggleGraph() {
    const showFlow = !this.flowEnabled;
    this.stateService.hideFlow.next(!showFlow);
  }

  setFlowEnabled() {
    this.flowEnabled = !this.hideFlow;
  }

  expandGraph() {
    this.graphExpanded = true;
    this.graphHeight = this.maxInOut * 15;
  }

  collapseGraph() {
    this.graphExpanded = false;
    this.graphHeight = Math.min(360, this.maxInOut * 80);
  }

  onOfflineModeChange(e): void {
    this.offlineMode = !e.target.checked;
  }

  ngOnDestroy(): void {
    this.mempoolBlocksSubscription?.unsubscribe();
    this.flowPrefSubscription?.unsubscribe();
    this.stateService.markBlock$.next({});
  }

}
