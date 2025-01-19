import { Component, OnDestroy, OnInit, ChangeDetectorRef } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ValidatorFn, AbstractControl, ValidationErrors } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ServicesApiServices } from '@app/services/services-api.service';
import { getRegex } from '@app/shared/regex.utils';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { AudioService } from '@app/services/audio.service';
import { HttpErrorResponse } from '@angular/common/http';

@Component({
  selector: 'app-faucet',
  templateUrl: './faucet.component.html',
  styleUrls: ['./faucet.component.scss']
})
export class FaucetComponent implements OnInit, OnDestroy {
  loading = true;
  error: string = '';
  user: any = undefined;
  txid: string = '';

  faucetStatusSubscription: Subscription;
  status: {
    min: number; // minimum amount to request at once (in sats)
    max: number; // maximum amount to request at once
    address?: string; // faucet address
    code: 'ok' | 'faucet_not_available' | 'faucet_maximum_reached' | 'faucet_too_soon' | 'faucet_not_available_no_utxo';
  } | null = null;
  faucetForm: FormGroup;

  mempoolPositionSubscription: Subscription;
  confirmationSubscription: Subscription;

  constructor(
    private cd: ChangeDetectorRef,
    private servicesApiService: ServicesApiServices,
    private formBuilder: FormBuilder,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private audioService: AudioService
  ) {
    this.initForm(5000, 500_000, null);
  }

  ngOnDestroy() {
    this.stateService.markBlock$.next({});
    this.websocketService.stopTrackingTransaction();
    if (this.mempoolPositionSubscription) {
      this.mempoolPositionSubscription.unsubscribe();
    }
    if (this.confirmationSubscription) {
      this.confirmationSubscription.unsubscribe();
    }
  }

  ngOnInit() {
    this.servicesApiService.userSubject$.subscribe(user => {
      this.user = user;
      if (!user) {
        this.loading = false;
        this.cd.markForCheck();
        return;
      }
      // Setup form
      this.updateFaucetStatus();
      this.cd.markForCheck();
    });

    // Track transaction
    this.websocketService.want(['blocks', 'mempool-blocks']);
    this.mempoolPositionSubscription = this.stateService.mempoolTxPosition$.subscribe(txPosition => {
      if (txPosition && txPosition.txid === this.txid) {
        this.stateService.markBlock$.next({
          txid: txPosition.txid,
          mempoolPosition: txPosition.position,
        });
      }
    });

    this.confirmationSubscription = this.stateService.txConfirmed$.subscribe(([txConfirmed, block]) => {
      if (txConfirmed && txConfirmed === this.txid) {
        this.stateService.markBlock$.next({ blockHeight: block.height });
      }
    });
  }

  updateFaucetStatus(): void {
    this.servicesApiService.getFaucetStatus$().subscribe({
      next: (status) => {
        if (!status) {
          this.error = 'internal_server_error';
          return;
        }
        this.status = status;
        if (this.status.code !== 'ok') {
          this.error = this.status.code;
          this.updateForm(this.status.min ?? 5000, this.status.max ?? 500_000, this.status.address);
          return;
        }
        // update the form with the proper validation parameters
        this.updateForm(this.status.min, this.status.max, this.status.address);
      },
      error: (response) => {
        this.loading = false;
        this.error = response.error;
        this.cd.markForCheck();
      }
    });
  }

  requestCoins(): void {
    if (this.isDisabled()) {
      return;
    }
    this.error = null;
    this.txid = '';
    this.stateService.markBlock$.next({});
    this.servicesApiService.requestTestnet4Coins$(this.faucetForm.get('address')?.value, parseInt(this.faucetForm.get('satoshis')?.value))
    .subscribe({
      next: ((response) => {
        this.txid = response.txid;
        this.websocketService.startTrackTransaction(this.txid);
        this.audioService.playSound('cha-ching');
        this.updateFaucetStatus();
        this.cd.markForCheck();
      }),
      error: (response: HttpErrorResponse) => {
        this.error = response.error;
      },
    });
  }

  isDisabled(): boolean {
    return !(this.user && this.status?.code === 'ok' && !this.error);
  }

  getNotFaucetAddressValidator(faucetAddress: string): ValidatorFn {
    return faucetAddress ? (control: AbstractControl): ValidationErrors | null => {
      const forbidden = control.value === faucetAddress;
      return forbidden ? { forbiddenAddress: { value: control.value } } : null;
    }: () => null;
  }

  initForm(min: number, max: number, faucetAddress: string): void {
    this.faucetForm = this.formBuilder.group({
      'address': ['', [Validators.required, Validators.pattern(getRegex('address', 'testnet4')), this.getNotFaucetAddressValidator(faucetAddress)]],
      'satoshis': [min, [Validators.required, Validators.min(min), Validators.max(max)]]
    });
  }

  updateForm(min, max, faucetAddress: string): void {
    if (!this.faucetForm) {
      this.initForm(min, max, faucetAddress);
    } else {
      this.faucetForm.get('address').setValidators([Validators.required, Validators.pattern(getRegex('address', 'testnet4')), this.getNotFaucetAddressValidator(faucetAddress)]);
      this.faucetForm.get('satoshis').setValidators([Validators.required, Validators.min(min), Validators.max(max)]);
      this.faucetForm.get('satoshis').setValue(Math.max(min, this.faucetForm.get('satoshis').value));
      this.faucetForm.get('satoshis').updateValueAndValidity();
      this.faucetForm.get('satoshis').markAsDirty();
    }
    this.loading = false;
    this.cd.markForCheck();
  }

  setAmount(value: number): void {
    if (this.faucetForm) {
      this.faucetForm.get('satoshis').setValue(value);
      this.faucetForm.get('satoshis').updateValueAndValidity();
      this.faucetForm.get('satoshis').markAsDirty();
    }
  }

  get amount() { return this.faucetForm.get('satoshis')!; }
  get invalidAmount() {
    const amount = this.faucetForm.get('satoshis')!;
    return amount?.invalid && (amount.dirty || amount.touched)
  }

  get address() { return this.faucetForm.get('address')!; }
  get invalidAddress() {
    const address = this.faucetForm.get('address')!;
    return address?.invalid && (address.dirty || address.touched)
  }
}
