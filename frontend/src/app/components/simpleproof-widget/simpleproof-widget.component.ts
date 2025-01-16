import { Component, Input, SecurityContext, SimpleChanges, OnChanges } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ServicesApiServices } from '@app/services/services-api.service';
import { catchError, of } from 'rxjs';

export interface SimpleProof {
  file_name: string;
  sha256: string;
  ots_verification: string;
  block_height: number;
  block_hash: string;
  block_time: number;
  simpleproof_url: string;
  key?: string;
  sanitized_url?: SafeResourceUrl;
}

@Component({
  selector: 'app-simpleproof-widget',
  templateUrl: './simpleproof-widget.component.html',
  styleUrls: ['./simpleproof-widget.component.scss'],
})
export class SimpleProofWidgetComponent implements OnChanges {
  @Input() key: string = window['__env']?.customize?.dashboard.widgets?.find(w => w.component ==='simpleproof')?.props?.key ?? '';
  @Input() label: string = window['__env']?.customize?.dashboard.widgets?.find(w => w.component ==='simpleproof')?.props?.label ?? 'Verified Documents';
  @Input() widget: boolean = false;
  @Input() width = 300;
  @Input() height = 400;

  verified: SimpleProof[] = [];
  verifiedPage: SimpleProof[] = [];
  isLoading: boolean = true;
  error: boolean = false;
  page = 1;
  lastPage = 1;
  itemsPerPage = 15;
  paginationMaxSize = window.innerWidth <= 767.98 ? 3 : 5;

  constructor(
    private servicesApiService: ServicesApiServices,
    public sanitizer: DomSanitizer,
  ) {}

  ngOnInit(): void {
    this.loadVerifications();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.widget) {
      this.itemsPerPage = this.widget ? 6 : 15;
    }
    if (changes.key) {
      this.loadVerifications();
    }
  }

  loadVerifications(): void {
    if (this.key) {
      this.isLoading = true;
      this.servicesApiService.getSimpleProofs$(this.key).pipe(
        catchError(() => {
          this.isLoading = false;
          this.error = true;
          return of({});
        }),
      ).subscribe((data: Record<string, SimpleProof>) => {
        if (Object.keys(data).length) {
          this.verified = Object.keys(data).map(key => ({
            ...data[key],
            file_name: data[key].file_name.replace('source-', '').replace('_', ' '),
            key,
            sanitized_url: this.sanitizer.bypassSecurityTrustResourceUrl(this.sanitizer.sanitize(SecurityContext.URL, data[key]['simpleproof-url']) ?? ''),
          })).sort((a, b) => b.key.localeCompare(a.key));
          this.verifiedPage = this.verified.slice((this.page - 1) * this.itemsPerPage, this.page * this.itemsPerPage);
          this.isLoading = false;
          this.error = false;
        }
      });
    }
  }

  pageChange(page: number): void {
    this.page = page;
    this.verifiedPage = this.verified.slice((this.page - 1) * this.itemsPerPage, this.page * this.itemsPerPage);
  }
}
