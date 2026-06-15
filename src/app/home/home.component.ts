import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
} from "@angular/core";
import { Router } from "@angular/router";
import { AllowIn, ShortcutInput } from "ng-keyboard-shortcuts";
import {
  Subscription,
  debounceTime,
  filter,
  fromEvent,
  map,
  skip,
} from "rxjs";
import { MemoryService } from "../memory.service";
import { Channel } from "../models/channel";
import { ViewMode } from "../models/viewMode";
import { MediaType } from "../models/mediaType";
import { ToastrService } from "ngx-toastr";
import { FocusArea, FocusAreaPrefix } from "../models/focusArea";
import { invoke } from "@tauri-apps/api/core";
import { Source } from "../models/source";
import { Filters } from "../models/filters";
import { SourceType } from "../models/sourceType";
import { animate, state, style, transition, trigger } from "@angular/animations";
import { ErrorService } from "../error.service";
import { Settings } from "../models/settings";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { SortType } from "../models/sortType";
import { getVersion } from "@tauri-apps/api/app";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { WhatsNewModalComponent } from "../whats-new-modal/whats-new-modal.component";
import { LAST_SEEN_VERSION } from "../models/localStorage";
import { isInputFocused } from "../utils";
import { Node } from "../models/node";
import { NodeType } from "../models/nodeType";
import { Stack } from "../models/stack";
import { BulkActionType } from "../models/bulkActionType";

interface CatalogStats {
  total: number;
  live: number;
  movies: number;
  series: number;
  favorites: number;
  archived: number;
  collections: number;
}

interface SummaryCard {
  label: string;
  value: string;
  helper: string;
  tone: "source" | "live" | "movie" | "series";
}

@Component({
  selector: "app-home",
  templateUrl: "./home.component.html",
  styleUrl: "./home.component.css",
  animations: [
    trigger("fadeInOut", [
      transition(":enter", [
        style({ opacity: 0, height: 0, padding: "0", margin: "0" }),
        animate("250ms", style({ opacity: 1, height: "*", padding: "*", margin: "*" })),
      ]),
      transition(":leave", [
        style({ opacity: 1, height: "*", padding: "*", margin: "*" }),
        animate("250ms", style({ opacity: 0, height: 0, padding: "0", margin: "0" })),
      ]),
    ]),
    trigger("fade", [
      state(
        "visible",
        style({
          opacity: 1,
        }),
      ),
      state(
        "hidden",
        style({
          opacity: 0,
        }),
      ),
      transition("visible => hidden", [animate("250ms ease-out")]),
      transition("hidden => visible", [animate("250ms ease-in")]),
    ]),
  ],
})
export class HomeComponent implements AfterViewInit, OnDestroy {
  channels: Channel[] = [];
  readonly viewModeEnum = ViewMode;
  readonly bulkActionType = BulkActionType;
  readonly mediaTypeEnum = MediaType;
  readonly viewLabels: Record<ViewMode, string> = {
    [ViewMode.All]: "Library",
    [ViewMode.Favorites]: "Favorites",
    [ViewMode.Categories]: "Collections",
    [ViewMode.History]: "Recent",
    [ViewMode.Hidden]: "Hidden",
  };
  readonly mediaTypeLabels: Record<MediaType, string> = {
    [MediaType.livestream]: "Live TV",
    [MediaType.movie]: "Movie / VOD",
    [MediaType.serie]: "Series",
    [MediaType.group]: "Collection",
    [MediaType.season]: "Season",
  };
  @ViewChild("search") search!: ElementRef;
  @ViewChild("catalogSection") catalogSection?: ElementRef<HTMLElement>;
  shortcuts: ShortcutInput[] = [];
  focus = 0;
  focusArea = FocusArea.Tiles;
  viewType = ViewMode.All;
  currentWindowSize = window.innerWidth;
  subscriptions: Subscription[] = [];
  filters?: Filters;
  chkLiveStream = true;
  chkMovie = true;
  chkSerie = true;
  reachedMax = false;
  readonly PAGE_SIZE = 36;
  channelsVisible = true;
  prevSearchValue = "";
  loading = false;
  nodeStack: Stack = new Stack();
  showScrollTop = false;
  highlightedChannel?: Channel;
  catalogStats: CatalogStats = this.createEmptyStats();
  demoCatalog: Channel[] = [];
  readonly demoHistoryIds = new Set<number>([1102, 1201, 1004, 1302]);

  constructor(
    private router: Router,
    public memory: MemoryService,
    public toast: ToastrService,
    private error: ErrorService,
    private modal: NgbModal,
  ) {
    this.getSources();
  }

  scrollToTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  get featuredChannel(): Channel | undefined {
    return this.highlightedChannel;
  }

  get summaryCards(): SummaryCard[] {
    const activeSources = this.activeSourceCount;
    const seriesValue = this.anyXtream()
      ? this.catalogStats.series.toString()
      : this.catalogStats.favorites.toString();
    const seriesHelper = this.anyXtream()
      ? this.catalogStats.series > 0
        ? "Season-ready rows available in the current slice."
        : "No series rows surfaced in this slice yet."
      : this.catalogStats.favorites > 0
        ? "Pinned titles ready to reach from the front row."
        : "Favorite items will show up here once you pin them.";

    return [
      {
        label: "Connected sources",
        value: activeSources.toString(),
        helper:
          activeSources === 1
            ? "One provider feeding the current browsing view."
            : `${activeSources} providers feeding the current browsing view.`,
        tone: "source",
      },
      {
        label: "Live channels",
        value: this.catalogStats.live.toString(),
        helper:
          this.catalogStats.archived > 0
            ? `${this.catalogStats.archived} channels support catch-up or archive playback.`
            : "Instant playback lanes from the currently loaded results.",
        tone: "live",
      },
      {
        label: "Movies / VOD",
        value: this.catalogStats.movies.toString(),
        helper:
          this.catalogStats.movies > 0
            ? "Long-form titles available without leaving the main library."
            : "No VOD items surfaced in this slice yet.",
        tone: "movie",
      },
      {
        label: this.anyXtream() ? "Series lanes" : "Pinned favorites",
        value: seriesValue,
        helper: seriesHelper,
        tone: "series",
      },
    ];
  }

