import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges } from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { Subscription, of, catchError } from 'rxjs';
import { retry, tap } from 'rxjs/operators';
import { ServicesApiServices } from '@app/services/services-api.service';

@Component({
  selector: 'app-bitcoin-invoice',
  templateUrl: './bitcoin-invoice.component.html',
  styleUrls: ['./bitcoin-invoice.component.scss']
})
export class BitcoinInvoiceComponent implements OnInit, OnChanges, OnDestroy {
  @Input() invoice;
  @Input() redirect = true;
  @Input() minimal = false;
  @Output() completed = new EventEmitter();

  paymentForm: FormGroup;
  paymentStatusSubscription: Subscription | undefined;
  paymentStatus = 1; // 1 - Waiting for invoice | 2 - Pending payment | 3 - Payment completed
  paymentErrorMessage: string = '';

  constructor(
    private formBuilder: FormBuilder,
    private apiService: ServicesApiServices,
    private sanitizer: DomSanitizer
  ) { }

  ngOnDestroy() {
    if (this.paymentStatusSubscription) {
      this.paymentStatusSubscription.unsubscribe();
    }
  }

  ngOnInit(): void {
    this.paymentForm = this.formBuilder.group({
      'method': 'lightning'
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.invoice) {
      this.watchInvoice();
    }
  }

  watchInvoice(): void {
    if (this.paymentStatusSubscription) {
      this.paymentStatusSubscription.unsubscribe();
    }
    if (!this.invoice) {
      this.paymentStatus = 1;
      return;
    }
    if (this.invoice.btcDue > 0) {
      this.paymentStatus = 2;
    } else {
      this.paymentStatus = 4;
    }

    this.monitorPendingInvoice();
  }

  monitorPendingInvoice(): void {
    if (!this.invoice) {
      return;
    }
    if (this.paymentStatusSubscription) {
      this.paymentStatusSubscription.unsubscribe();
    }
    this.paymentStatusSubscription = this.apiService.getPaymentStatus$(this.invoice.btcpayInvoiceId).pipe(
      tap(result => {
        if (result.status === 204) { // Manually trigger an error in that case so we can retry
          throw result;
        } else if (result.status === 200) { // Invoice settled
          this.paymentStatus = 3;
          this.completed.emit();
        }
      }),
      catchError(err => {
        if (err.status === 204 || err.status === 504) {
          throw err; // Will trigger the retry
        } else if (err.status === 400) {
          this.paymentErrorMessage = 'Invoice has expired';
        } else if (err.status === 404) {
          this.paymentErrorMessage = 'Invoice is no longer valid';
        }
        this.paymentStatus = -1;
        return of(null);
      }),
      retry({ delay: 1000 }),
    ).subscribe();
  }

  get availableMethods(): string[] {
    return Object.keys(this.invoice?.addresses || {}).filter(k => k === 'BTC_LightningLike');
  }

  bypassSecurityTrustUrl(text: string): SafeUrl {
    return this.sanitizer.bypassSecurityTrustUrl(text);
  }
}
