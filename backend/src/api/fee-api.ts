import { MempoolBlock } from '../mempool.interfaces';
import config from '../config';
import mempool from './mempool';
import projectedBlocks from './mempool-blocks';

const isLiquid = config.MEMPOOL.NETWORK === 'liquid' || config.MEMPOOL.NETWORK === 'liquidtestnet';

interface RecommendedFees {
  fastestFee: number,
  halfHourFee: number,
  hourFee: number,
  economyFee: number,
  minimumFee: number,
}

class FeeApi {
  constructor() { }

  defaultFee = isLiquid ? 0.1 : 1;
  minimumIncrement = isLiquid ? 0.1 : 1;

  public getRecommendedFee(): RecommendedFees {
    const pBlocks = projectedBlocks.getMempoolBlocks();
    const mPool = mempool.getMempoolInfo();
    const minimumFee = this.roundUpToNearest(mPool.mempoolminfee * 100000, this.minimumIncrement);
    const defaultMinFee = Math.max(minimumFee, this.defaultFee);

    if (!pBlocks.length) {
      return {
        'fastestFee': defaultMinFee,
        'halfHourFee': defaultMinFee,
        'hourFee': defaultMinFee,
        'economyFee': minimumFee,
        'minimumFee': minimumFee,
      };
    }

    const firstMedianFee = this.optimizeMedianFee(pBlocks[0], pBlocks[1]);
    const secondMedianFee = pBlocks[1] ? this.optimizeMedianFee(pBlocks[1], pBlocks[2], firstMedianFee) : this.defaultFee;
    const thirdMedianFee = pBlocks[2] ? this.optimizeMedianFee(pBlocks[2], pBlocks[3], secondMedianFee) : this.defaultFee;

    let fastestFee = Math.max(minimumFee, firstMedianFee);
    let halfHourFee = Math.max(minimumFee, secondMedianFee);
    let hourFee = Math.max(minimumFee, thirdMedianFee);
    const economyFee = Math.max(minimumFee, Math.min(2 * minimumFee, thirdMedianFee));

    // ensure recommendations always increase w/ priority
    fastestFee = Math.max(fastestFee, halfHourFee, hourFee, economyFee);
    halfHourFee = Math.max(halfHourFee, hourFee, economyFee);
    hourFee = Math.max(hourFee, economyFee);

    // explicitly enforce a minimum of ceil(mempoolminfee) on all recommendations.
    // simply rounding up recommended rates is insufficient, as the purging rate
    // can exceed the median rate of projected blocks in some extreme scenarios
    // (see https://bitcoin.stackexchange.com/a/120024)
    return {
      'fastestFee': fastestFee,
      'halfHourFee': halfHourFee,
      'hourFee': hourFee,
      'economyFee': economyFee,
      'minimumFee': minimumFee,
    };
  }

  private optimizeMedianFee(pBlock: MempoolBlock, nextBlock: MempoolBlock | undefined, previousFee?: number): number {
    const medianFee = pBlock.effectiveMedianFee ?? pBlock.medianFee;
    const useFee = previousFee ? (medianFee + previousFee) / 2 : medianFee;
    if (pBlock.blockVSize <= 500000) {
      return this.defaultFee;
    }
    if (pBlock.blockVSize <= 950000 && !nextBlock) {
      const multiplier = (pBlock.blockVSize - 500000) / 500000;
      return Math.max(Math.round(useFee * multiplier), this.defaultFee);
    }
    return this.roundUpToNearest(useFee, this.minimumIncrement);
  }

  private roundUpToNearest(value: number, nearest: number): number {
    return Math.ceil(value / nearest) * nearest;
  }
}

export default new FeeApi();
