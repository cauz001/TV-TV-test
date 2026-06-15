import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
  Renderer2,
  ViewChild,
} from "@angular/core";
import { MatMenuTrigger } from "@angular/material/menu";
import { Channel } from "../models/channel";
import { MemoryService } from "../memory.service";
import { MediaType } from "../models/mediaType";
import { invoke } from "@tauri-apps/api/core";
import { ToastrService } from "ngx-toastr";
import { ErrorService } from "../error.service";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { EditChannelModalComponent } from "../edit-channel-modal/edit-channel-modal.component";
import { EditGroupModalComponent } from "../edit-group-modal/edit-group-modal.component";
import { DeleteGroupModalComponent } from "../delete-group-modal/delete-group-modal.component";
import { EpgModalComponent } from "../epg-modal/epg-modal.component";
import { EPG } from "../models/epg";
import { RestreamModalComponent } from "../restream-modal/restream-modal.component";
import { DownloadService } from "../download.service";
import { Download } from "../models/download";
import { Subscription, take } from "rxjs";
import { save } from "@tauri-apps/plugin-dialog";
import { CHANNEL_EXTENSION, GROUP_EXTENSION, RECORD_EXTENSION } from "../models/extensions";
import { getDateFormatted, getExtension, sanitizeFileName } from "../utils";
import { fromMediaType } from "../models/nodeType";
import { ViewMode } from "../models/viewMode";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

@Component({
  selector: "app-channel-tile",
  templateUrl: "./channel-tile.component.html",
  styleUrl: "./channel-tile.component.css",
})
export class ChannelTileComponent implements OnDestroy, AfterViewInit {
  @Input() channel?: Channel;
  @Input() id!: number;
  @Input() viewMode = 0;
  @Output() highlight = new EventEmitter<Channel>();
  @ViewChild(MatMenuTrigger, { static: true }) matMenuTrigger!: MatMenuTrigger;

  menuTopLeftPosition = { x: 0, y: 0 };
  showImage = true;
  starting = false;
  alreadyExistsInFav = false;
  alreadyHidden = false;
  downloading = false;
  readonly mediaTypeEnum = MediaType;
  readonly viewModeEnum = ViewMode;
  subscriptions: Subscription[] = [];
  fade = false;

  constructor(
    public memory: MemoryService,
    private toastr: ToastrService,
    private error: ErrorService,
    private modal: NgbModal,
    private el: ElementRef,
    private renderer: Renderer2,
    private download: DownloadService,
  ) {}

  ngAfterViewInit(): void {
    this.getExistingDownload();
  }

  setDownloadGradient(progress: number) {
    const element = this.el.nativeElement.querySelector(`#tile-${this.id}`);
    this.renderer.setStyle(element, "--download-progress", `${progress}%`);
  }

  clearDownloadGradient() {
    const element = this.el.nativeElement.querySelector(`#tile-${this.id}`);
    this.renderer.setStyle(element, "--download-progress", "0%");
  }

  emitHighlight() {
    if (this.channel) {
      this.highlight.emit(this.channel);
    }
  }

