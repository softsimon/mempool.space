import { ChangeDetectionStrategy, Component, Input, OnChanges, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { ServicesApiServices } from '@app/services/services-api.service';

export type AccelerationStats = {
  totalRequested: number;
  totalBidBoost: number;
  successRate: number;
  totalVsize: number;
}

@Component({
  selector: 'app-acceleration-stats',
  templateUrl: './acceleration-stats.component.html',
  styleUrls: ['./acceleration-stats.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccelerationStatsComponent implements OnInit, OnChanges {
  @Input() timespan: '24h' | '1m' | '1y' | 'all' = '1y';
  accelerationStats$: Observable<AccelerationStats>;
  blocksInPeriod: number = 7 * 144;

  constructor(
    private servicesApiService: ServicesApiServices
  ) { }

  ngOnInit(): void {
    this.updateStats();
  }

  ngOnChanges(): void {
    this.updateStats();
  }

  updateStats(): void {
    this.accelerationStats$ = this.servicesApiService.getAccelerationStats$({ timeframe: this.timespan });
    switch (this.timespan) {
      case '24h':
        this.blocksInPeriod = 144;
        break;
      case '1m':
        this.blocksInPeriod = 30.5 * 144;
        break;
      case '1y':
        this.blocksInPeriod = 30.5 * 144 * 365;
        break;  
      case 'all':
        this.blocksInPeriod = Infinity;
        break;
    }
  }
}