  get heroTags(): string[] {
    const tags = [
      `${this.getViewLabel(this.filters?.view_type)} mode`,
      `${this.catalogStats.total} loaded now`,
      `${this.activeSourceCount} ${this.activeSourceCount === 1 ? "source" : "sources"}`,
    ];

    if (this.memory.IsDemoMode) tags.push("Demo mode");
    if (this.filters?.query) tags.push(`Query: "${this.filters.query}"`);
    if (this.featuredChannel?.favorite) tags.push("Pinned");
    if (this.featuredChannel?.tv_archive) tags.push("Catch-up ready");
    return tags;
  }

  get displayedSourceNames(): string[] {
    return this.activeSourceNames.slice(0, 4);
  }

  get remainingSourceCount(): number {
    return Math.max(0, this.activeSourceNames.length - this.displayedSourceNames.length);
  }

  get activeSourceNames(): string[] {
    const sourceIds = this.filters?.source_ids?.length
      ? this.filters.source_ids
      : Array.from(this.memory.Sources.keys());

    return sourceIds
      .map((sourceId) => this.memory.Sources.get(sourceId)?.name?.trim())
      .filter((name): name is string => !!name);
  }

  get activeSourceCount(): number {
    return this.activeSourceNames.length;
  }

  get catalogTitle(): string {
    if (this.filters?.query) return "Matching results";
    if (this.filters?.series_id && this.filters?.season && this.nodeStack.get()) {
      return `Episodes from ${this.nodeStack.get()!.name}`;
    }
    if (this.filters?.series_id && this.nodeStack.get()) return `Seasons of ${this.nodeStack.get()!.name}`;
    if (this.filters?.group_id && this.nodeStack.get()) return this.nodeStack.get()!.name;

    switch (this.filters?.view_type) {
      case ViewMode.Favorites:
        return "Pinned favorites";
      case ViewMode.Categories:
        return "Browsable collections";
      case ViewMode.History:
        return "Continue watching";
      case ViewMode.Hidden:
        return "Hidden entries";
      default:
        return "Your current catalog shelf";
    }
  }

  get catalogDescription(): string {
    if (this.filters?.query) {
      return "These are the best loaded matches for your current search and filters.";
    }
    if (this.filters?.series_id && this.filters?.season) {
      return "Episodes stay in the same polished card system so series browsing feels less utilitarian.";
    }
    if (this.filters?.series_id) {
      return "Season browsing now feels like a proper detail view instead of a dead-end utility screen.";
    }
    if (this.filters?.group_id) {
      return "Collections now read more like a streaming shelf instead of a plain utility list.";
    }

    switch (this.filters?.view_type) {
      case ViewMode.Favorites:
        return "Fast access to the items you already decided deserve front-row treatment.";
      case ViewMode.Categories:
        return "Collection browsing with stronger hierarchy, clearer focus and richer cards.";
      case ViewMode.History:
        return "Jump back into recently opened items without hunting through the whole library.";
      case ViewMode.Hidden:
        return "A safe holding area for items you do not want in the main browsing surface.";
      default:
        return "Live TV, VOD and series surfaced in a layout that feels closer to a real media hub.";
    }
  }

  get emptyStateTitle(): string {
    if (this.filters?.query) return "No titles match this search yet";
    if (this.filters?.view_type === ViewMode.Favorites) return "Nothing has been pinned yet";
    if (this.filters?.view_type === ViewMode.History) return "No recent activity in this view";
    if (this.filters?.view_type === ViewMode.Hidden) return "Nothing is hidden in this slice";
    return "This shelf is empty right now";
  }

  get emptyStateDescription(): string {
    if (this.filters?.query) {
      return "Try another name, broaden the filters, or switch keyword search mode if the provider uses different metadata.";
    }
    if (this.filters?.view_type === ViewMode.Favorites) {
      return "Favorite a few channels or titles and this lane will start to feel like a proper front page.";
    }
    if (this.filters?.view_type === ViewMode.History) {
      return "Open a few items and this area becomes your quick return path.";
    }
    return "Reset the browsing state or connect more sources to bring this surface to life.";
  }