  async click(record = false) {
    const channel = this.channel;
    const isBrowsableNode =
      channel?.media_type === MediaType.serie ||
      channel?.media_type === MediaType.group ||
      channel?.media_type === MediaType.season;

    if (this.memory.IsDemoMode) {
      this.emitHighlight();
      if (isBrowsableNode) {
        const nodeId = this.getNavigationNodeId();
        if (nodeId === undefined) {
          this.toastr.error("This demo item is missing the navigation metadata needed to open it.");
          return;
        }
        this.memory.SetNode.next({
          id: nodeId,
          name: channel!.name!,
          type: fromMediaType(channel!.media_type!),
          sourceId: channel!.source_id,
        });
        return;
      }
      this.toastr.info(
        "Demo mode preview: connect a real source in the desktop app to play or open full provider data.",
      );
      return;
    }

    if (this.starting === true) {
      try {
        await invoke("cancel_play", {
          sourceId: this.channel?.source_id,
          channelId: this.channel?.id,
        });
      } catch (e) {
        this.error.handleError(e);
      }
      return;
    }

    if (isBrowsableNode) {
      if (
        channel!.media_type === MediaType.serie &&
        this.memory.XtreamSourceIds.has(channel!.source_id!) &&
        !this.memory.SeriesRefreshed.has(channel!.id!)
      ) {
        this.memory.HideChannels.next(false);
        try {
          await invoke("get_episodes", { channel });
          this.memory.SeriesRefreshed.set(channel!.id!, true);
        } catch (e) {
          this.error.handleError(e, "Failed to fetch series");
        }
      }
      const nodeId = this.getNavigationNodeId();
      if (nodeId === undefined) {
        this.toastr.error("This item is missing the data needed to open its nested content.");
        return;
      }
      this.memory.SetNode.next({
        id: nodeId,
        name: channel!.name!,
        type: fromMediaType(channel!.media_type!),
        sourceId: channel!.source_id,
      });
      return;
    }

    let file = undefined;
    if (record && (this.memory.IsContainer || this.memory.AlwaysAskSave)) {
      file = await save({
        canCreateDirectories: true,
        title: "Select where to save recording",
        defaultPath: `${sanitizeFileName(this.channel?.name!)}_${getDateFormatted()}${RECORD_EXTENSION}`,
      });
      if (!file) return;
    }

    this.starting = true;
    this.memory.SetFocus.next(this.id);
    try {
      await invoke("play", { channel: this.channel, record, recordPath: file });
    } catch (e) {
      this.error.handleError(e);
    }
    invoke("add_last_watched", { id: this.channel?.id }).catch((e) => {
      console.error(e);
      this.error.handleError(e);
    });
    this.starting = false;
  }

  onRightClick(event: MouseEvent) {
    if (this.channel?.media_type === MediaType.season) return;
    this.alreadyExistsInFav = this.channel!.favorite!;
    this.alreadyHidden = this.channel!.hidden!;
    this.downloading = this.isDownloading();
    event.preventDefault();
    this.menuTopLeftPosition.x = event.clientX;
    this.menuTopLeftPosition.y = event.clientY;
    if (this.memory.currentContextMenu?.menuOpen) this.memory.currentContextMenu.closeMenu();
    this.memory.currentContextMenu = this.matMenuTrigger;
    this.matMenuTrigger.openMenu();
  }

  onError() {
    this.showImage = false;
  }

  async favorite() {
    if (this.memory.IsDemoMode) {
      this.channel!.favorite = !this.channel!.favorite;
      this.toastr.success(`Updated "${this.channel?.name}" inside the browser demo preview`);
      return;
    }

    let call = "favorite_channel";
    const wasFavorite = this.channel!.favorite;
    let msg = `Added "${this.channel?.name}" to favorites`;
    if (wasFavorite) {
      call = "unfavorite_channel";
      msg = `Removed "${this.channel?.name}" from favorites`;
    }
    try {
      await invoke(call, { channelId: this.channel!.id });
      this.channel!.favorite = !wasFavorite;
      if (wasFavorite) {
        if (this.viewMode === ViewMode.Favorites) this.fade = true;
        this.toastr.success(`${msg} (updates on reload)`);
      } else {
        if (this.viewMode === ViewMode.Favorites) this.fade = false;
        this.toastr.success(msg);
      }
    } catch (e) {
      this.error.handleError(e, `Failed to add/remove "${this.channel?.name}" to/from favorites`);
    }
  }

  async removeFromHistory() {
    try {
      await invoke("remove_from_history", { id: this.channel!.id });
      this.memory.Refresh.next(false);
      this.toastr.success(`Removed "${this.channel?.name}" from history`);
    } catch (e) {
      this.error.handleError(e, `Failed to remove "${this.channel?.name}" from history`);
    }
  }

  async hide() {
    if (this.memory.IsDemoMode) {
      this.channel!.hidden = !this.channel!.hidden;
      this.fade = this.viewMode === ViewMode.Hidden ? !this.channel!.hidden : this.channel!.hidden;
      this.toastr.success(`Updated "${this.channel?.name}" inside the browser demo preview`);
      return;
    }

    const isGroup = this.channel?.media_type === MediaType.group;
    const hide = !this.channel!.hidden;

    const command = isGroup ? "hide_group" : "hide_channel";
    const args = { id: this.channel!.id, hidden: hide };

    const action = hide ? "Hidden" : "Unhidden";
    const type = isGroup ? "group " : "";
    const msg = `${action} ${type}"${this.channel?.name}"`;

    try {
      await invoke(command, args);
      this.channel!.hidden = hide;
      this.fade = this.viewMode === ViewMode.Hidden ? !hide : hide;
      this.toastr.success(`${msg} (updates on reload)`);
    } catch (e) {
      this.error.handleError(e, `Failed to hide/unhide "${this.channel?.name}"`);
    }
  }

