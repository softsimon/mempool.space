import { Injectable } from '@angular/core';
import { Title, Meta } from '@angular/platform-browser';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { filter, map, switchMap } from 'rxjs';
import { Customization, StateService } from '@app/services/state.service';

@Injectable({
  providedIn: 'root'
})
export class SeoService {
  network = '';
  baseTitle = 'mempool';
  baseDescription = 'Explore the full Bitcoin ecosystem&reg; with The Mempool Open Source Project&reg;.';
  baseDomain = 'mempool.space';

  canonicalLink: HTMLLinkElement = document.getElementById('canonical') as HTMLLinkElement;

  constructor(
    private titleService: Title,
    private metaService: Meta,
    private stateService: StateService,
    private router: Router,
    private activatedRoute: ActivatedRoute,
  ) {
    // save original meta tags
    this.baseDescription = this.stateService.env.customize?.meta?.description || metaService.getTag('name=\'description\'')?.content || this.baseDescription;
    this.baseTitle = this.stateService.env.customize?.meta?.title || titleService.getTitle()?.split(' - ')?.[0] || this.baseTitle;
    if (this.stateService.env.customize?.domains?.length) {
      this.baseDomain = this.stateService.env.customize.domains[0];
    } else {
      try {
        const canonicalUrl = new URL(this.canonicalLink?.href || '');
        this.baseDomain = canonicalUrl?.host;
      } catch (e) {
        // leave as default
      }
    }

    this.stateService.networkChanged$.subscribe((network) => this.network = network);
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      map(() => this.activatedRoute),
      map(route => {
        while (route.firstChild) route = route.firstChild;
        return route;
      }),
      filter(route => route.outlet === 'primary'),
      switchMap(route => route.data),
    ).subscribe((data) => {
      this.clearSoft404();
    });
  }

  setTitle(newTitle: string): void {
    this.titleService.setTitle(newTitle + ' - ' + this.getTitle());
    this.metaService.updateTag({ property: 'og:title', content: newTitle});
    this.metaService.updateTag({ name: 'twitter:title', content: newTitle});
    this.metaService.updateTag({ property: 'og:meta:ready', content: 'ready'});
  }

  resetTitle(): void {
    this.titleService.setTitle(this.getTitle());
    this.metaService.updateTag({ property: 'og:title', content: this.getTitle()});
    this.metaService.updateTag({ name: 'twitter:title', content: this.getTitle()});
    this.metaService.updateTag({ property: 'og:meta:ready', content: 'ready'});
  }

  setEnterpriseTitle(title: string, override: boolean = false) {
    if (override) {
      this.baseTitle = title;
    } else {
      this.baseTitle = title + ' - ' + this.baseTitle;
    }
    this.resetTitle();
  }

  setCustomMeta(customize: Customization) {
    if (!customize.meta) {
      return;
    }
    this.metaService.updateTag({ name: 'description', content: customize.meta.description});
    this.metaService.updateTag({ name: 'twitter:description', content: customize.meta.description});
    this.metaService.updateTag({ property: 'og:description', content: customize.meta.description});
    this.metaService.updateTag({ name: 'twitter:image', content: customize.meta.image.src});
    this.metaService.updateTag({ property: 'og:image', content: customize.meta.image.src});
    this.metaService.updateTag({ property: 'og:image:type', content: customize.meta.image.type});
    this.metaService.updateTag({ property: 'og:image:width', content: customize.meta.image.width});
    this.metaService.updateTag({ property: 'og:image:height', content: customize.meta.image.height});
    const domain = customize.domains?.[0] || window.location.hostname;
    this.metaService.updateTag({ name: 'twitter:domain', content: domain});
  }

  setDescription(newDescription: string): void {
    this.metaService.updateTag({ name: 'description', content: newDescription});
    this.metaService.updateTag({ name: 'twitter:description', content: newDescription});
    this.metaService.updateTag({ property: 'og:description', content: newDescription});
  }

  resetDescription(): void {
    this.metaService.updateTag({ name: 'description', content: this.getDescription()});
    this.metaService.updateTag({ name: 'twitter:description', content: this.getDescription()});
    this.metaService.updateTag({ property: 'og:description', content: this.getDescription()});
  }

  updateCanonical(path) {
    this.canonicalLink.setAttribute('href', 'https://' + this.baseDomain + path);
  }

  getTitle(): string {
    if (this.network === 'testnet')
      return this.baseTitle + ' - Bitcoin Testnet3';
    if (this.network === 'testnet4')
      return this.baseTitle + ' - Bitcoin Testnet4';
    if (this.network === 'signet')
      return this.baseTitle + ' - Bitcoin Signet';
    if (this.network === 'liquid')
      return this.baseTitle + ' - Liquid Network';
    if (this.network === 'liquidtestnet')
      return this.baseTitle + ' - Liquid Testnet';
    return this.baseTitle + ' - ' + (this.network ? this.ucfirst(this.network) : 'Bitcoin') + ' Explorer';
  }

  getDescription(): string {
    return this.baseDescription;
  }

  ucfirst(str: string) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  clearSoft404() {
    window['soft404'] = false;
  }

  logSoft404() {
    window['soft404'] = true;
  }
}