  getSources() {
    if (this.shouldUseDemoMode()) {
      this.loadDemoMode();
      return;
    }

    const getSettings = invoke("get_settings");
    const getSources = invoke("get_sources");

    Promise.all([getSettings, getSources])
      .then((data) => {
        const settings = data[0] as Settings;
        const sources = data[1] as Source[];
        if (settings.zoom) {
          getCurrentWebview().setZoom(Math.trunc(settings.zoom * 100) / 10000);
        }
        this.memory.trayEnabled = settings.enable_tray_icon ?? true;
        this.memory.AlwaysAskSave = settings.always_ask_save ?? false;
        this.memory.Sources = new Map(sources.filter((x) => x.enabled).map((source) => [source.id!, source]));

        if (sources.length === 0) {
          if (this.shouldUseDemoMode()) {
            this.loadDemoMode();
            return;
          }
          this.reset();
          return;
        }

        getVersion().then((version) => {
          if (localStorage.getItem(LAST_SEEN_VERSION) !== version) {
            this.memory.AppVersion = version;
            this.memory.ModalRef = this.modal.open(WhatsNewModalComponent, {
              backdrop: "static",
              size: "xl",
              keyboard: false,
            });
            this.memory.ModalRef.componentInstance.name = "WhatsNewModal";
          }
        });

        sources
          .filter((x) => x.source_type === SourceType.Custom)
          .map((x) => x.id!)
          .forEach((x) => this.memory.CustomSourceIds?.add(x));

        sources
          .filter((x) => x.source_type === SourceType.Xtream)
          .map((x) => x.id!)
          .forEach((x) => this.memory.XtreamSourceIds.add(x));

        if (
          this.memory.XtreamSourceIds.size > 0 &&
          !sessionStorage.getItem("epgCheckedOnStart")
        ) {
          sessionStorage.setItem("epgCheckedOnStart", "true");
          invoke("on_start_check_epg");
        }

        this.filters = {
          source_ids: Array.from(this.memory.Sources.keys()),
          view_type: settings.default_view ?? ViewMode.All,
          media_types: [MediaType.livestream, MediaType.movie, MediaType.serie],
          page: 1,
          use_keywords: false,
          sort: SortType.provider,
        };

        if (settings.default_sort !== undefined && settings.default_sort !== SortType.provider) {
          this.memory.Sort.next([settings.default_sort, false]);
          this.filters.sort = settings.default_sort;
        }

        this.chkSerie = this.anyXtream();

        if (settings.refresh_on_start === true && !sessionStorage.getItem("refreshedOnStart")) {
          sessionStorage.setItem("refreshedOnStart", "true");
          this.refreshOnStart().then((_) => _);
        }

        this.load().then((_) => _);
      })
      .catch((e) => {
        if (this.shouldUseDemoMode()) {
          this.loadDemoMode();
          return;
        }
        this.error.handleError(e);
        this.reset();
      });
  }

  async refreshOnStart() {
    this.toast.info("Refreshing all sources... (refresh on start enabled)");
    await this.memory.tryIPC(
      "Successfully refreshed all sources (refresh on start enabled)",
      "Failed to refresh all sources (refresh on start enabled)",
      async () => {
        await invoke("refresh_all");
      },
    );
  }

  async reload() {
    await this.load();
  }

  reset() {
    this.router.navigateByUrl("setup");
  }

  async addEvents() {
    this.subscriptions.push(
      this.memory.HideChannels.subscribe((val) => {
        this.channelsVisible = val;
      }),
    );

    this.subscriptions.push(
      this.memory.SetFocus.subscribe((focus) => {
        this.focus = focus;
      }),
    );

    this.subscriptions.push(
      this.memory.SetNode.subscribe(async (dto) => {
        this.nodeStack.add(
          new Node(
            dto.id,
            dto.name,
            dto.type,
            this.filters?.query,
            this.filters?.view_type,
          ),
        );

        if (dto.type === NodeType.Category) this.filters!.group_id = dto.id;
        else if (dto.type === NodeType.Series) {
          this.filters!.series_id = dto.id;
          this.filters!.source_ids = [dto.sourceId!];
        } else if (dto.type === NodeType.Season) {
          this.filters!.season = dto.id;
        }

        if (this.filters!.view_type === ViewMode.Hidden) {
          this.filters!.view_type = ViewMode.Categories;
        }

        this.clearSearch();
        await this.load();
        if (this.focusArea === FocusArea.Tiles) this.selectFirstChannelDelayed(100);
      }),
    );

    this.subscriptions.push(
      this.memory.Refresh.subscribe((scroll) => {
        this.load();
        if (scroll) {
          window.scrollTo({ top: 0, behavior: "instant" });
        }
      }),
    );

    this.subscriptions.push(
      this.memory.Sort.pipe(skip(1)).subscribe(async ([sort, load]) => {
        if (!this.filters || !load) return;
        this.filters.sort = sort;
        await this.load();
      }),
    );
  }

  clearSearch() {
    this.search.nativeElement.value = "";
    this.prevSearchValue = "";
    this.filters!.query = "";
  }

  async loadMore() {
    await this.load(true);
  }

  async load(more = false) {
    this.loading = true;
    if (more) {
      this.filters!.page++;
    } else {
      this.filters!.page = 1;
    }

    if (this.memory.IsDemoMode) {
      this.loadDemoChannels();
      this.loading = false;
      return;
    }

    try {
      const channels: Channel[] = await invoke("search", { filters: this.filters });
      if (!more) {
        this.channels = channels;
        this.channelsVisible = true;
        this.viewType = this.filters!.view_type;
      } else {
        this.channels = this.channels.concat(channels);
      }
      this.reachedMax = channels.length < this.PAGE_SIZE;
      this.refreshPresentationState();
    } catch (e) {
      this.error.handleError(e);
    }

    this.loading = false;
  }

  private refreshPresentationState() {
    this.catalogStats = this.channels.reduce(
      (stats, channel) => {
        stats.total += 1;
        if (channel.favorite) stats.favorites += 1;
        if (channel.tv_archive) stats.archived += 1;

        switch (channel.media_type) {
          case MediaType.livestream:
            stats.live += 1;
            break;
          case MediaType.movie:
            stats.movies += 1;
            break;
          case MediaType.serie:
            stats.series += 1;
            break;
          case MediaType.group:
            stats.collections += 1;
            break;
        }

        return stats;
      },
      this.createEmptyStats(),
    );

    if (
      !this.highlightedChannel ||
      !this.channels.some(
        (channel) =>
          channel.id === this.highlightedChannel?.id &&
          channel.source_id === this.highlightedChannel?.source_id,
      )
    ) {
      this.highlightedChannel = this.pickFeaturedChannel();
    }
  }

  private createEmptyStats(): CatalogStats {
    return {
      total: 0,
      live: 0,
      movies: 0,
      series: 0,
      favorites: 0,
      archived: 0,
      collections: 0,
    };
  }