  async record() {
    await this.click(true);
  }

  isMovie() {
    return this.channel?.media_type === MediaType.movie;
  }

  isLivestream() {
    return this.channel?.media_type === MediaType.livestream;
  }

  isCustom(): boolean {
    return this.memory.CustomSourceIds!.has(this.channel?.source_id!);
  }

  showEPG(): boolean {
    return (
      this.channel?.media_type === MediaType.livestream &&
      !this.isCustom() &&
      this.memory.XtreamSourceIds.has(this.channel.source_id!)
    );
  }

  getSourceName(): string {
    if (!this.channel?.source_id) return "";
    return this.memory.Sources.get(this.channel.source_id)?.name || "";
  }

  getMediaTypeLabel(): string {
    switch (this.channel?.media_type) {
      case MediaType.livestream:
        return "Live TV";
      case MediaType.movie:
        return "Movie / VOD";
      case MediaType.serie:
        return "Series";
      case MediaType.group:
        return "Collection";
      case MediaType.season:
        return "Season";
      default:
        return "Catalog";
    }
  }

  getInteractionLabel(): string {
    switch (this.channel?.media_type) {
      case MediaType.group:
        return "Open collection";
      case MediaType.serie:
        return "Browse seasons";
      case MediaType.season:
        return "Open season";
      case MediaType.movie:
        return this.downloading ? "Download in progress" : "Play on demand";
      default:
        return this.starting ? "Launching stream..." : "Play instantly";
    }
  }

  getMetaChips(): string[] {
    const chips: string[] = [];

    if (this.channel?.favorite) chips.push("Pinned");
    if (this.channel?.tv_archive) chips.push("Catch-up");
    if (this.isCustom()) chips.push("Custom");

    switch (this.channel?.media_type) {
      case MediaType.group:
        chips.push("Browsable shelf");
        break;
      case MediaType.serie:
        chips.push("Expandable seasons");
        break;
      case MediaType.movie:
        chips.push("Direct playback");
        break;
      case MediaType.livestream:
        chips.push("Instant play");
        break;
    }

    return chips.slice(0, 3);
  }

  getCardInitials(): string {
    const name = this.channel?.name?.trim();
    if (!name) return "TV";
    const initials = name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("");
    return initials || name.slice(0, 2).toUpperCase();
  }

  private getNavigationNodeId(): number | undefined {
    if (!this.channel) return undefined;

    if (this.channel.media_type === MediaType.serie) {
      if (this.channel.series_id !== undefined) {
        return this.channel.series_id;
      }

      const numericId = Number.parseInt(this.channel.url ?? "", 10);
      return Number.isNaN(numericId) ? undefined : numericId;
    }

    return this.channel.id;
  }

  async showEPGModal() {
    try {
      const data: EPG[] = await invoke("get_epg", { channel: this.channel });
      if (data.length === 0) {
        this.toastr.info("No EPG data for this channel");
        return;
      }
      this.memory.ModalRef = this.modal.open(EpgModalComponent, {
        backdrop: "static",
        size: "xl",
        keyboard: false,
      });
      this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
      this.memory.ModalRef.componentInstance.epg = data;
      this.memory.ModalRef.componentInstance.name = this.channel?.name;
      this.memory.ModalRef.componentInstance.channelId = this.channel?.id;
      this.memory.ModalRef.componentInstance.sourceId = this.channel?.source_id;
    } catch (e) {
      this.error.handleError(
        e,
        "Missing stream id. Please refresh your sources (Settings -> Refresh All) to enable the EPG feature",
      );
    }
  }

  edit() {
    if (this.channel?.media_type === MediaType.group) this.editGroup();
    else this.editChannel();
  }

