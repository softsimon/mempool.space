import { Component, EmbeddedViewRef, Input, OnInit, TemplateRef, ViewChild } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

export const MempoolErrors = {
  'bad_request': `Your request was not valid. Please try again.`,
  'internal_server_error': `Something went wrong, please try again later`,
  'temporarily_unavailable': `Acceleration temporarily unavailable`,
  'acceleration_duplicated': `This transaction has already been accelerated.`,
  'acceleration_outbid': `Your fee delta is too low.`,
  'cannot_accelerate_tx': `Cannot accelerate this transaction.`,
  'cannot_decode_raw_tx': `Cannot decode this raw transaction.`,
  'cannot_fetch_raw_tx': `Cannot find this transaction.`,
  'high_sigop_tx': `This transaction cannot be accelerated.`,
  'invalid_acceleration_request': `This acceleration request is not valid.`,
  'invalid_tx_dependencies': `This transaction dependencies are not valid.`,
  'mempool_rejected_raw_tx': `Our mempool rejected this transaction`,
  'no_mining_pool_available': `No mining pool available at the moment`,
  'not_available': `You current subscription does not allow you to access this feature.`,
  'not_enough_balance': ``,
  'not_verified': `You must verify your account to use this feature.`,
  'recommended_fees_not_available': `Recommended fees are not available right now.`,
  'too_many_relatives': `This transaction has too many relatives.`,
  'txid_not_in_mempool': `This transaction is not in the mempool.`,
  'waitlisted': `You are currently on the wait list. You will get notified once you are granted access.`,  
  'not_whitelisted_by_any_pool': `You are not whitelisted by any mining pool`,
  'unauthorized': `You are not authorized to do this`,
  'faucet_too_soon': `You cannot request any more coins right now. Try again later.`,
  'faucet_not_available': `The faucet is not available right now. Try again later.`,
  'faucet_not_available_no_utxo': `The faucet is not available right now. Please try again once a new block has been mined.`,
  'faucet_maximum_reached': `You are not allowed to request more coins`,
  'faucet_address_not_allowed': `You cannot use this address`,
  'faucet_below_minimum': `Requested amount is too small`,
  'faucet_above_maximum': `Requested amount is too high`,
  'payment_method_not_allowed': `You are not allowed to use this payment method`,
  'payment_method_not_allowed_out_of_bound': `You are not allowed to use this payment method with this amount`,
} as { [error: string]: string };

export function isMempoolError(error: string) {
  return Object.keys(MempoolErrors).includes(error);
}

@Component({
  selector: 'app-mempool-error',
  templateUrl: './mempool-error.component.html'
})
export class MempoolErrorComponent implements OnInit {
  @ViewChild('lowBalance', { static: true }) lowBalance!: TemplateRef<any>;
  @Input() error: string;
  @Input() alertClass = 'alert-danger';
  @Input() textOnly = false;
  errorContent: SafeHtml;

  constructor(
    private sanitizer: DomSanitizer,
  ) { }

  ngOnInit(): void {
     // Special hack for the i18n string with a href link inside
     const embeddedViewRef: EmbeddedViewRef<any> = this.lowBalance.createEmbeddedView({});
     embeddedViewRef.detectChanges();
     const rawHtml = embeddedViewRef.rootNodes.map((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        return node.outerHTML;
      }
      return '';
    }).join('');
     MempoolErrors['not_enough_balance'] = rawHtml;
     if (Object.keys(MempoolErrors).includes(this.error)) {
      this.errorContent = this.sanitizer.bypassSecurityTrustHtml(MempoolErrors[this.error]);
    } else {
      this.errorContent = this.error;
    }
  }
}
