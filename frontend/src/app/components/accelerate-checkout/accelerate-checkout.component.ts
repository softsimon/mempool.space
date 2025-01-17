/* eslint-disable no-console */
import { Component, OnInit, OnDestroy, Output, EventEmitter, Input, ChangeDetectorRef, SimpleChanges, HostListener } from '@angular/core';
import { Subscription, tap, of, catchError, Observable, switchMap } from 'rxjs';
import { ServicesApiServices } from '@app/services/services-api.service';
import { md5 } from '@app/shared/common.utils';
import { StateService } from '@app/services/state.service';
import { AudioService } from '@app/services/audio.service';
import { ETA, EtaService } from '@app/services/eta.service';
import { Transaction } from '@interfaces/electrs.interface';
import { MiningStats } from '@app/services/mining.service';
import { IAuth, AuthServiceMempool } from '@app/services/auth.service';
import { EnterpriseService } from '@app/services/enterprise.service';
import { ApiService } from '@app/services/api.service';
import { isDevMode } from '@angular/core';

export type PaymentMethod = 'balance' | 'bitcoin' | 'cashapp' | 'applePay' | 'googlePay';

export type AccelerationEstimate = {
  hasAccess: boolean;
  txSummary: TxSummary;
  nextBlockFee: number;
  targetFeeRate: number;
  userBalance: number;
  enoughBalance: boolean;
  cost: number;
  mempoolBaseFee: number;
  vsizeFee: number;
  pools: number[];
  availablePaymentMethods: Record<PaymentMethod, {min: number, max: number}>;
  unavailable?: boolean;
  options: { // recommended bid options
    fee: number; // recommended userBid in sats
  }[];
}
export type TxSummary = {
  txid: string; // txid of the current transaction
  effectiveVsize: number; // Total vsize of the dependency tree
  effectiveFee: number;  // Total fee of the dependency tree in sats
  ancestorCount: number; // Number of ancestors
}

export interface RateOption {
  fee: number;
  rate: number;
  index: number;
}

export const MIN_BID_RATIO = 1;
export const DEFAULT_BID_RATIO = 2;
export const MAX_BID_RATIO = 4;

type CheckoutStep = 'quote' | 'summary' | 'checkout' | 'cashapp' | 'applepay' | 'googlepay' | 'processing' | 'paid' | 'success';

@Component({
  selector: 'app-accelerate-checkout',
  templateUrl: './accelerate-checkout.component.html',
  styleUrls: ['./accelerate-checkout.component.scss']
})
export class AccelerateCheckout implements OnInit, OnDestroy {
  @Input() tx: Transaction;
  @Input() accelerating: boolean = false;
  @Input() miningStats: MiningStats;
  @Input() eta: ETA;
  @Input() scrollEvent: boolean;
  @Input() cashappEnabled: boolean = true;
  @Input() applePayEnabled: boolean = false;
  @Input() googlePayEnabled: boolean = true;
  @Input() advancedEnabled: boolean = false;
  @Input() forceMobile: boolean = false;
  @Input() showDetails: boolean = false;
  @Input() noCTA: boolean = false;
  @Output() unavailable = new EventEmitter<boolean>();
  @Output() completed = new EventEmitter<boolean>();
  @Output() hasDetails = new EventEmitter<boolean>();
  @Output() changeMode = new EventEmitter<boolean>();

  calculating = true;
  processing = false;
  isCheckoutLocked = 0; // reference counter, 0 = unlocked, >0 = locked
  isTokenizing = 0; // reference counter, 0 = false, >0 = true
  selectedOption: 'wait' | 'accel';
  cantPayReason = '';
  quoteError = ''; // error fetching estimate or initial data
  accelerateError = ''; // error executing acceleration
  btcpayInvoiceFailed = false;
  timePaid: number = 0; // time acceleration requested
  math = Math;
  isMobile: boolean = window.innerWidth <= 767.98;
  isProdDomain = false;

  private _step: CheckoutStep = 'summary';
  simpleMode: boolean = true;
  timeoutTimer: any;

  authSubscription$: Subscription;
  auth: IAuth | null = null;