  editGroup() {
    this.memory.ModalRef = this.modal.open(EditGroupModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "EditCustomGroupModal";
    this.memory.ModalRef.componentInstance.editing = true;
    this.memory.ModalRef.componentInstance.group = {
      id: this.channel!.id,
      name: this.channel!.name,
      image: this.channel!.image,
      source_id: this.channel!.source_id,
    };
    this.memory.ModalRef.componentInstance.originalName = this.channel!.name;
  }

  editChannel() {
    this.memory.ModalRef = this.modal.open(EditChannelModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "EditCustomChannelModal";
    this.memory.ModalRef.componentInstance.editing = true;
    this.memory.ModalRef.componentInstance.channel.data = { ...this.channel };
  }

  async share() {
    const entityName = this.channel?.media_type === MediaType.group ? "group" : "channel";
    const file = await save({
      canCreateDirectories: true,
      title: `Select where to export ${entityName}`,
      defaultPath:
        sanitizeFileName(this.channel?.name!) +
        (this.channel?.media_type === MediaType.group ? GROUP_EXTENSION : CHANNEL_EXTENSION),
    });
    if (!file) {
      return;
    }
    if (this.channel?.media_type === MediaType.group) {
      this.memory.tryIPC(
        `Successfully exported category to ${file}`,
        "Failed to export channel",
        () => invoke("share_custom_group", { group: this.channel, path: file }),
      );
    } else {
      this.memory.tryIPC(
        `Successfully exported channel to ${file}`,
        "Failed to export channel",
        () => invoke("share_custom_channel", { channel: this.channel, path: file }),
      );
    }
  }

  async delete() {
    if (this.channel?.media_type === MediaType.group) this.deleteGroup();
    else await this.deleteChannel();
  }

  async deleteGroup() {
    try {
      if (await invoke("group_not_empty", { id: this.channel?.id })) {
        this.openDeleteGroupModal();
      } else {
        await this.deleteGroupNoReplace();
      }
    } catch (e) {
      this.error.handleError(e);
    }
  }

  async deleteGroupNoReplace() {
    try {
      await invoke("delete_custom_group", {
        id: this.channel?.id,
        doChannelsUpdate: false,
      });
      this.memory.Refresh.next(true);
      this.error.success("Successfully deleted category");
    } catch (e) {
      this.error.handleError(e);
    }
  }

  openDeleteGroupModal() {
    this.memory.ModalRef = this.modal.open(DeleteGroupModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "DeleteGroupModal";
    this.memory.ModalRef.componentInstance.group = { ...this.channel };
  }

  openRestreamModal() {
    this.memory.ModalRef = this.modal.open(RestreamModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.componentInstance.channel = this.channel;
    this.memory.ModalRef.componentInstance.name = "RestreamModalComponent";
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
  }

  async deleteChannel() {
    await this.memory.tryIPC("Successfully deleted channel", "Failed to delete channel", () =>
      invoke("delete_custom_channel", { id: this.channel?.id }),
    );
    this.memory.Refresh.next(true);
  }

  isDownloading() {
    return this.download.Downloads.has(this.channel!.id!.toString());
  }

  async downloadVod() {
    let file = undefined;
    if (this.memory.IsContainer || this.memory.AlwaysAskSave) {
      file = await save({
        canCreateDirectories: true,
        title: "Select where to download movie",
        defaultPath: `${sanitizeFileName(this.channel?.name!)}.${getExtension(this.channel?.url!)}`,
      });
      if (!file) {
        return;
      }
    }
    const download = await this.download.addDownload(this.channel!.id!.toString(), this.channel!);
    this.downloadSubscribe(download);
    await this.download.download(download.id, file);
  }

  async cancelDownload() {
    await this.download.abortDownload(this.channel!.id!.toString());
  }

  getExistingDownload() {
    const download = this.download.Downloads.get(this.channel!.id!.toString());
    if (download) {
      this.setDownloadGradient(download.progress);
      this.downloadSubscribe(download);
    }
  }

  downloadSubscribe(download: Download) {
    const progressUpdate = download.progressUpdate.subscribe((progress) => {
      this.setDownloadGradient(progress);
      if (progress === 100) progressUpdate.unsubscribe();
    });
    this.subscriptions.push(progressUpdate);
    this.subscriptions.push(
      download.complete.pipe(take(1)).subscribe((_) => {
        progressUpdate.unsubscribe();
        this.clearDownloadGradient();
      }),
    );
  }

  async copyURL() {
    try {
      await writeText(this.channel?.url ?? "");
      this.error.success("Copied channel URL");
    } catch (e) {
      this.error.handleError(e);
    }
  }

  ngOnDestroy() {
    this.subscriptions.forEach((x) => x.unsubscribe());
  }
}
