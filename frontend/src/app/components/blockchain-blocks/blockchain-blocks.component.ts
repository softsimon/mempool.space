import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef, Input, OnChanges, SimpleChanges } from '@angular/core';
import { Observable, Subscription, delay, filter, tap } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { specialBlocks } from '@app/app.constants';
import { BlockExtended } from '@interfaces/node-api.interface';
import { Location } from '@angular/common';
import { CacheService } from '@app/services/cache.service';

interface BlockchainBlock extends BlockExtended {
  placeholder?: boolean;
  loading?: boolean;
}

@Component({
  selector: 'app-blockchain-blocks',
  templateUrl: './blockchain-blocks.component.html',
  styleUrls: ['./blockchain-blocks.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BlockchainBlocksComponent implements OnInit, OnChanges, OnDestroy {
  @Input() static: boolean = false;
  @Input() offset: number = 0;
  @Input() height: number = 0; // max height of blocks in chunk (dynamic blocks only)
  @Input() count: number = 8; // number of blocks in this chunk (dynamic blocks only)
  @Input() loadingTip: boolean = false;
  @Input() connected: boolean = true;
  @Input() minimal: boolean = false;
  @Input() blockWidth: number = 125;
  @Input() spotlight: number = 0;
  @Input() showPools: boolean = true;
  @Input() getHref?: (index, block) => string = (index, block) => `/block/${block.id}`;
  
  specialBlocks = specialBlocks;
  network = '';
  blocks: BlockchainBlock[] = [];
  dynamicBlocksAmount: number = 8;
  emptyBlocks: BlockExtended[] = this.mountEmptyBlocks();
  markHeight: number;
  chainTip: number;
  pendingMarkBlock: { animate: boolean, newBlockFromLeft: boolean };
  blocksSubscription: Subscription;
  blockPageSubscription: Subscription;
  networkSubscription: Subscription;
  tabHiddenSubscription: Subscription;
  markBlockSubscription: Subscription;
  txConfirmedSubscription: Subscription;
  loadingBlocks$: Observable<boolean>;
  showMiningInfoSubscription: Subscription;
  blockDisplayModeSubscription: Subscription;
  blockDisplayMode: 'size' | 'fees';
  blockTransformation = {};
  blockStyles = [];
  emptyBlockStyles = [];
  interval: any;
  tabHidden = false;
  feeRounding = '1.0-0';
  arrowVisible = false;
  arrowLeftPx = 30;
  blocksFilled = false;
  arrowTransition = '1s';
  timeLtrSubscription: Subscription;
  timeLtr: boolean;

  blockOffset: number = 155;
  dividerBlockOffset: number = 205;
  blockPadding: number = 30;

  gradientColors = {
    '': ['var(--mainnet-alt)', 'var(--primary)'],
    liquid: ['var(--liquid)', 'var(--testnet-alt)'],
    'liquidtestnet': ['var(--liquidtestnet)', 'var(--liquidtestnet-alt)'],
    testnet: ['var(--testnet)', 'var(--testnet-alt)'],
    testnet4: ['var(--testnet)', 'var(--testnet-alt)'],
    signet: ['var(--signet)', 'var(--signet-alt)'],
  };

  constructor(
    public stateService: StateService,
    public cacheService: CacheService,
    private cd: ChangeDetectorRef,
    private location: Location,
  ) {
  }

  ngOnInit() {
    this.dynamicBlocksAmount = Math.min(8, this.stateService.env.KEEP_BLOCKS_AMOUNT);

    this.blockDisplayMode = this.stateService.blockDisplayMode$.value as 'size' | 'fees';
    this.blockDisplayModeSubscription = this.stateService.blockDisplayMode$
    .pipe(
      filter((mode: 'size' | 'fees') => mode !== this.blockDisplayMode),
      tap(() => {
        this.blockTransformation = this.timeLtr ? {
          transform: 'scaleX(-1) rotateX(90deg)',
          transition: 'transform 0.375s'
        } : {
          transform: 'rotateX(90deg)',
          transition: 'transform 0.375s'
        };
      }),
      delay(375),
      tap((mode) => {
        this.blockDisplayMode = mode;
        this.blockTransformation = this.timeLtr ? {
          transform: 'scaleX(-1)',
          transition: 'transform 0.375s'
        } : {
          transition: 'transform 0.375s'
        };
        this.cd.markForCheck();
      }),
      delay(375),
    )
    .subscribe(() => {
      this.blockTransformation = {};
    });

    this.timeLtrSubscription = this.stateService.timeLtr.subscribe((ltr) => {
      this.timeLtr = !!ltr;
      this.cd.markForCheck();
    });

    if (this.stateService.network === 'liquid' || this.stateService.network === 'liquidtestnet') {
      this.feeRounding = '1.0-1';
    }
    this.emptyBlocks.forEach((b) => this.emptyBlockStyles.push(this.getStyleForEmptyBlock(b)));
    this.loadingBlocks$ = this.stateService.isLoadingWebSocket$;
    this.networkSubscription = this.stateService.networkChanged$.subscribe((network) => this.network = network);
    this.tabHiddenSubscription = this.stateService.isTabHidden$.subscribe((tabHidden) => this.tabHidden = tabHidden);
    if (!this.static) {
      this.blocksSubscription = this.stateService.blocks$
        .subscribe((blocks) => {
          if (!blocks?.length) {
            return;
          }
          const latestHeight = blocks[0].height;
          const animate = this.chainTip != null && latestHeight > this.chainTip;

          for (const block of blocks) {
            if (block?.extras) {
              block.extras.minFee = this.getMinBlockFee(block);
              block.extras.maxFee = this.getMaxBlockFee(block);
            }
          }

          this.blocks = blocks;

          this.blockStyles = [];
          if (animate) {
            this.blocks.forEach((b, i) => this.blockStyles.push(this.getStyleForBlock(b, i, i ? -this.blockOffset : -this.dividerBlockOffset)));
            setTimeout(() => {
              this.blockStyles = [];
              this.blocks.forEach((b, i) => this.blockStyles.push(this.getStyleForBlock(b, i)));
              this.cd.markForCheck();
            }, 50);
          } else {
            this.blocks.forEach((b, i) => this.blockStyles.push(this.getStyleForBlock(b, i)));
          }

          this.chainTip = latestHeight;

          if (this.pendingMarkBlock) {
            this.moveArrowToPosition(this.pendingMarkBlock.animate, this.pendingMarkBlock.newBlockFromLeft);
            this.pendingMarkBlock = null;
          }
          this.cd.markForCheck();
        });

      this.txConfirmedSubscription = this.stateService.txConfirmed$.subscribe(([txid, block]) => {
        if (txid) {
          this.markHeight = block.height;
          this.moveArrowToPosition(true, true);
        } else {
          this.moveArrowToPosition(true, false);
        }
      })
    } else {
      this.blockPageSubscription = this.cacheService.loadedBlocks$.subscribe((block) => {
        if (block.height <= this.height && block.height > this.height - this.count) {
          this.onBlockLoaded(block);
        }
      });
    }

    this.markBlockSubscription = this.stateService.markBlock$
      .subscribe((state) => {
        this.markHeight = undefined;
        if (state.blockHeight !== undefined) {
          this.markHeight = state.blockHeight;
        }
        this.moveArrowToPosition(false);
        this.cd.markForCheck();
      });

    if (this.static) {
      this.updateStaticBlocks();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.blockWidth && this.blockWidth) {
      this.blockPadding = 0.24 * this.blockWidth;
      this.blockOffset = this.blockWidth + this.blockPadding;
      this.dividerBlockOffset = this.blockOffset + (0.4 * this.blockWidth);
      this.blockStyles = [];
      this.blocks.forEach((b, i) => this.blockStyles.push(this.getStyleForBlock(b, i)));
    }
    if (this.static) {
      const animateSlide = changes.height && (changes.height.currentValue === changes.height.previousValue + 1);
      this.updateStaticBlocks(animateSlide);
    }
  }

  ngOnDestroy() {
    if (this.blocksSubscription) {
      this.blocksSubscription.unsubscribe();
    }
    if (this.blockPageSubscription) {
      this.blockPageSubscription.unsubscribe();
    }
    if (this.txConfirmedSubscription) {
      this.txConfirmedSubscription.unsubscribe();
    }
    this.networkSubscription.unsubscribe();
    this.tabHiddenSubscription.unsubscribe();
    this.markBlockSubscription.unsubscribe();
    this.blockDisplayModeSubscription.unsubscribe();
    this.timeLtrSubscription.unsubscribe();
    clearInterval(this.interval);
  }

  moveArrowToPosition(animate: boolean, newBlockFromLeft = false) {
    if (this.markHeight === undefined) {
      this.arrowVisible = false;
      return;
    }
    if (this.chainTip == null) {
      this.pendingMarkBlock = { animate, newBlockFromLeft };
    }
    const blockindex = this.blocks.findIndex((b) => b.height === this.markHeight);
    if (blockindex > -1) {
      if (!animate) {
        this.arrowTransition = 'inherit';
      }
      this.arrowVisible = true;
      if (newBlockFromLeft) {
        this.arrowLeftPx = blockindex * this.blockOffset + this.blockPadding - this.dividerBlockOffset;
        setTimeout(() => {
          this.arrowTransition = '2s';
          this.arrowLeftPx = blockindex * this.blockOffset + this.blockPadding;
          this.cd.markForCheck();
        }, 50);
      } else {
        this.arrowLeftPx = blockindex * this.blockOffset + this.blockPadding;
        if (!animate) {
          setTimeout(() => {
            this.arrowTransition = '2s';
            this.cd.markForCheck();
          }, 50);
        }
      }
    } else {
      this.arrowVisible = false;
    }
  }

  trackByBlocksFn(index: number, item: BlockchainBlock) {
    return item.height;
  }

  updateStaticBlocks(animateSlide: boolean = false) {
    // reset blocks
    this.blocks = [];
    this.blockStyles = [];
    while (this.blocks.length < this.count) {
      const height = this.height - this.blocks.length;
      let block;
      if (height >= 0) {
        this.cacheService.loadBlock(height);
        block = this.cacheService.getCachedBlock(height) || null;
        if (block?.extras) {
          block.extras.minFee = this.getMinBlockFee(block);
          block.extras.maxFee = this.getMaxBlockFee(block);
        }
      }
      this.blocks.push(block || {
        placeholder: height < 0,
        loading: height >= 0,
        id: '',
        height,
        version: 0,
        timestamp: 0,
        bits: 0,
        nonce: 0,
        difficulty: 0,
        merkle_root: '',
        tx_count: 0,
        size: 0,
        weight: 0,
        previousblockhash: '',
      });
    }
    this.blocks = this.blocks.slice(0, this.count);
    this.blockStyles = [];
    this.blocks.forEach((b, i) => this.blockStyles.push(this.getStyleForBlock(b, i, animateSlide ? -this.blockOffset : 0)));
    this.cd.markForCheck();
    if (animateSlide) {
      // animate blocks slide right
      setTimeout(() => {
        this.blockStyles = [];
        this.blocks.forEach((b, i) => this.blockStyles.push(this.getStyleForBlock(b, i)));
        this.cd.markForCheck();
      }, 50);
      this.moveArrowToPosition(true, true);
    } else {
      this.moveArrowToPosition(false, false);
    }
  }

  onBlockLoaded(block: BlockExtended) {
    const blockIndex = this.height - block.height;
    if (blockIndex >= 0 && blockIndex < this.blocks.length) {
      if (block?.extras) {
        block.extras.minFee = this.getMinBlockFee(block);
        block.extras.maxFee = this.getMaxBlockFee(block);
      }
      this.blocks[blockIndex] = block;
      this.blockStyles[blockIndex] = this.getStyleForBlock(block, blockIndex);
    }
    this.cd.markForCheck();
  }

  isSpecial(height: number): boolean {
    return this.specialBlocks[height]?.networks.includes(this.stateService.network || 'mainnet') ? true : false;
  }

  getStyleForBlock(block: BlockchainBlock, index: number, animateEnterFrom: number = 0) {
    if (!block || block.placeholder) {
      return this.getStyleForPlaceholderBlock(index, animateEnterFrom);
    } else if (block.loading) {
      return this.getStyleForLoadingBlock(index, animateEnterFrom);
    }
    const greenBackgroundHeight = 100 - (block.weight / this.stateService.env.BLOCK_WEIGHT_UNITS) * 100;
    let addLeft = 0;

    if (animateEnterFrom) {
      addLeft = animateEnterFrom || 0;
    }

    return {
      left: addLeft + this.blockOffset * index + 'px',
      background: `repeating-linear-gradient(
        var(--secondary),
        var(--secondary) ${greenBackgroundHeight}%,
        ${this.gradientColors[this.network][0]} ${Math.max(greenBackgroundHeight, 0)}%,
        ${this.gradientColors[this.network][1]} 100%
      )`,
      transition: animateEnterFrom ? 'background 2s, transform 1s' : null,
    };
  }

  convertStyleForLoadingBlock(style) {
    return {
      ...style,
      background: "var(--secondary)",
    };
  }

  getStyleForLoadingBlock(index: number, animateEnterFrom: number = 0) {
    const addLeft = animateEnterFrom || 0;

    return {
      left: addLeft + (this.blockOffset * index) + 'px',
      background: "var(--secondary)",
    };
  }

  getStyleForPlaceholderBlock(index: number, animateEnterFrom: number = 0) {
    const addLeft = animateEnterFrom || 0;
    return {
      left: addLeft + (this.blockOffset * index) + 'px',
    };
  }

  getStyleForEmptyBlock(block: BlockExtended, animateEnterFrom: number = 0) {
    const addLeft = animateEnterFrom || 0;

    return {
      left: addLeft + this.blockOffset * this.emptyBlocks.indexOf(block) + 'px',
      background: "var(--secondary)",
    };
  }

  mountEmptyBlocks() {
    const emptyBlocks = [];
    for (let i = 0; i < this.dynamicBlocksAmount; i++) {
      emptyBlocks.push({
        id: '',
        height: 0,
        version: 0,
        timestamp: 0,
        bits: 0,
        nonce: 0,
        difficulty: 0,
        merkle_root: '',
        tx_count: 0,
        size: 0,
        weight: 0,
        previousblockhash: '',
        matchRate: 0,
      });
    }
    return emptyBlocks;
  }

  getMinBlockFee(block: BlockExtended): number {
    if (block?.extras?.effectiveFeeRange) {
      return block.extras.effectiveFeeRange[0];
    }
    if (block?.extras?.feeRange) {
      // heuristic to check if feeRange is adjusted for effective rates
      if (block.extras.medianFee === block.extras.feeRange[3]) {
        return block.extras.feeRange[1];
      } else {
        return block.extras.feeRange[0];
      }
    }
    return 0;
  }

  getMaxBlockFee(block: BlockExtended): number {
    if (block?.extras?.effectiveFeeRange) {
      return block.extras.effectiveFeeRange[block.extras.effectiveFeeRange.length - 1];
    }
    if (block?.extras?.feeRange) {
      return block.extras.feeRange[block.extras.feeRange.length - 1];
    }
    return 0;
  }
}