  // accelerator stuff
  accelerationSubscription: Subscription;
  difficultySubscription: Subscription;
  estimateSubscription: Subscription;
  estimate: AccelerationEstimate;
  maxBidBoost: number; // sats
  cost: number; // sats
  etaInfo$: Observable<{ hashratePercentage: number, ETA: number, acceleratedETA: number }>;
  showSuccess = false;
  hasAncestors: boolean = false;
  minExtraCost = 0;
  minBidAllowed = 0;
  maxBidAllowed = 0;
  defaultBid = 0;
  userBid = 0;
  selectFeeRateIndex = 1;
  maxRateOptions: RateOption[] = [];

  // square
  loadingCashapp = false;
  loadingApplePay = false;
  loadingGooglePay = false;
  payments: any;
  cashAppPay: any;
  applePay: any;
  googlePay: any;
  conversionsSubscription: Subscription;
  conversions: Record<string, number>;

  // btcpay
  loadingBtcpayInvoice = false;
  invoice = undefined;

  constructor(
    public stateService: StateService,
    private apiService: ApiService,
    private servicesApiService: ServicesApiServices,
    private etaService: EtaService,
    private audioService: AudioService,
    private cd: ChangeDetectorRef,
    private authService: AuthServiceMempool,
    private enterpriseService: EnterpriseService,
  ) {
    this.isProdDomain = this.stateService.env.PROD_DOMAINS.indexOf(document.location.hostname) > -1;

    // Check if Apple Pay available
    // https://developer.apple.com/documentation/apple_pay_on_the_web/apple_pay_js_api/checking_for_apple_pay_availability#overview
    if (window['ApplePaySession']) {
      this.applePayEnabled = true;
    }
  }

  ngOnInit(): void {
    this.authSubscription$ = this.authService.getAuth$().subscribe((auth) => {
      if (this.auth?.user?.userId !== auth?.user?.userId) {
        this.auth = auth;
        this.estimate = null;
        this.quoteError = null;
        this.accelerateError = null;
        this.timePaid = 0;
        this.btcpayInvoiceFailed = false;
        this.moveToStep('summary', true);
      } else {
        this.auth = auth;
      }
    });
    this.authService.refreshAuth$().subscribe();

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('cash_request_id')) { // Redirected from cashapp
      this.moveToStep('processing', true);
      this.insertSquare();
      this.setupSquare();
    } else {
      this.moveToStep('summary', true);
    }

