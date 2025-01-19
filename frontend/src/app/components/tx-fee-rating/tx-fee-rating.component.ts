import { Component, ChangeDetectionStrategy, OnChanges, Input, OnInit, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { Transaction } from '@interfaces/electrs.interface';
import { StateService } from '@app/services/state.service';
import { Subscription } from 'rxjs';
import { BlockExtended } from '@interfaces/node-api.interface';
import { CacheService } from '@app/services/cache.service';

@Component({
  selector: 'app-tx-fee-rating',
  templateUrl: './tx-fee-rating.component.html',
  styleUrls: ['./tx-fee-rating.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TxFeeRatingComponent implements OnInit, OnChanges, OnDestroy {
  @Input() tx: Transaction;

  blocksSubscription: Subscription;

  medianFeeNeeded: number;
  overpaidTimes: number;
  feeRating: number;

  blocks: BlockExtended[] = [];

  constructor(
    private stateService: StateService,
    private cacheService: CacheService,
    private cd: ChangeDetectorRef,
  ) { }

  ngOnInit() {
    this.blocksSubscription = this.cacheService.loadedBlocks$.subscribe((block) => {
      if (this.tx.status.confirmed && this.tx.status.block_height === block.height && (block?.extras?.effectiveMedianFee ?? block?.extras?.medianFee) > 0) {
        this.calculateRatings(block);
        this.cd.markForCheck();
      }
    });
  }

  ngOnChanges() {
    this.feeRating = undefined;
    if (!this.tx.status.confirmed) {
      return;
    }
    this.cacheService.loadBlock(this.tx.status.block_height);

    const foundBlock = this.cacheService.getCachedBlock(this.tx.status.block_height) || null;
    if (foundBlock && (foundBlock?.extras?.effectiveMedianFee ?? foundBlock?.extras?.medianFee) > 0) {
      this.calculateRatings(foundBlock);
    }
  }

  ngOnDestroy() {
    this.blocksSubscription.unsubscribe();
  }

  calculateRatings(block: BlockExtended) {
    const feePervByte = this.tx.effectiveFeePerVsize || this.tx.fee / (this.tx.weight / 4);
    this.medianFeeNeeded = block?.extras?.effectiveMedianFee ?? block?.extras?.medianFee;

    // Block not filled
    if (block.weight < this.stateService.env.BLOCK_WEIGHT_UNITS * 0.95) {
      this.medianFeeNeeded = 1;
    }

    this.overpaidTimes = Math.round(feePervByte / this.medianFeeNeeded);

    if (feePervByte <= this.medianFeeNeeded || this.overpaidTimes < 2) {
      this.feeRating = 1;
    } else {
      this.feeRating = 2;
      if (this.overpaidTimes > 10) {
        this.feeRating = 3;
      }
    }
  }
}