  private shouldUseDemoMode(): boolean {
    return typeof window !== "undefined" && !((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__);
  }

  private loadDemoMode() {
    this.memory.IsDemoMode = true;
    this.memory.trayEnabled = false;
    this.memory.AlwaysAskSave = false;

    const demoSources = this.getDemoSources();
    this.memory.Sources = new Map(demoSources.map((source) => [source.id!, source]));
    this.memory.CustomSourceIds = new Set<number>();
    this.memory.XtreamSourceIds = new Set<number>([9002, 9003]);

    this.demoCatalog = this.buildDemoCatalog();
    this.filters = {
      source_ids: Array.from(this.memory.Sources.keys()),
      view_type: ViewMode.All,
      media_types: [MediaType.livestream, MediaType.movie, MediaType.serie],
      page: 1,
      use_keywords: false,
      sort: SortType.provider,
    };
    this.chkLiveStream = true;
    this.chkMovie = true;
    this.chkSerie = true;
    this.viewType = ViewMode.All;
    this.nodeStack.clear();
    this.loadDemoChannels();
  }

  private loadDemoChannels() {
    const filteredChannels = this.getFilteredDemoChannels();
    const pageLimit = this.filters!.page * this.PAGE_SIZE;
    this.channels = filteredChannels.slice(0, pageLimit);
    this.channelsVisible = true;
    this.viewType = this.filters!.view_type;
    this.reachedMax = this.channels.length >= filteredChannels.length;
    this.refreshPresentationState();
  }

  private getFilteredDemoChannels(): Channel[] {
    let channels = [...this.demoCatalog];
    const browsingSeries = this.filters?.series_id !== undefined;
    const browsingSeason = browsingSeries && this.filters?.season !== undefined;

    if (browsingSeason) {
      channels = channels.filter(
        (channel) =>
          channel.series_id === this.filters?.series_id &&
          channel.season_id === this.filters?.season &&
          channel.media_type !== MediaType.season,
      );
    } else if (browsingSeries) {
      channels = channels.filter(
        (channel) =>
          channel.series_id === this.filters?.series_id &&
          channel.media_type === MediaType.season,
      );
    } else if (this.filters?.view_type === ViewMode.Categories && !this.filters.group_id) {
      channels = channels.filter((channel) => channel.media_type === MediaType.group);
    } else {
      channels = channels.filter(
        (channel) =>
          channel.media_type !== MediaType.group &&
          channel.media_type !== MediaType.season &&
          channel.season_id === undefined,
      );
    }

    if (this.filters?.view_type === ViewMode.Favorites) {
      channels = channels.filter((channel) => channel.favorite);
    } else if (this.filters?.view_type === ViewMode.History) {
      channels = channels.filter((channel) => this.demoHistoryIds.has(channel.id!));
    } else if (this.filters?.view_type === ViewMode.Hidden) {
      channels = channels.filter((channel) => channel.hidden);
    }

    if (this.filters?.group_id && !browsingSeries) {
      channels = channels.filter((channel) => channel.group_id === this.filters?.group_id);
    }

    if (browsingSeries) {
      const allowHidden = this.filters?.view_type === ViewMode.Hidden;
      channels = channels.filter((channel) => (allowHidden ? channel.hidden : !channel.hidden));
    } else if (this.filters?.view_type !== ViewMode.Categories || this.filters.group_id) {
      const allowHidden = this.filters?.view_type === ViewMode.Hidden;
      channels = channels.filter(
        (channel) =>
          channel.media_type !== undefined &&
          this.filters!.media_types.includes(channel.media_type) &&
          (allowHidden ? channel.hidden : !channel.hidden),
      );
    }

    channels = channels.filter((channel) =>
      this.filters?.source_ids.includes(channel.source_id!),
    );

    if (this.filters?.query?.trim()) {
      const query = this.filters.query.toLowerCase().trim();
      const keywords = query.split(/\s+/).filter(Boolean);

      channels = channels.filter((channel) => {
        const searchText = [
          channel.name,
          this.getSourceName(channel.source_id),
          this.getMediaTypeLabel(channel.media_type),
        ]
          .join(" ")
          .toLowerCase();

        if (this.filters?.use_keywords) {
          return keywords.every((keyword) => searchText.includes(keyword));
        }

        return searchText.includes(query);
      });
    }

    return this.sortDemoChannels(channels);
  }

  private sortDemoChannels(channels: Channel[]): Channel[] {
    const sorted = [...channels];
    if (this.filters?.series_id && this.filters?.season) {
      return sorted.sort(
        (left, right) =>
          (left.episode_num ?? 0) - (right.episode_num ?? 0) ||
          (left.name ?? "").localeCompare(right.name ?? ""),
      );
    }

    if (this.filters?.series_id) {
      return sorted.sort((left, right) => (left.id ?? 0) - (right.id ?? 0));
    }

    switch (this.filters?.sort) {
      case SortType.alphabeticalAscending:
        return sorted.sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""));
      case SortType.alphabeticalDescending:
        return sorted.sort((left, right) => (right.name ?? "").localeCompare(left.name ?? ""));
      default:
        return sorted.sort((left, right) => {
          const sourceCompare = this.getSourceName(left.source_id).localeCompare(
            this.getSourceName(right.source_id),
          );
          if (sourceCompare !== 0) return sourceCompare;
          return (left.name ?? "").localeCompare(right.name ?? "");
        });
    }
  }

  private getDemoSources(): Source[] {
    return [
      {
        id: 9001,
        name: "Northline Live",
        source_type: SourceType.M3ULink,
        enabled: true,
      },
      {
        id: 9002,
        name: "Cinema Bay",
        source_type: SourceType.Xtream,
        enabled: true,
      },
      {
        id: 9003,
        name: "Series Atlas",
        source_type: SourceType.Xtream,
        enabled: true,
      },
    ];
  }

  private buildDemoCatalog(): Channel[] {
    return [
      this.createDemoChannel(3001, "Trending Live", MediaType.group, 9001, "#315dff", "#1ab2ff"),
      this.createDemoChannel(3002, "Cinema Picks", MediaType.group, 9002, "#ff914d", "#ffce54"),
      this.createDemoChannel(3003, "Weekend Series", MediaType.group, 9003, "#8457ff", "#49c6ff"),
      this.createDemoChannel(1001, "Asteria News", MediaType.livestream, 9001, "#315dff", "#1ab2ff", {
        favorite: true,
        tv_archive: true,
        groupId: 3001,
      }),
      this.createDemoChannel(1002, "Courtside 24", MediaType.livestream, 9001, "#0e7490", "#22d3ee", {
        groupId: 3001,
      }),
      this.createDemoChannel(1003, "World Pulse", MediaType.livestream, 9001, "#0f766e", "#14b8a6", {
        tv_archive: true,
        groupId: 3001,
      }),
      this.createDemoChannel(1004, "Retro Arena", MediaType.livestream, 9001, "#8b5cf6", "#ec4899", {
        favorite: true,
        groupId: 3001,
      }),
      this.createDemoChannel(1101, "Premiere Nights", MediaType.movie, 9002, "#fb7185", "#f59e0b", {
        favorite: true,
        groupId: 3002,
      }),
      this.createDemoChannel(1102, "Skyline Heist", MediaType.movie, 9002, "#f97316", "#facc15", {
        groupId: 3002,
      }),
      this.createDemoChannel(1103, "Glass Harbor", MediaType.movie, 9002, "#64748b", "#38bdf8", {
        groupId: 3002,
      }),
      this.createDemoChannel(1104, "Signal Zero", MediaType.movie, 9002, "#4338ca", "#818cf8", {
        hidden: true,
        groupId: 3002,
      }),
      this.createDemoChannel(1201, "Neon District", MediaType.serie, 9003, "#7c3aed", "#22d3ee", {
        favorite: true,
        groupId: 3003,
        url: "52001",
        seriesId: 52001,
      }),
      this.createDemoChannel(1202, "Paper Satellites", MediaType.serie, 9003, "#2563eb", "#93c5fd", {
        groupId: 3003,
        url: "52002",
        seriesId: 52002,
      }),
      this.createDemoChannel(1203, "Old Harbor Files", MediaType.serie, 9003, "#0f766e", "#a7f3d0", {
        groupId: 3003,
        url: "52003",
        seriesId: 52003,
      }),
      this.createDemoChannel(2201, "Season 1", MediaType.season, 9003, "#7c3aed", "#22d3ee", {
        groupId: 3003,
        seriesId: 52001,
      }),
      this.createDemoChannel(2202, "Season 2", MediaType.season, 9003, "#8b5cf6", "#38bdf8", {
        groupId: 3003,
        seriesId: 52001,
      }),
      this.createDemoChannel(2203, "Season 1", MediaType.season, 9003, "#2563eb", "#93c5fd", {
        groupId: 3003,
        seriesId: 52002,
      }),
      this.createDemoChannel(2204, "Season 1", MediaType.season, 9003, "#0f766e", "#a7f3d0", {
        groupId: 3003,
        seriesId: 52003,
      }),
      this.createDemoChannel(3201, "Episode 1: Static Bloom", MediaType.movie, 9003, "#7c3aed", "#22d3ee", {
        groupId: 3003,
        seriesId: 52001,
        seasonId: 2201,
        episodeNum: 1,
      }),
      this.createDemoChannel(3202, "Episode 2: The Glass Mile", MediaType.movie, 9003, "#7c3aed", "#38bdf8", {
        groupId: 3003,
        seriesId: 52001,
        seasonId: 2201,
        episodeNum: 2,
      }),
      this.createDemoChannel(3203, "Episode 3: Low Signal", MediaType.movie, 9003, "#8b5cf6", "#22d3ee", {
        groupId: 3003,
        seriesId: 52001,
        seasonId: 2201,
        episodeNum: 3,
      }),
      this.createDemoChannel(3204, "Episode 1: Night Run", MediaType.movie, 9003, "#8b5cf6", "#38bdf8", {
        groupId: 3003,
        seriesId: 52001,
        seasonId: 2202,
        episodeNum: 1,
      }),
      this.createDemoChannel(3205, "Episode 2: Exit Thread", MediaType.movie, 9003, "#6d28d9", "#67e8f9", {
        groupId: 3003,
        seriesId: 52001,
        seasonId: 2202,
        episodeNum: 2,
      }),
      this.createDemoChannel(3206, "Episode 1: Thin Atmosphere", MediaType.movie, 9003, "#2563eb", "#93c5fd", {
        favorite: true,
        groupId: 3003,
        seriesId: 52002,
        seasonId: 2203,
        episodeNum: 1,
      }),
      this.createDemoChannel(3207, "Episode 2: Silent Dock", MediaType.movie, 9003, "#1d4ed8", "#bfdbfe", {
        groupId: 3003,
        seriesId: 52002,
        seasonId: 2203,
        episodeNum: 2,
      }),
      this.createDemoChannel(3208, "Episode 1: Harbor Wake", MediaType.movie, 9003, "#0f766e", "#a7f3d0", {
        groupId: 3003,
        seriesId: 52003,
        seasonId: 2204,
        episodeNum: 1,
      }),
      this.createDemoChannel(1301, "Festival Cut", MediaType.movie, 9002, "#be123c", "#fb7185", {
        groupId: 3002,
      }),
      this.createDemoChannel(1302, "Night Signal", MediaType.livestream, 9001, "#1d4ed8", "#60a5fa", {
        tv_archive: true,
        groupId: 3001,
      }),
    ];
  }

  private createDemoChannel(
    id: number,
    name: string,
    mediaType: MediaType,
    sourceId: number,
    startColor: string,
    endColor: string,
    options: {
      favorite?: boolean;
      tv_archive?: boolean;
      hidden?: boolean;
      groupId?: number;
      url?: string;
      seriesId?: number;
      seasonId?: number;
      episodeNum?: number;
    } = {},
  ): Channel {
    const initials = name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("");

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${startColor}" />
            <stop offset="100%" stop-color="${endColor}" />
          </linearGradient>
        </defs>
        <rect width="640" height="360" rx="28" fill="url(#grad)" />
        <circle cx="532" cy="88" r="78" fill="rgba(255,255,255,0.14)" />
        <circle cx="96" cy="280" r="110" fill="rgba(255,255,255,0.08)" />
        <text x="48" y="150" font-family="Arial, sans-serif" font-size="74" font-weight="700" fill="white">${initials}</text>
        <text x="48" y="214" font-family="Arial, sans-serif" font-size="34" fill="rgba(255,255,255,0.9)">${name}</text>
      </svg>
    `;

    return {
      id,
      name,
      media_type: mediaType,
      source_id: sourceId,
      url: options.url ?? `demo://${id}`,
      image: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      favorite: options.favorite ?? false,
      tv_archive: options.tv_archive ?? false,
      hidden: options.hidden ?? false,
      group_id: options.groupId,
      series_id: options.seriesId,
      season_id: options.seasonId,
      episode_num: options.episodeNum,
    };
  }

  private pickFeaturedChannel(): Channel | undefined {
    return (
      this.channels.find((channel) => !!channel.image && !!channel.favorite) ??
      this.channels.find(
        (channel) =>
          !!channel.image &&
          (channel.media_type === MediaType.movie || channel.media_type === MediaType.serie),
      ) ??
      this.channels.find((channel) => !!channel.image) ??
      this.channels.find((channel) => !!channel.favorite) ??
      this.channels[0]
    );
  }

  setHighlightedChannel(channel: Channel) {
    this.highlightedChannel = channel;
  }

  getFeaturedInitials(): string {
    const name = this.featuredChannel?.name?.trim();
    if (!name) return "TV";

    const initials = name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("");

    return initials || name.slice(0, 2).toUpperCase();
  }

  getSourceName(sourceId?: number): string {
    if (!sourceId) return "";
    return this.memory.Sources.get(sourceId)?.name ?? "";
  }

  getMediaTypeLabel(mediaType?: MediaType): string {
    if (mediaType === undefined) return "Ready to browse";
    return this.mediaTypeLabels[mediaType];
  }

  getViewLabel(viewMode?: ViewMode): string {
    if (viewMode === undefined) return "Library";
    return this.viewLabels[viewMode];
  }

  getContextHeading(): string {
    if (this.filters?.query) return "Search your catalog with more intent";
    if (this.filters?.series_id && this.filters?.season) return "Pick an episode and keep moving";
    if (this.filters?.series_id) return "Browse seasons without losing momentum";
    if (this.filters?.group_id) return "Collections should feel curated";

    switch (this.filters?.view_type) {
      case ViewMode.Favorites:
        return "Favorites deserve a front row";
      case ViewMode.Categories:
        return "Collections should feel curated";
      case ViewMode.History:
        return "Pick up where you left off";
      case ViewMode.Hidden:
        return "Keep the main catalog clean";
      default:
        return "Bring your catalog closer to a real streaming hub";
    }
  }

  getContextDescription(): string {
    const sourceCountText = `${this.activeSourceCount} ${this.activeSourceCount === 1 ? "source" : "sources"}`;
    const featuredSource = this.getSourceName(this.featuredChannel?.source_id);

    if (this.filters?.query) {
      return `Search stays front and center while the surface highlights the best loaded match from ${sourceCountText}.`;
    }

    if (this.filters?.series_id && this.filters?.season) {
      return "Episode lists stay ordered, legible and one click away from playback instead of dropping you into a rough intermediary step.";
    }

    if (this.filters?.series_id) {
      return "Series and season browsing now carries the same visual weight as the main catalog.";
    }

    if (this.featuredChannel?.name) {
      const sourceText = featuredSource ? ` from ${featuredSource}` : "";
      return `The current hero updates with focus so each tile feels more like a title card${sourceText}, not just a row in a utility list.`;
    }

    return `This view is pulling from ${sourceCountText} and presenting live, VOD and series content with a stronger editorial hierarchy.`;
  }

  async resetBrowseState() {
    if (!this.filters) return;

    this.filters.query = "";
    this.filters.group_id = undefined;
    this.filters.series_id = undefined;
    this.filters.season = undefined;
    this.filters.source_ids = Array.from(this.memory.Sources.keys());
    this.filters.view_type = ViewMode.All;
    this.filters.media_types = [MediaType.livestream, MediaType.movie];
    this.chkLiveStream = true;
    this.chkMovie = true;
    this.chkSerie = this.anyXtream();

    if (this.chkSerie) {
      this.filters.media_types.push(MediaType.serie);
    }

    this.nodeStack.clear();
    this.clearSearch();
    await this.load();
  }

  jumpToCatalog() {
    this.catalogSection?.nativeElement.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    this.selectFirstChannelDelayed(150);
  }

  trackByChannel(index: number, channel: Channel): string {
    return `${channel.id ?? index}-${channel.source_id ?? "source"}`;
  }

  checkScrollTop() {
    const scrollPosition =
      window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
    this.showScrollTop = scrollPosition > 300;
  }

  async checkScrollEnd() {
    if (this.reachedMax === true || this.loading === true) return;
    const scrollHeight = document.documentElement.scrollHeight;
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const clientHeight = window.innerHeight || document.documentElement.clientHeight;
    if (scrollTop + clientHeight >= scrollHeight * 0.75) {
      await this.loadMore();
    }
  }

  @HostListener("window:scroll", ["$event"])
  async scroll(_event: Event) {
    this.checkScrollTop();
    await this.checkScrollEnd();
  }

  @HostListener("window:resize")
  onResize() {
    this.currentWindowSize = window.innerWidth;
  }

  ngAfterViewInit(): void {
    this.addEvents().then((_) => _);
    this.subscriptions.push(
      fromEvent<KeyboardEvent>(this.search.nativeElement, "keyup")
        .pipe(
          filter((event) => event.key !== "Escape"),
          map((event) => {
            const typedEvent = event as KeyboardEvent & {
              target: HTMLInputElement;
            };
            this.focus = 0;
            this.focusArea = FocusArea.Tiles;
            if (this.channelsVisible && typedEvent.target.value !== this.prevSearchValue) {
              this.channelsVisible = false;
            }
            this.prevSearchValue = typedEvent.target.value;
            return typedEvent.target.value;
          }),
          debounceTime(300),
        )
        .subscribe(async (term: string) => {
          this.filters!.query = term;
          await this.load();
        }),
    );

    this.shortcuts.push(
      {
        key: ["ctrl + f", "ctrl + space", "cmd + f"],
        label: "Search",
        description: "Go to search",
        preventDefault: true,
        allowIn: [AllowIn.Input],
        command: (_) => this.focusSearch(),
      },
      {
        key: ["ctrl + a", "cmd + a"],
        label: "Switching modes",
        description: "Selects the all channels view",
        preventDefault: true,
        command: async (_) => await this.switchMode(this.viewModeEnum.All),
      },
      {
        key: ["ctrl + s", "cmd + s"],
        label: "Switching modes",
        description: "Selects the categories view",
        command: async (_) => await this.switchMode(this.viewModeEnum.Categories),
      },
      {
        key: ["ctrl + d", "cmd + d"],
        label: "Switching modes",
        description: "Selects the history view",
        command: async (_) => await this.switchMode(this.viewModeEnum.History),
      },
      {
        key: ["ctrl + r", "cmd + r"],
        label: "Switching modes",
        description: "Selects the favorites view",
        command: async (_) => await this.switchMode(this.viewModeEnum.Favorites),
      },
      {
        key: "ctrl + q",
        label: "Media Type Filters",
        description: "Enable/Disable livestreams",
        preventDefault: true,
        allowIn: [AllowIn.Input],
        command: async (_) => {
          this.chkLiveStream = !this.chkLiveStream;
          this.updateMediaTypes(MediaType.livestream);
        },
      },
      {
        key: "ctrl + w",
        label: "Media Type Filters",
        description: "Enable/Disable movies",
        preventDefault: true,
        allowIn: [AllowIn.Input],
        command: async (_) => {
          this.chkMovie = !this.chkMovie;
          this.updateMediaTypes(MediaType.movie);
        },
      },
      {
        key: "ctrl + e",
        label: "Media Type Filters",
        description: "Enable/Disable series",
        preventDefault: true,
        allowIn: [AllowIn.Input],
        command: async (_) => {
          this.chkSerie = !this.chkSerie;
          this.updateMediaTypes(MediaType.serie);
        },
      },
      {
        key: "left",
        label: "Navigation",
        description: "Go left",
        allowIn: [AllowIn.Input],
        command: async (_) => await this.nav("ArrowLeft"),
      },
      {
        key: "right",
        label: "Navigation",
        description: "Go right",
        allowIn: [AllowIn.Input],
        command: async (_) => await this.nav("ArrowRight"),
      },
      {
        key: "up",
        label: "Navigation",
        description: "Go up",
        allowIn: [AllowIn.Input],
        preventDefault: true,
        command: async (_) => await this.nav("ArrowUp"),
      },
      {
        key: "down",
        label: "Navigation",
        description: "Go down",
        allowIn: [AllowIn.Input],
        preventDefault: true,
        command: async (_) => await this.nav("ArrowDown"),
      },
    );
  }

  updateMediaTypes(mediaType: MediaType) {
    const index = this.filters!.media_types.indexOf(mediaType);
    if (index === -1) this.filters!.media_types.push(mediaType);
    else this.filters!.media_types.splice(index, 1);
    this.load();
  }

  filtersVisible() {
    return !this.filters?.series_id;
  }

  async switchMode(viewMode: ViewMode) {
    if (viewMode === this.filters?.view_type) return;
    this.filters!.series_id = undefined;
    this.filters!.group_id = undefined;
    this.filters!.view_type = viewMode;
    this.filters!.season = undefined;
    this.clearSearch();
    this.nodeStack.clear();
    await this.load();
  }

  searchFocused(): boolean {
    return document.activeElement?.id === "search";
  }

  focusSearch() {
    if (this.searchFocused()) {
      this.selectFirstChannel();
      return;
    }

    this.focus = 0;
    this.focusArea = FocusArea.Tiles;
    window.scrollTo({ top: 0, behavior: "smooth" });
    this.search.nativeElement.focus({
      preventScroll: true,
    });
  }

  async goBackHotkey() {
    if (this.memory.ModalRef) {
      if (
        this.memory.ModalRef.componentInstance.name !== "RestreamModalComponent" ||
        !this.memory.ModalRef.componentInstance.started
      ) {
        this.memory.ModalRef.close("close");
      }
      return;
    }

    if (this.memory.currentContextMenu?.menuOpen) {
      this.closeContextMenu();
      return;
    }

    if (this.searchFocused()) {
      this.selectFirstChannel();
      return;
    }

    if (this.filters?.query) {
      this.clearSearch();
      await this.load();
      this.selectFirstChannelDelayed(100);
      return;
    }

    if (this.nodeStack.hasNodes()) {
      await this.goBack();
      this.selectFirstChannelDelayed(100);
      return;
    }

    this.selectFirstChannel();
  }

  selectFirstChannelDelayed(milliseconds: number) {
    setTimeout(() => this.selectFirstChannel(), milliseconds);
  }

  async goBack() {
    const node = this.nodeStack.pop();
    if (node.type === NodeType.Category) this.filters!.group_id = undefined;
    else if (node.type === NodeType.Series) {
      this.filters!.series_id = undefined;
      this.filters!.source_ids = Array.from(this.memory.Sources.keys());
    } else if (node.type === NodeType.Season) {
      this.filters!.season = undefined;
    }

    if (node.query) {
      this.search.nativeElement.value = node.query;
      this.filters!.query = node.query;
    }

    if (node.fromViewType && this.filters!.view_type !== node.fromViewType) {
      this.filters!.view_type = node.fromViewType;
    }

    await this.load();
  }

  openSettings() {
    if (this.memory.IsDemoMode) {
      this.toast.info("Settings stay available in the desktop app. Demo mode keeps the focus on the catalog preview.");
      return;
    }
    this.router.navigateByUrl("settings");
  }

  async nav(key: string) {
    if (this.searchFocused()) return;
    const lowSize = this.currentWindowSize < 768;
    if (this.memory.currentContextMenu?.menuOpen || this.memory.ModalRef) {
      return;
    }

    let tmpFocus = 0;
    switch (key) {
      case "ArrowUp":
        tmpFocus -= 3;
        break;
      case "ArrowDown":
        tmpFocus += 3;
        break;
      case "ShiftTab":
      case "ArrowLeft":
        tmpFocus -= 1;
        break;
      case "Tab":
      case "ArrowRight":
        tmpFocus += 1;
        break;
    }

    const goOverSize = this.shortFiltersMode() ? 1 : 2;
    if (lowSize && tmpFocus % 3 === 0 && this.focusArea === FocusArea.Tiles) tmpFocus /= 3;
    tmpFocus += this.focus;

    if (tmpFocus < 0) {
      this.changeFocusArea(false);
    } else if (tmpFocus > goOverSize && this.focusArea === FocusArea.Filters) {
      this.changeFocusArea(true);
    } else if (tmpFocus > 4 && this.focusArea === FocusArea.ViewMode) {
      this.changeFocusArea(true);
    } else if (
      this.focusArea === FocusArea.Tiles &&
      tmpFocus >= this.filters!.page * this.PAGE_SIZE &&
      !this.reachedMax
    ) {
      await this.loadMore();
    } else {
      if (tmpFocus >= this.channels.length && this.focusArea === FocusArea.Tiles) {
        tmpFocus = (this.channels.length === 0 ? 1 : this.channels.length) - 1;
      }
      this.focus = tmpFocus;
      setTimeout(() => {
        document.getElementById(`${FocusAreaPrefix[this.focusArea]}${this.focus}`)?.focus();
      }, 0);
    }
  }

  shortFiltersMode() {
    return this.filters?.source_ids.findIndex((x) => this.memory.XtreamSourceIds.has(x)) === -1;
  }

  anyXtream() {
    return (
      Array.from(this.memory.Sources.values()).findIndex(
        (x) => x.source_type === SourceType.Xtream,
      ) !== -1
    );
  }

  changeFocusArea(down: boolean) {
    const increment = down ? 1 : -1;
    this.focusArea += increment;
    if (this.focusArea === FocusArea.Filters && !this.filtersVisible()) this.focusArea += increment;
    if (this.focusArea < 0) this.focusArea = 0;
    this.applyFocusArea(down);
  }

  applyFocusArea(down: boolean) {
    this.focus = down
      ? 0
      : this.focusArea === FocusArea.Filters
        ? this.shortFiltersMode()
          ? 1
          : 2
        : 4;
    const id = FocusAreaPrefix[this.focusArea] + this.focus;
    document.getElementById(id)?.focus();
  }

  // Temporary solution because the ng-keyboard-shortcuts library doesn't seem to support ESC
  @HostListener("document:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent) {
    if (
      event.key === "Escape" ||
      event.key === "BrowserBack" ||
      (event.key === "Backspace" && !isInputFocused())
    ) {
      this.goBackHotkey();
      event.preventDefault();
    }
    if (event.key === "Tab" && !this.memory.ModalRef) {
      event.preventDefault();
      this.nav(event.shiftKey ? "ShiftTab" : "Tab");
    }
    if (event.key === "Enter" && this.focusArea === FocusArea.Filters) {
      (document.activeElement as HTMLElement | null)?.click();
    }
  }

  selectFirstChannel() {
    this.focusArea = FocusArea.Tiles;
    this.focus = 0;
    (document.getElementById("first")?.firstChild as HTMLElement | null)?.focus();
  }

  closeContextMenu() {
    if (this.memory.currentContextMenu?.menuOpen) {
      this.memory.currentContextMenu.closeMenu();
    }
  }

  ngOnDestroy() {
    this.subscriptions.forEach((x) => x.unsubscribe());
  }

  async toggleKeywords() {
    this.filters!.use_keywords = !this.filters!.use_keywords;
    await this.load();
  }

  async bulkAction(action: BulkActionType) {
    if (this.filters?.series_id && !this.filters?.season) {
      return;
    }

    const actionName = BulkActionType[action].toLowerCase();
    try {
      await invoke("bulk_update", { filters: this.filters, action });
      await this.load();
      this.toast.success(`Successfully executed bulk update: ${actionName}`);
    } catch (e) {
      this.error.handleError(e);
    }
  }
}
