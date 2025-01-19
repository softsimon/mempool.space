import { DOCUMENT } from '@angular/common';
import { Inject, Injectable } from '@angular/core';
import { ApiService } from '@app/services/api.service';
import { SeoService } from '@app/services/seo.service';
import { Customization, StateService } from '@app/services/state.service';
import { ActivatedRoute } from '@angular/router';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class EnterpriseService {
  exclusiveHostName = '.mempool.space';
  subdomain: string | null = null;
  statsUrl: string;
  siteId: number;
  info$: BehaviorSubject<object> = new BehaviorSubject(null);

  constructor(
    @Inject(DOCUMENT) private document: Document,
    private apiService: ApiService,
    private seoService: SeoService,
    private stateService: StateService,
    private activatedRoute: ActivatedRoute,
  ) {
    const subdomain = this.stateService.env.customize?.enterprise || this.document.location.hostname.indexOf(this.exclusiveHostName) > -1
      && this.document.location.hostname.split(this.exclusiveHostName)[0] || false;
    if (subdomain && subdomain.match(/^[A-z0-9-_]+$/)) {
      this.subdomain = subdomain;
      this.fetchSubdomainInfo();
      this.disableSubnetworks();
      this.stateService.env.ACCELERATOR = false;
    } else {
      this.insertMatomo();
    }
  }

  getSubdomain(): string {
    return this.subdomain;
  }

  disableSubnetworks(): void {
    this.stateService.env.TESTNET_ENABLED = false;
    this.stateService.env.TESTNET4_ENABLED = false;
    this.stateService.env.LIQUID_ENABLED = false;
    this.stateService.env.LIQUID_TESTNET_ENABLED = false;
    this.stateService.env.SIGNET_ENABLED = false;
  }

  fetchSubdomainInfo(): void {
    if (this.stateService.env.customize?.branding) {
      const info = this.stateService.env.customize?.branding;
      this.insertMatomo(info.site_id);
      this.setFavicons(this.stateService.env.customize);
      this.seoService.setCustomMeta(this.stateService.env.customize);
      this.seoService.setEnterpriseTitle(info.title, true);
      this.info$.next(info);
    } else {
      this.apiService.getEnterpriseInfo$(this.subdomain).subscribe((info) => {
        this.insertMatomo(info.site_id);
        this.seoService.setEnterpriseTitle(info.title);
        this.info$.next(info);
      },
      (error) => {
        if (error.status === 404) {
          window.location.href = 'https://mempool.space' + window.location.pathname;
        }
      });
    }
  }

  setFavicons(customize: Customization): void {
    const enterprise = customize.enterprise;
    const head = this.document.getElementsByTagName('head')[0];

    const faviconLinks = [
      {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: `/resources/${enterprise}/favicons/apple-touch-icon.png`
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: `/resources/${enterprise}/favicons/favicon-32x32.png`
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '16x16',
        href: `/resources/${enterprise}/favicons/favicon-16x16.png`
      },
      {
        rel: 'manifest',
        href: `/resources/${enterprise}/favicons/site.webmanifest`
      },
      {
        rel: 'shortcut icon',
        href: `/resources/${enterprise}/favicons/favicon.ico`
      }
    ];

    faviconLinks.forEach(linkInfo => {
      let link = this.document.querySelector(`link[rel="${linkInfo.rel}"]${linkInfo.sizes ? `[sizes="${linkInfo.sizes}"]` : ''}`) as HTMLLinkElement;
      if (!link) {
        link = this.document.createElement('link');
        head.appendChild(link);
      }
      Object.entries(linkInfo).forEach(([attr, value]) => {
        link.setAttribute(attr, value);
      });
    });
  }

  insertMatomo(siteId?: number): void {
    let statsUrl = '//stats.mempool.space/';

    if (!siteId) {
      switch (this.document.location.hostname) {
        case 'mempool.space':
          statsUrl = '//stats.mempool.space/';
          siteId = 5;
          break;
        case 'mempool.ninja':
          statsUrl = '//stats.mempool.space/';
          siteId = 4;
          break;
        case 'liquid.network':
          siteId = 8;
          statsUrl = '//stats.liquid.network/';
          break;
        case 'liquid.place':
          siteId = 10;
          statsUrl = '//stats.liquid.network/';
          break;
        default:
          return;
      }
    }

    this.statsUrl = statsUrl;
    this.siteId = siteId;

    // @ts-ignore
    if (window._paq && window['Matomo']) {
      window['Matomo'].addTracker(statsUrl+'m.php', siteId.toString());
      const matomo = this.getMatomo();
      matomo.setDocumentTitle(this.seoService.getTitle());
      matomo.setCustomUrl(this.getCustomUrl());
      matomo.disableCookies();
      matomo.trackPageView();
      matomo.enableLinkTracking();
    } else {
      // @ts-ignore
      const alreadyInitialized = !!window._paq;
      // @ts-ignore
      const _paq = window._paq = window._paq || [];
      _paq.push(['setDocumentTitle', this.seoService.getTitle()]);
      _paq.push(['setCustomUrl', this.getCustomUrl()]);
      _paq.push(['disableCookies']);
      _paq.push(['trackPageView']);
      _paq.push(['enableLinkTracking']);
      if (alreadyInitialized) {
        _paq.push(['addTracker', statsUrl+'m.php', siteId.toString()]);
      } else {
        (function() {
          _paq.push(['setTrackerUrl', statsUrl+'m.php']);
          _paq.push(['setSiteId', siteId.toString()]);
          const d=document, g=d.createElement('script'), s=d.getElementsByTagName('script')[0];
          // @ts-ignore
          g.type='text/javascript'; g.async=true; g.src=statsUrl+'m.js'; s.parentNode.insertBefore(g,s);
        })();
      }
    }
  }

  private getMatomo() {
    if (this.siteId != null) {
      return window['Matomo']?.getTracker(this.statsUrl+'m.php', this.siteId);
    }
  }

  goal(id: number) {
    // @ts-ignore
    this.getMatomo()?.trackGoal(id);
  }

  page() {
    const matomo = this.getMatomo();
    if (matomo) {
      matomo.setCustomUrl(this.getCustomUrl());
      matomo.trackPageView();
    }
  }

  private getCustomUrl(): string {
    let url = window.location.origin + '/';
    let route = this.activatedRoute;
    while (route) {
      const segment = route?.routeConfig?.path;
      if (segment && segment.length) {
        url += segment + '/';
      }
      route = route.firstChild;
    }
    return url;
  }
}
