import { Component, OnInit, Input, ChangeDetectionStrategy } from '@angular/core';
import { CpfpInfo } from '@interfaces/node-api.interface';
import { Transaction } from '@interfaces/electrs.interface';

@Component({
  selector: 'app-cpfp-info',
  templateUrl: './cpfp-info.component.html',
  styleUrls: ['./cpfp-info.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CpfpInfoComponent implements OnInit {
  @Input() cpfpInfo: CpfpInfo;
  @Input() tx: Transaction;

  constructor() {}

  ngOnInit(): void {}

  roundToOneDecimal(cpfpTx: any): number {
    return +(cpfpTx.fee / (cpfpTx.weight / 4)).toFixed(1);
  }
}
