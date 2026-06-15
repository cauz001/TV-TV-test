use std::collections::HashMap;
use std::path::Path;

use crate::media_type;
use crate::types::ChannelHttpHeaders;
use crate::types::CustomChannel;
use crate::types::ExportedGroup;
use crate::types::ExportedSource;
use crate::types::Group;
use crate::types::Season;
use crate::types::Source;
use crate::utils::serialize_to_file;
use crate::{sql, types::Channel};
use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use rusqlite::Transaction;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedCatalog {
    source: ImportedCatalogSource,
    #[serde(default, alias = "headers")]
    default_headers: Option<ChannelHttpHeaders>,
    #[serde(default)]
    items: Vec<ImportedCatalogItem>,
}

#[derive(Debug, Deserialize)]
struct ImportedCatalogSource {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedCatalogItem {
    name: String,
    #[serde(rename = "type", alias = "kind")]
    item_type: String,
    url: Option<String>,
    image: Option<String>,
    group: Option<String>,
    favorite: Option<bool>,
    tv_archive: Option<bool>,
    hidden: Option<bool>,
    headers: Option<ChannelHttpHeaders>,
    #[serde(default)]
    seasons: Vec<ImportedCatalogSeason>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedCatalogSeason {
    number: i64,
    name: Option<String>,
    image: Option<String>,
    #[serde(default)]
    episodes: Vec<ImportedCatalogEpisode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedCatalogEpisode {
    name: Option<String>,
    number: Option<i64>,
    url: String,
    image: Option<String>,
    favorite: Option<bool>,
    hidden: Option<bool>,
    headers: Option<ChannelHttpHeaders>,
}

pub fn share_custom_channel(channel: Channel, path: String) -> Result<()> {
    let channel = get_custom_channel(channel)?;
    serialize_to_file(channel, path)
}

fn get_custom_channel(channel: Channel) -> Result<CustomChannel> {
    Ok(CustomChannel {
        headers: sql::get_channel_headers_by_id(channel.id.context("No id on channel?")?)?,
        data: channel,
    })
}

pub fn share_custom_group(group: Channel, path: String) -> Result<()> {
    let to_export = ExportedGroup {
        group: Group {
            id: group.id,
            image: group.image,
            name: group.name,
            source_id: None,
            hidden: Some(false),
        },
        channels: sql::get_custom_channels(group.id, group.source_id.context("no source id?")?)?,
    };
    serialize_to_file(to_export, path)
}

pub fn share_custom_source(mut source: Source, path: String) -> Result<()> {
    let id = source.id.context("No source id?")?.clone();
    source.id = None;
    let to_export = ExportedSource {
        source,
        groups: sql::get_custom_groups(id)?,
        channels: sql::get_custom_channels(None, id)?,
    };
    serialize_to_file(to_export, path)?;
    Ok(())
}

pub fn import(path: String, source_id: Option<i64>, name_override: Option<String>) -> Result<()> {
    let data = std::fs::read_to_string(&path)?;
    let extension = Path::new(&path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .context("Invalid path, no extension")?;

    match extension.as_str() {
        "otv" => import_channel(data, source_id.context("No source id")?, name_override),
        "otvg" => import_group(data, source_id.context("No source id")?, name_override),
        "otvp" => import_playlist(data, name_override),
        "json" => import_catalog(data, source_id, name_override),
        _ => Err(anyhow::anyhow!("Invalid path")),
    }
}

fn import_channel(data: String, source_id: i64, name_override: Option<String>) -> Result<()> {
    let mut data: CustomChannel = serde_json::from_str(&data)?;
    if let Some(name) = name_override {
        data.data.name = name;
    }
    if sql::channel_exists(
        &data.data.name,
        data.data.url.as_ref().context("No channel url")?,
        source_id,
    )? {
        bail!("Duplicate exists");
    }
    data.data.source_id = Some(source_id);
    sql::do_tx(|tx| {
        sql::add_custom_channel(tx, data)?;
        sql::analyze(tx)?;
        Ok(())
    })?;
    Ok(())
}

fn import_group(data: String, source_id: i64, name_override: Option<String>) -> Result<()> {
    let mut data: ExportedGroup = serde_json::from_str(&data)?;
    if let Some(name) = name_override {
        data.group.name = name;
    }
    if sql::group_exists(&data.group.name, source_id)? {
        bail!("Duplicate exists");
    }
    sql::do_tx(|tx| {
        data.group.source_id = Some(source_id);
        let group_id = sql::add_custom_group(&tx, data.group)?;
        for mut channel in data.channels {
            channel.data.group_id = Some(group_id);
            channel.data.source_id = Some(source_id);
            sql::add_custom_channel(&tx, channel)?;
        }
        sql::analyze(&tx)?;
        Ok(())
    })?;
    Ok(())
}

fn import_playlist(data: String, name_override: Option<String>) -> Result<()> {
    let mut data: ExportedSource = serde_json::from_str(&data)?;
    if let Some(name) = name_override {
        data.source.name = name;
    }
    if sql::source_name_exists(&data.source.name)? {
        bail!("Duplicate exists");
    }
    sql::do_tx(|tx| {
        let source_id = sql::create_or_find_source_by_name(tx, &data.source)?;
        for mut group in data.groups {
            group.group.source_id = Some(source_id);
            let group_id = sql::add_custom_group(&tx, group.group)?;
            for mut channel in group.channels {
                channel.data.group_id = Some(group_id);
                channel.data.source_id = Some(source_id);
                sql::add_custom_channel(tx, channel)?;
            }
        }
        for mut channel in data.channels {
            channel.data.source_id = Some(source_id);
            sql::add_custom_channel(&tx, channel)?;
        }
        sql::analyze(&tx)?;
        Ok(())
    })?;
    Ok(())
}

fn import_catalog(
    data: String,
    source_id: Option<i64>,
    name_override: Option<String>,
) -> Result<()> {
    let mut catalog: ImportedCatalog = serde_json::from_str(&data)?;
    if let Some(name) = name_override {
        catalog.source.name = name;
    }

    let source_name = require_text(catalog.source.name, "Source name")?;
    if catalog.items.is_empty() {
        bail!("Catalog does not contain any items");
    }

    if source_id.is_none() && sql::source_name_exists(&source_name)? {
        bail!("Duplicate exists");
    }

    sql::do_tx(|tx| {
        let source_id = match source_id {
            Some(source_id) => source_id,
            None => {
                let source = sql::get_custom_source(source_name.clone());
                sql::create_or_find_source_by_name(tx, &source)?
            }
        };

        let mut groups = HashMap::new();
        for item in catalog.items {
            import_catalog_item(tx, source_id, &mut groups, &catalog.default_headers, item)?;
        }

        sql::analyze(tx)?;
        Ok(())
    })?;

    Ok(())
}

fn import_catalog_item(
    tx: &Transaction,
    source_id: i64,
    groups: &mut HashMap<String, i64>,
    default_headers: &Option<ChannelHttpHeaders>,
    item: ImportedCatalogItem,
) -> Result<()> {
    let media_type =
        parse_media_type(&item.item_type).with_context(|| format!("Invalid type on {}", item.name))?;

    let ImportedCatalogItem {
        name,
        item_type: _,
        url,
        image,
        group,
        favorite,
        tv_archive,
        hidden,
        headers,
        seasons,
    } = item;

    if media_type == media_type::SERIE {
        return import_series_item(
            tx,
            source_id,
            groups,
            default_headers,
            ImportedCatalogItem {
                name,
                item_type: "series".to_string(),
                url,
                image,
                group,
                favorite,
                tv_archive,
                hidden,
                headers,
                seasons,
            },
        );
    }

    if !seasons.is_empty() {
        bail!("Only series items can include seasons");
    }

    let item_name = require_text(name, "Item name")?;
    let group = normalize_optional_text(group);
    let url = require_optional_text(url, &format!("Missing URL for {}", item_name))?;
    let headers = merge_headers(default_headers, headers);
    let hidden = hidden.unwrap_or(false);

    let mut channel = Channel {
        id: None,
        name: item_name,
        url: Some(url),
        group,
        image: normalize_optional_text(image),
        media_type,
        source_id: Some(source_id),
        series_id: None,
        group_id: None,
        favorite: favorite.unwrap_or(false),
        stream_id: None,
        tv_archive: if media_type == media_type::LIVESTREAM {
            Some(tv_archive.unwrap_or(false))
        } else {
            None
        },
        season_id: None,
        episode_num: None,
        hidden: Some(hidden),
    };

    sql::set_channel_group_id(groups, &mut channel, tx, &source_id)?;
    sql::add_custom_channel(tx, CustomChannel { data: channel, headers })?;
    Ok(())
}

fn import_series_item(
    tx: &Transaction,
    source_id: i64,
    groups: &mut HashMap<String, i64>,
    default_headers: &Option<ChannelHttpHeaders>,
    item: ImportedCatalogItem,
) -> Result<()> {
    let ImportedCatalogItem {
        name,
        item_type: _,
        url: _,
        image,
        group,
        favorite,
        tv_archive: _,
        hidden,
        headers,
        seasons,
    } = item;

    if seasons.is_empty() {
        bail!("Series items must include at least one season");
    }

    let item_name = require_text(name, "Series name")?;
    let group = normalize_optional_text(group);
    let image = normalize_optional_text(image);
    let series_id = stable_series_id(source_id, group.as_deref(), &item_name);
    let item_headers = merge_headers(default_headers, headers);
    let hidden = hidden.unwrap_or(false);

    let mut series_channel = Channel {
        id: None,
        name: item_name.clone(),
        url: Some(series_id.to_string()),
        group: group.clone(),
        image: image.clone(),
        media_type: media_type::SERIE,
        source_id: Some(source_id),
        series_id: None,
        group_id: None,
        favorite: favorite.unwrap_or(false),
        stream_id: None,
        tv_archive: None,
        season_id: None,
        episode_num: None,
        hidden: Some(hidden),
    };

    sql::set_channel_group_id(groups, &mut series_channel, tx, &source_id)?;
    sql::add_custom_channel(
        tx,
        CustomChannel {
            data: series_channel,
            headers: item_headers.clone(),
        },
    )?;

    for season in seasons {
        let ImportedCatalogSeason {
            number,
            name,
            image: season_image_override,
            episodes,
        } = season;

        let season_name = name
            .map(|name| require_text(name, "Season name"))
            .transpose()?
            .unwrap_or_else(|| format!("Season {}", number));
        let season_image = normalize_optional_text(season_image_override).or_else(|| image.clone());
        let season_id_db = sql::insert_season(
            tx,
            Season {
                id: None,
                name: season_name,
                season_number: number,
                image: season_image.clone(),
                series_id: series_id as u64,
                source_id,
            },
        )?;

        for (index, episode) in episodes.into_iter().enumerate() {
            let ImportedCatalogEpisode {
                name,
                number,
                url,
                image: episode_image,
                favorite,
                hidden: episode_hidden,
                headers,
            } = episode;

            let episode_number = number.unwrap_or(index as i64 + 1);
            let episode_name = name
                .map(|name| require_text(name, "Episode name"))
                .transpose()?
                .unwrap_or_else(|| format!("Episode {}", episode_number));
            let episode_url = require_text(url, "Episode URL")?;
            let episode_headers = merge_headers(&item_headers, headers);

            let mut episode_channel = Channel {
                id: None,
                name: episode_name,
                url: Some(episode_url),
                group: group.clone(),
                image: normalize_optional_text(episode_image)
                    .or_else(|| season_image.clone())
                    .or_else(|| image.clone()),
                media_type: media_type::MOVIE,
                source_id: Some(source_id),
                series_id: Some(series_id as u64),
                group_id: None,
                favorite: favorite.unwrap_or(false),
                stream_id: None,
                tv_archive: None,
                season_id: Some(season_id_db),
                episode_num: Some(episode_number),
                hidden: Some(episode_hidden.unwrap_or(hidden)),
            };

            sql::set_channel_group_id(groups, &mut episode_channel, tx, &source_id)?;
            sql::add_custom_channel(
                tx,
                CustomChannel {
                    data: episode_channel,
                    headers: episode_headers,
                },
            )?;
        }
    }

    Ok(())
}

fn parse_media_type(item_type: &str) -> Result<u8> {
    match item_type.trim().to_ascii_lowercase().as_str() {
        "live" | "livestream" | "channel" | "tv" => Ok(media_type::LIVESTREAM),
        "movie" | "vod" | "film" => Ok(media_type::MOVIE),
        "series" | "serie" | "show" => Ok(media_type::SERIE),
        _ => bail!("Unsupported item type"),
    }
}

fn require_text(value: String, field: &str) -> Result<String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        bail!("{field} is required");
    }
    Ok(value)
}

fn require_optional_text(value: Option<String>, error_message: &str) -> Result<String> {
    value.map(|value| require_text(value, error_message))
        .transpose()?
        .context(error_message.to_string())
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn merge_headers(
    default_headers: &Option<ChannelHttpHeaders>,
    override_headers: Option<ChannelHttpHeaders>,
) -> Option<ChannelHttpHeaders> {
    let merged = ChannelHttpHeaders {
        id: None,
        channel_id: None,
        referrer: override_headers
            .as_ref()
            .and_then(|headers| normalize_optional_text(headers.referrer.clone()))
            .or_else(|| {
                default_headers
                    .as_ref()
                    .and_then(|headers| normalize_optional_text(headers.referrer.clone()))
            }),
        user_agent: override_headers
            .as_ref()
            .and_then(|headers| normalize_optional_text(headers.user_agent.clone()))
            .or_else(|| {
                default_headers
                    .as_ref()
                    .and_then(|headers| normalize_optional_text(headers.user_agent.clone()))
            }),
        http_origin: override_headers
            .as_ref()
            .and_then(|headers| normalize_optional_text(headers.http_origin.clone()))
            .or_else(|| {
                default_headers
                    .as_ref()
                    .and_then(|headers| normalize_optional_text(headers.http_origin.clone()))
            }),
        ignore_ssl: override_headers
            .as_ref()
            .and_then(|headers| headers.ignore_ssl)
            .or_else(|| default_headers.as_ref().and_then(|headers| headers.ignore_ssl)),
    };

    if merged.referrer.is_none()
        && merged.user_agent.is_none()
        && merged.http_origin.is_none()
        && merged.ignore_ssl.is_none()
    {
        None
    } else {
        Some(merged)
    }
}

fn stable_series_id(source_id: i64, group: Option<&str>, name: &str) -> i64 {
    let key = format!(
        "{}::{}::{}",
        source_id,
        group.unwrap_or("").trim().to_ascii_lowercase(),
        name.trim().to_ascii_lowercase(),
    );

    let mut hash: u64 = 14_695_981_039_346_656_037;
    for byte in key.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(1_099_511_628_211);
    }

    ((hash & 0x1F_FFFF_FFFF_FFFF) as i64).max(1)
}