    this.conversionsSubscription = this.stateService.conversions$.subscribe(
      async (conversions) => {
        this.conversions = conversions;
      }
    );
  }

  ngOnDestroy(): void {
    if (this.estimateSubscription) {
      this.estimateSubscription.unsubscribe();
    }
    if (this.authSubscription$) {
      this.authSubscription$.unsubscribe();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.scrollEvent && this.scrollEvent) {
      this.scrollToElement('acceleratePreviewAnchor', 'start');
    }
    if (changes.accelerating && this.accelerating) {
      if (this.step === 'processing' || this.step === 'paid') {
        this.moveToStep('success', true);
      } else { // Edge case where the transaction gets accelerated by someone else or on another session
        this.closeModal();
      }
    }
  }

  moveToStep(step: CheckoutStep, force: boolean = false): void {
    if (this.isCheckoutLocked > 0 && !force) {
      return;
    }
    this.processing = false;
    this._step = step;
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
    }
    if (!this.estimate && ['quote', 'summary', 'checkout'].includes(this.step)) {
      this.fetchEstimate();
    }
    if (this._step === 'checkout') {
      this.insertSquare();
      this.enterpriseService.goal(8);
    }
    if (this._step === 'checkout' && this.canPayWithBitcoin) {
      this.btcpayInvoiceFailed = false;
      this.invoice = null;
      this.requestBTCPayInvoice();
    } else if (this._step === 'cashapp' && this.cashappEnabled) {
      this.loadingCashapp = true;
      this.setupSquare();
      this.scrollToElementWithTimeout('confirm-title', 'center', 100);
    } else if (this._step === 'applepay' && this.applePayEnabled) {
      this.loadingApplePay = true;
      this.setupSquare();
      this.scrollToElementWithTimeout('confirm-title', 'center', 100);
    } else if (this._step === 'googlepay' && this.googlePayEnabled) {
      this.loadingGooglePay = true;
      this.setupSquare();
      this.scrollToElementWithTimeout('confirm-title', 'center', 100);
    } else if (this._step === 'paid') {
      this.timePaid = Date.now();
      this.timeoutTimer = setTimeout(() => {
        if (this.step === 'paid') {
          this.accelerateError = 'internal_server_error';
        }
      }, 120000);
    }
    this.hasDetails.emit(this._step === 'quote');
  }

  closeModal(): void {
    this.completed.emit(true);
    this.moveToStep('summary', true);
  }

  /**
   * Scroll to element id with or without setTimeout
   */
  scrollToElementWithTimeout(id: string, position: ScrollLogicalPosition, timeout: number = 1000): void {
    setTimeout(() => {
      this.scrollToElement(id, position);
    }, timeout);
  }
  scrollToElement(id: string, position: ScrollLogicalPosition): void {
    const acceleratePreviewAnchor = document.getElementById(id);
    if (acceleratePreviewAnchor) {
      this.cd.markForCheck();
      acceleratePreviewAnchor.scrollIntoView({
        behavior: 'smooth',
        inline: position,
        block: position,
      });
    }
  }

  /**
   * Accelerator
   */
  fetchEstimate(): void {
    if (this.estimateSubscription) {
      this.estimateSubscription.unsubscribe();
    }
    this.calculating = true;
    this.quoteError = null;
    this.accelerateError = null;
    this.estimateSubscription = this.servicesApiService.estimate$(this.tx.txid).pipe(
      tap((response) => {
        if (response.status === 204) {
          this.quoteError = `cannot_accelerate_tx`;
          if (this.step === 'summary') {
            this.unavailable.emit(true);
          }
        } else {
          this.estimate = response.body;
          if (!this.estimate) {
            this.quoteError = `cannot_accelerate_tx`;
            if (this.step === 'summary') {
              this.unavailable.emit(true);
            }
            return;
          }
          if (this.estimate.hasAccess === true && this.estimate.userBalance <= 0) {
            if (this.isLoggedIn()) {
              this.quoteError = `not_enough_balance`;
            }
          }
          if (this.estimate.unavailable) {
            this.quoteError = `temporarily_unavailable`;
          }
          this.hasAncestors = this.estimate.txSummary.ancestorCount > 1;
          this.etaInfo$ = this.etaService.getProjectedEtaObservable(this.estimate, this.miningStats);

          this.maxRateOptions = this.estimate.options.map((option, index) => ({
            fee: option.fee,
            rate: (this.estimate.txSummary.effectiveFee + option.fee) / this.estimate.txSummary.effectiveVsize,
            index
          }));

          this.defaultBid = this.maxRateOptions[1].fee;
          this.userBid = this.defaultBid;
          this.cost = this.userBid + this.estimate.mempoolBaseFee + this.estimate.vsizeFee;

          this.validateChoice();

          if (!this.couldPay) {
            this.quoteError = `cannot_accelerate_tx`;
            if (this.step === 'summary') {
              this.unavailable.emit(true);
            }
            return;
          }

          if (this.step === 'checkout' && this.canPayWithBitcoin && !this.loadingBtcpayInvoice) {
            this.requestBTCPayInvoice();
          }

          this.calculating = false;
          this.cd.markForCheck();
        }
      }),

      catchError(() => {
        this.estimate = undefined;
        this.quoteError = `cannot_accelerate_tx`;
        this.estimateSubscription.unsubscribe();
        if (this.step === 'summary') {
          this.unavailable.emit(true);
        } else {
          this.accelerateError = 'cannot_accelerate_tx';
        }
        return of(null);
      })
    ).subscribe();
  }

  validateChoice(): void {
    if (!this.canPay) {
      if (this.estimate?.availablePaymentMethods?.balance) {
        if (this.cost >= this.estimate?.userBalance) {
          this.cantPayReason = 'not_enough_balance';
        }
      } else {
        this.cantPayReason = 'cannot_accelerate_tx';
      }
    } else {
      this.cantPayReason = '';
    }
  }

  /**
   * User changed his bid
   */
  setUserBid({ fee, index }: { fee: number, index: number}): void {
    if (this.estimate) {
      this.selectFeeRateIndex = index;
      this.userBid = Math.max(0, fee);
      this.cost = this.userBid + this.estimate.mempoolBaseFee + this.estimate.vsizeFee;
      this.validateChoice();
    }
  }

  /**
   * Account-based acceleration request
   */
  accelerateWithMempoolAccount(): void {
    if (!this.canPay || this.calculating || this.processing) {
      return;
    }
    this.processing = true;
    if (this.accelerationSubscription) {
      this.accelerationSubscription.unsubscribe();
    }
    this.accelerationSubscription = this.servicesApiService.accelerate$(
      this.tx.txid,
      this.userBid,
    ).subscribe({
      next: () => {
        this.processing = false;
        this.apiService.logAccelerationRequest$(this.tx.txid).subscribe();
        this.audioService.playSound('ascend-chime-cartoon');
        this.showSuccess = true;
        this.estimateSubscription.unsubscribe();
        this.moveToStep('paid', true);
      },
      error: (response) => {
        this.processing = false;
        this.accelerateError = response.error;
      }
    });
  }

  /**
   * Square
   */
  insertSquare(): void {
    if (!this.isProdDomain && !isDevMode()) {
      return;
    }
    if (window['Square']) {
      return;
    }
    let statsUrl = 'https://sandbox.web.squarecdn.com/v1/square.js';
    if (this.isProdDomain) {
      statsUrl = '/square/v1/square.js';
    }

    (function(): void {
      const d=document, g=d.createElement('script'), s=d.getElementsByTagName('script')[0];
      g.type='text/javascript'; g.src=statsUrl; s.parentNode.insertBefore(g, s);
    })();
  }
  setupSquare(): void {
    if (!this.isProdDomain && !isDevMode()) {
      return;
    }
    const init = (): void => {
      this.initSquare();
    };

    if (!window['Square']) {
      console.debug('Square.js failed to load properly. Retrying.');
      setTimeout(this.setupSquare.bind(this), 100);
    } else {
      init();
    }
  }
  async initSquare(): Promise<void> {
    try {
      this.servicesApiService.setupSquare$().subscribe({
        next: async (ids) => {
          this.payments = window['Square'].payments(ids.squareAppId, ids.squareLocationId);
          const urlParams = new URLSearchParams(window.location.search);
          if (this._step === 'cashapp' || urlParams.get('cash_request_id')) {
            await this.requestCashAppPayment();
          } else if (this._step === 'applepay') {
            await this.requestApplePayPayment();
          } else if (this._step === 'googlepay') {
            await this.requestGooglePayPayment();
          }
        },
        error: () => {
          console.debug('Error loading Square Payments');
          this.accelerateError = 'cannot_setup_square';
        }
      });
    } catch (e) {
      console.debug('Error loading Square Payments', e);
      this.accelerateError = 'cannot_setup_square';
    }
  }

  /**
   * APPLE PAY
   */
  async requestApplePayPayment(): Promise<void> {
    if (this.processing) {
      return;
    }
    if (this.conversionsSubscription) {
      this.conversionsSubscription.unsubscribe();
    }

    this.processing = true;
    this.conversionsSubscription = this.stateService.conversions$.subscribe(
      async (conversions) => {
        this.conversions = conversions;
        if (this.applePay) {
          this.applePay.destroy();
        }

        const costUSD = this.cost / 100_000_000 * conversions.USD;
        const paymentRequest = this.payments.paymentRequest({
          countryCode: 'US',
          currencyCode: 'USD',
          total: {
            amount: costUSD.toFixed(2),
            label: 'Total',
          },
        });

        try {
          this.applePay = await this.payments.applePay(paymentRequest);
          const applePayButton = document.getElementById('apple-pay-button');
          if (!applePayButton) {
            console.error(`Unable to find apple pay button id='apple-pay-button'`);
            // Try again
            setTimeout(this.requestApplePayPayment.bind(this), 500);
            this.processing = false;
            return;
          }
          this.loadingApplePay = false;
          applePayButton.addEventListener('click', async event => {
            if (this.isCheckoutLocked > 0 || this.isTokenizing > 0) {
              return;
            }
            event.preventDefault();
            try {
              // lock the checkout UI and show a loading spinner until the square modals are finished
              this.isCheckoutLocked++;
              this.isTokenizing++;
              const tokenResult = await this.applePay.tokenize();
              if (tokenResult?.status === 'OK') {
                const card = tokenResult.details?.card;
                if (!card || !card.brand || !card.expMonth || !card.expYear || !card.last4) {
                  console.error(`Cannot retreive payment card details`);
                  this.accelerateError = 'apple_pay_no_card_details';
                  this.processing = false;
                  return;
                }
                const cardTag = md5(`${card.brand}${card.expMonth}${card.expYear}${card.last4}`.toLowerCase());
                // keep checkout in loading state until the acceleration request completes
                this.isTokenizing++;
                this.isCheckoutLocked++;
                this.servicesApiService.accelerateWithApplePay$(
                  this.tx.txid,
                  tokenResult.token,
                  cardTag,
                  `accelerator-${this.tx.txid.substring(0, 15)}-${Math.round(new Date().getTime() / 1000)}`,
                  costUSD
                ).subscribe({
                  next: () => {
                    this.processing = false;
                    this.apiService.logAccelerationRequest$(this.tx.txid).subscribe();
                    this.audioService.playSound('ascend-chime-cartoon');
                    if (this.applePay) {
                      this.applePay.destroy();
                    }
                    setTimeout(() => {
                      this.isTokenizing--;
                      this.isCheckoutLocked--;
                      this.moveToStep('paid', true);
                    }, 1000);
                  },
                  error: (response) => {
                    this.processing = false;
                    this.accelerateError = response.error;
                    if (!(response.status === 403 && response.error === 'not_available')) {
                      setTimeout(() => {
                        this.isTokenizing--;
                        this.isCheckoutLocked--;
                        // Reset everything by reloading the page :D, can be improved
                        const urlParams = new URLSearchParams(window.location.search);
                        window.location.assign(window.location.toString().replace(`?cash_request_id=${urlParams.get('cash_request_id')}`, ``));
                      }, 3000);
                    }
                  }
                });
              } else {
                this.processing = false;
                let errorMessage = `Tokenization failed with status: ${tokenResult.status}`;
                if (tokenResult.errors) {
                  errorMessage += ` and errors: ${JSON.stringify(
                    tokenResult.errors,
                  )}`;
                }
                throw new Error(errorMessage);
              }
            } finally {
              // always unlock the checkout once we're finished
              this.isTokenizing--;
              this.isCheckoutLocked--;
            }
          });
        } catch (e) {
          this.processing = false;
          console.error(e);
        }
      }
    );
  }

  /**
   * GOOGLE PAY
   */
  async requestGooglePayPayment(): Promise<void> {
    if (this.processing) {
      return;
    }
    if (this.conversionsSubscription) {
      this.conversionsSubscription.unsubscribe();
    }
    
    this.processing = true;
    this.conversionsSubscription = this.stateService.conversions$.subscribe(
      async (conversions) => {
        this.conversions = conversions;
        if (this.googlePay) {
          this.googlePay.destroy();
        }

        const costUSD = this.cost / 100_000_000 * conversions.USD;
        const paymentRequest = this.payments.paymentRequest({
          countryCode: 'US',
          currencyCode: 'USD',
          total: {
            amount: costUSD.toFixed(2),
            label: 'Total'
          }
        });
        this.googlePay = await this.payments.googlePay(paymentRequest , {
          referenceId: `accelerator-${this.tx.txid.substring(0, 15)}-${Math.round(new Date().getTime() / 1000)}`,
        });

        await this.googlePay.attach(`#google-pay-button`, {
          buttonType: 'pay',
          buttonSizeMode: 'fill',
        });
        this.loadingGooglePay = false;

        document.getElementById('google-pay-button').addEventListener('click', async event => {
          if (this.isCheckoutLocked > 0 || this.isTokenizing > 0) {
            return;
          }
          event.preventDefault();
          try {
            // lock the checkout UI and show a loading spinner until the square modals are finished
            this.isCheckoutLocked++;
            this.isTokenizing++;
            const tokenResult = await this.googlePay.tokenize();
            if (tokenResult?.status === 'OK') {
              const card = tokenResult.details?.card;
              if (!card || !card.brand || !card.expMonth || !card.expYear || !card.last4) {
                console.error(`Cannot retreive payment card details`);
                this.accelerateError = 'apple_pay_no_card_details';
                this.processing = false;
                return;
              }
              const verificationToken = await this.$verifyBuyer(this.payments, tokenResult.token, tokenResult.details, costUSD.toFixed(2));
              if (!verificationToken || !verificationToken.token) {
                console.error(`SCA verification failed`);
                this.accelerateError = 'SCA Verification Failed. Payment Declined.';
                this.processing = false;
                return;
              }
              const cardTag = md5(`${card.brand}${card.expMonth}${card.expYear}${card.last4}`.toLowerCase());
              // keep checkout in loading state until the acceleration request completes
              this.isCheckoutLocked++;
              this.isTokenizing++;
              this.servicesApiService.accelerateWithGooglePay$(
                this.tx.txid,
                tokenResult.token,
                verificationToken.token,
                cardTag,
                `accelerator-${this.tx.txid.substring(0, 15)}-${Math.round(new Date().getTime() / 1000)}`,
                costUSD,
                verificationToken.userChallenged
              ).subscribe({
                next: () => {
                  this.processing = false;
                  this.apiService.logAccelerationRequest$(this.tx.txid).subscribe();
                  this.audioService.playSound('ascend-chime-cartoon');
                  if (this.googlePay) {
                    this.googlePay.destroy();
                  }
                  setTimeout(() => {
                    this.isTokenizing--;
                    this.isCheckoutLocked--;
                    this.moveToStep('paid', true);
                  }, 1000);
                },
                error: (response) => {
                  this.processing = false;
                  this.accelerateError = response.error;
                  this.isTokenizing--;
                  this.isCheckoutLocked--;
                  if (!(response.status === 403 && response.error === 'not_available')) {
                    setTimeout(() => {
                      // Reset everything by reloading the page :D, can be improved
                      const urlParams = new URLSearchParams(window.location.search);
                      window.location.assign(window.location.toString().replace(`?cash_request_id=${urlParams.get('cash_request_id')}`, ``));
                    }, 3000);
                  }
                }
              });
            } else {
              this.processing = false;
              let errorMessage = `Tokenization failed with status: ${tokenResult.status}`;
              if (tokenResult.errors) {
                errorMessage += ` and errors: ${JSON.stringify(
                  tokenResult.errors,
                )}`;
              }
              throw new Error(errorMessage);
            }
          } finally {
            // always unlock the checkout once we're finished
            this.isTokenizing--;
            this.isCheckoutLocked--;
          }
        });
      }
    );
  }

  /**
   * CASHAPP
   */
  async requestCashAppPayment(): Promise<void> {
    if (this.processing) {
      return;
    }
    if (this.conversionsSubscription) {
      this.conversionsSubscription.unsubscribe();
    }

    this.processing = true;
    this.conversionsSubscription = this.stateService.conversions$.subscribe(
      async (conversions) => {
        this.conversions = conversions;
        if (this.cashAppPay) {
          this.cashAppPay.destroy();
        }

        const redirectHostname = document.location.hostname === 'localhost' ? `http://localhost:4200`: `https://${document.location.hostname}`;
        const costUSD = this.step === 'processing' ? 69.69 : (this.cost / 100_000_000 * conversions.USD); // When we're redirected to this component, the payment data is already linked to the payment token, so does not matter what amonut we put in there, therefore it's 69.69
        const paymentRequest = this.payments.paymentRequest({
          countryCode: 'US',
          currencyCode: 'USD',
          total: {
            amount: costUSD.toFixed(2),
            label: 'Total',
            pending: true,
            productUrl: `${redirectHostname}/tx/${this.tx.txid}`,
          }
        });
        this.cashAppPay = await this.payments.cashAppPay(paymentRequest, {
          redirectURL: `${redirectHostname}/tx/${this.tx.txid}`,
          referenceId: `accelerator-${this.tx.txid.substring(0, 15)}-${Math.round(new Date().getTime() / 1000)}`
        });

        await this.cashAppPay.attach(`#cash-app-pay`, { theme: 'dark' });
        this.loadingCashapp = false;

        this.cashAppPay.addEventListener('ontokenization', event => {
          const { tokenResult, error } = event.detail;
          if (error) {
            this.processing = false;
            this.accelerateError = error;
          } else if (tokenResult.status === 'OK') {
            this.servicesApiService.accelerateWithCashApp$(
              this.tx.txid,
              tokenResult.token,
              tokenResult.details.cashAppPay.cashtag,
              tokenResult.details.cashAppPay.referenceId,
              costUSD
            ).subscribe({
              next: () => {
                this.processing = false;
                this.apiService.logAccelerationRequest$(this.tx.txid).subscribe();
                this.audioService.playSound('ascend-chime-cartoon');
                if (this.cashAppPay) {
                  this.cashAppPay.destroy();
                }
                setTimeout(() => {
                  this.moveToStep('paid', true);
                  if (window.history.replaceState) {
                    const urlParams = new URLSearchParams(window.location.search);
                    window.history.replaceState(null, null, window.location.toString().replace(`?cash_request_id=${urlParams.get('cash_request_id')}`, ''));
                  }
                }, 1000);
              },
              error: (response) => {
                this.processing = false;
                this.accelerateError = response.error;
                if (!(response.status === 403 && response.error === 'not_available')) {
                  setTimeout(() => {
                    // Reset everything by reloading the page :D, can be improved
                    const urlParams = new URLSearchParams(window.location.search);
                    window.location.assign(window.location.toString().replace(`?cash_request_id=${urlParams.get('cash_request_id')}`, ``));
                  }, 3000);
                }
              }
            });
          }
        });
      }
    );
  }

  /**
   * https://developer.squareup.com/docs/sca-overview
   */
  async $verifyBuyer(payments, token, details, amount): Promise<{token: string, userChallenged: boolean}> {
    const verificationDetails = {
      amount: amount,
      currencyCode: 'USD',
      intent: 'CHARGE',
      billingContact: {
        givenName: details.card?.billing?.givenName,
        familyName: details.card?.billing?.familyName,
        phone: details.card?.billing?.phone,
        addressLines: details.card?.billing?.addressLines,
        city: details.card?.billing?.city,
        state: details.card?.billing?.state,
        countryCode: details.card?.billing?.countryCode,
      },
    };

    const verificationResults = await payments.verifyBuyer(
      token,
      verificationDetails,
    );
    return verificationResults;
  }

  /**
   * BTCPay
   */
  async requestBTCPayInvoice(): Promise<void> {
    this.loadingBtcpayInvoice = true;
    this.servicesApiService.generateBTCPayAcceleratorInvoice$(this.tx.txid, this.userBid).pipe(
      switchMap(response => {
        return this.servicesApiService.retreiveInvoice$(response.btcpayInvoiceId);
      }),
      catchError(error => {
        console.log(error);
        this.loadingBtcpayInvoice = false;
        this.btcpayInvoiceFailed = true;
        return of(null);
      })
    ).subscribe((invoice) => {
        this.loadingBtcpayInvoice = false;
        this.invoice = invoice;
        this.cd.markForCheck();
    });
  }

  bitcoinPaymentCompleted(): void {
    this.apiService.logAccelerationRequest$(this.tx.txid).subscribe();
    this.audioService.playSound('ascend-chime-cartoon');
    this.estimateSubscription.unsubscribe();
    this.moveToStep('paid', true);
  }

  isLoggedIn(): boolean {
    return this.auth !== null;
  }

  /**
   * UI events
   */
  selectedOptionChanged(event): void {
    this.selectedOption = event.target.id;
  }

  get step(): CheckoutStep {
    return this._step;
  }

  get paymentMethods(): PaymentMethod[] {
    return Object.keys(this.estimate?.availablePaymentMethods || {}) as PaymentMethod[];
  }

  get couldPayWithBitcoin(): boolean {
    return !!this.estimate?.availablePaymentMethods?.bitcoin;
  }

  get couldPayWithCashapp(): boolean {
    if (!this.cashappEnabled) {
      return false;
    }
    return !!this.estimate?.availablePaymentMethods?.cashapp;
  }

  get couldPayWithApplePay(): boolean {
    if (!this.applePayEnabled) {
      return false;
    }
    return !!this.estimate?.availablePaymentMethods?.applePay;
  }

  get couldPayWithGooglePay(): boolean {
    if (!this.googlePayEnabled) {
      return false;
    }
    return !!this.estimate?.availablePaymentMethods?.googlePay;
  }

  get couldPayWithBalance(): boolean {
    if (!this.hasAccessToBalanceMode) {
      return false;
    }
    return !!this.estimate?.availablePaymentMethods?.balance;
  }

  get couldPay(): boolean {
    return this.couldPayWithBalance || this.couldPayWithBitcoin || this.couldPayWithCashapp || this.couldPayWithApplePay || this.couldPayWithGooglePay;
  }

  get canPayWithBitcoin(): boolean {
    const paymentMethod = this.estimate?.availablePaymentMethods?.bitcoin;
    return paymentMethod && this.cost >= paymentMethod.min && this.cost <= paymentMethod.max;
  }

  get canPayWithCashapp(): boolean {
    if (!this.cashappEnabled || !this.conversions || (!this.isProdDomain && !isDevMode())) {
      return false;
    }

    const paymentMethod = this.estimate?.availablePaymentMethods?.cashapp;
    if (paymentMethod) {
      const costUSD = (this.cost / 100_000_000 * this.conversions.USD);
      if (costUSD >= paymentMethod.min && costUSD <= paymentMethod.max) {
        return true;
      }
    }

    return false;
  }

  get canPayWithApplePay(): boolean {
    if (!this.applePayEnabled || !this.conversions || (!this.isProdDomain && !isDevMode())) {
      return false;
    }

    const paymentMethod = this.estimate?.availablePaymentMethods?.applePay;
    if (paymentMethod) {
      const costUSD = (this.cost / 100_000_000 * this.conversions.USD);
      if (costUSD >= paymentMethod.min && costUSD <= paymentMethod.max) {
        return true;
      }
    }

    return false;
  }

  get canPayWithGooglePay(): boolean {
    if (!this.googlePayEnabled || !this.conversions || (!this.isProdDomain && !isDevMode())) {
      return false;
    }

    const paymentMethod = this.estimate?.availablePaymentMethods?.googlePay;
    if (paymentMethod) {
      const costUSD = (this.cost / 100_000_000 * this.conversions.USD);
      if (costUSD >= paymentMethod.min && costUSD <= paymentMethod.max) {
        return true;
      }
    }

    return false;
  }

  get canPayWithBalance(): boolean {
    if (!this.hasAccessToBalanceMode) {
      return false;
    }
    const paymentMethod = this.estimate?.availablePaymentMethods?.balance;
    return paymentMethod && this.cost >= paymentMethod.min && this.cost <= paymentMethod.max && this.cost <= this.estimate?.userBalance;
  }

  get canPay(): boolean {
    return this.canPayWithBalance || this.canPayWithBitcoin || this.canPayWithCashapp || this.canPayWithApplePay || this.canPayWithGooglePay;
  }

  get hasAccessToBalanceMode(): boolean {
    return this.isLoggedIn() && this.estimate?.hasAccess;
  }

  get timeSincePaid(): number {
    return Date.now() - this.timePaid;
  }

  @HostListener('window:resize', ['$event'])
  onResize(): void {
    this.isMobile = window.innerWidth <= 767.98;
  }
}
