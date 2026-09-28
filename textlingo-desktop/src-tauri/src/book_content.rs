use crate::types::Article;
use quick_xml::{events::Event, Reader};
use regex::Regex;
use std::{collections::HashMap, fs::File, io::Read, path::Path};
use zip::ZipArchive;

const LEGACY_EPUB_PLACEHOLDER_PREFIX: &str = "[EPUB 书籍]";
const MAX_EPUB_METADATA_BYTES: u64 = 4 * 1024 * 1024;
const MAX_EPUB_CHAPTER_BYTES: u64 = 16 * 1024 * 1024;
const MAX_EPUB_TEXT_CHARS: usize = 4_000_000;

#[derive(Debug)]
struct ManifestItem {
    id: String,
    href: String,
    media_type: String,
}

pub fn resolve_mind_map_content(article: &Article) -> Result<String, String> {
    let is_epub = article.book_type.as_deref() == Some("epub");
    let stored_content = article.content.trim();
    let needs_extraction = is_epub
        && (stored_content.is_empty()
            || stored_content.starts_with(LEGACY_EPUB_PLACEHOLDER_PREFIX));

    if !needs_extraction {
        return Ok(article.content.clone());
    }

    let book_path = article
        .book_path
        .as_deref()
        .ok_or_else(|| "Cannot generate mind map: EPUB file path is missing".to_string())?;

    extract_epub_text(Path::new(book_path)).map_err(|error| {
        format!(
            "Cannot generate mind map: failed to extract EPUB text from {}: {}",
            book_path, error
        )
    })
}

fn extract_epub_text(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("could not open file: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("invalid EPUB archive: {error}"))?;

    let container_xml = read_archive_text(
        &mut archive,
        "META-INF/container.xml",
        MAX_EPUB_METADATA_BYTES,
    )?;
    let package_path = parse_package_path(&container_xml)
        .ok_or_else(|| "META-INF/container.xml has no rootfile path".to_string())?;
    let package_path = normalize_archive_path("", &package_path)?;
    let package_xml = read_archive_text(&mut archive, &package_path, MAX_EPUB_METADATA_BYTES)?;
    let (manifest, spine) = parse_package_document(&package_xml);

    if manifest.is_empty() {
        return Err("EPUB package manifest is empty".to_string());
    }

    let package_dir = package_path
        .rsplit_once('/')
        .map(|(directory, _)| directory)
        .unwrap_or("");
    let manifest_by_id: HashMap<&str, &ManifestItem> = manifest
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    let ordered_items: Vec<&ManifestItem> = if spine.is_empty() {
        manifest.iter().filter(|item| is_html_item(item)).collect()
    } else {
        spine
            .iter()
            .filter_map(|id| manifest_by_id.get(id.as_str()).copied())
            .filter(|item| is_html_item(item))
            .collect()
    };

    if ordered_items.is_empty() {
        return Err("EPUB package spine contains no readable HTML documents".to_string());
    }

    let mut content = String::new();
    let mut content_chars = 0;
    for item in ordered_items {
        let entry_path = normalize_archive_path(package_dir, &item.href)?;
        let html = read_archive_text(&mut archive, &entry_path, MAX_EPUB_CHAPTER_BYTES)?;
        let text = html_document_to_text(&html);
        if !text.is_empty() {
            let text_chars = text.chars().count();
            let separator_chars = if content.is_empty() { 0 } else { 2 };
            if content_chars + separator_chars + text_chars > MAX_EPUB_TEXT_CHARS {
                return Err(format!(
                    "EPUB text exceeds the supported size of {MAX_EPUB_TEXT_CHARS} characters"
                ));
            }
            if !content.is_empty() {
                content.push_str("\n\n");
            }
            content.push_str(&text);
            content_chars += separator_chars + text_chars;
        }
    }

    if content.trim().is_empty() {
        return Err("EPUB reading order contains no extractable text".to_string());
    }

    Ok(content)
}

fn read_archive_text(
    archive: &mut ZipArchive<File>,
    name: &str,
    max_bytes: u64,
) -> Result<String, String> {
    let entry = archive
        .by_name(name)
        .map_err(|error| format!("missing archive entry {name}: {error}"))?;
    if entry.size() > max_bytes {
        return Err(format!(
            "archive entry {name} exceeds the supported size of {max_bytes} bytes"
        ));
    }
    let mut bytes = Vec::new();
    entry
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read archive entry {name}: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "archive entry {name} exceeds the supported size of {max_bytes} bytes"
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn parse_package_path(container_xml: &str) -> Option<String> {
    let mut reader = Reader::from_str(container_xml);
    reader.config_mut().trim_text(true);

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if local_name(element.name().as_ref()) == b"rootfile" =>
            {
                if let Some(path) = attribute_value(&element, b"full-path") {
                    return Some(path);
                }
            }
            Ok(Event::Eof) | Err(_) => return None,
            _ => {}
        }
    }
}

fn parse_package_document(package_xml: &str) -> (Vec<ManifestItem>, Vec<String>) {
    let mut reader = Reader::from_str(package_xml);
    reader.config_mut().trim_text(true);
    let mut manifest = Vec::new();
    let mut spine = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                match local_name(element.name().as_ref()) {
                    b"item" => {
                        let id = attribute_value(&element, b"id");
                        let href = attribute_value(&element, b"href");
                        let media_type = attribute_value(&element, b"media-type");
                        if let (Some(id), Some(href), Some(media_type)) = (id, href, media_type) {
                            manifest.push(ManifestItem {
                                id,
                                href,
                                media_type,
                            });
                        }
                    }
                    b"itemref" => {
                        let linear = attribute_value(&element, b"linear");
                        if linear.as_deref() != Some("no") {
                            if let Some(idref) = attribute_value(&element, b"idref") {
                                spine.push(idref);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    (manifest, spine)
}

fn attribute_value(element: &quick_xml::events::BytesStart<'_>, name: &[u8]) -> Option<String> {
    element
        .attributes()
        .with_checks(false)
        .flatten()
        .find(|attribute| local_name(attribute.key.as_ref()) == name)
        .and_then(|attribute| {
            std::str::from_utf8(attribute.value.as_ref())
                .ok()
                .map(|value| html_escape::decode_html_entities(value).into_owned())
        })
}

fn local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn is_html_item(item: &ManifestItem) -> bool {
    matches!(
        item.media_type.as_str(),
        "application/xhtml+xml" | "text/html"
    )
}

fn normalize_archive_path(base_dir: &str, href: &str) -> Result<String, String> {
    let href = href.split(['#', '?']).next().unwrap_or("").trim();
    let decoded = urlencoding::decode(href)
        .map_err(|error| format!("invalid percent-encoding in EPUB path {href}: {error}"))?;
    let decoded = decoded.replace('\\', "/");
    let mut parts: Vec<&str> = if decoded.starts_with('/') {
        Vec::new()
    } else {
        base_dir
            .split('/')
            .filter(|part| !part.is_empty())
            .collect()
    };

    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(format!("EPUB path escapes archive root: {href}"));
                }
            }
            value => parts.push(value),
        }
    }

    if parts.is_empty() {
        return Err(format!("EPUB path is empty: {href}"));
    }

    Ok(parts.join("/"))
}

fn html_document_to_text(html: &str) -> String {
    let unsafe_blocks = Regex::new(
        r"(?is)<script\b[^>]*>.*?</script\s*>|<style\b[^>]*>.*?</style\s*>|<svg\b[^>]*>.*?</svg\s*>",
    )
    .expect("valid EPUB cleanup regex");
    let cleaned = unsafe_blocks.replace_all(html, " ");
    let normalized = cleaned.replace(['\r', '\n'], " ");
    let line_breaks = Regex::new(r"(?i)<br\s*/?>")
        .expect("valid line break regex")
        .replace_all(&normalized, "\n");
    let block_starts = Regex::new(
        r"(?i)<(article|aside|blockquote|div|figcaption|figure|h[1-6]|li|main|ol|p|pre|section|table|tr|ul)\b[^>]*>",
    )
    .expect("valid block start regex")
    .replace_all(&line_breaks, "\n");
    let block_ends = Regex::new(
        r"(?i)</(article|aside|blockquote|div|figcaption|figure|h[1-6]|li|main|ol|p|pre|section|table|tr|ul)\s*>",
    )
    .expect("valid block end regex")
    .replace_all(&block_starts, "\n");
    let without_tags = Regex::new(r"<[^>]*>")
        .expect("valid tag regex")
        .replace_all(&block_ends, "");
    let decoded = html_escape::decode_html_entities(&without_tags);

    decoded
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// A book split into chapters for sync (mirrors apps/web/src/lib/books.ts).
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedBook {
    pub title: String,
    pub author: Option<String>,
    pub language: Option<String>,
    /// "epub" | "txt"
    pub format: String,
    pub chapters: Vec<ParsedChapter>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedChapter {
    pub title: String,
    pub text: String,
}

/// Chapter records must stay well under the 512 KB inline payload limit.
pub const MAX_CHAPTER_CHARS: usize = 60_000;

fn chapter_heading_regex() -> Regex {
    Regex::new(r"^\s*(第[0-9０-９零〇一二三四五六七八九十百千两]+[章回节卷集部篇]|序章|序言|楔子|终章|尾声|后记|番外|Chapter\s+\d+|CHAPTER\s+[0-9IVXLC]+|Prologue|Epilogue)[^\n]{0,40}$")
        .expect("valid chapter heading regex")
}

pub fn split_oversized(chapters: Vec<ParsedChapter>) -> Vec<ParsedChapter> {
    let mut out = Vec::new();
    for ch in chapters {
        if ch.text.chars().count() <= MAX_CHAPTER_CHARS {
            out.push(ch);
            continue;
        }
        let mut buf: Vec<&str> = Vec::new();
        let mut size = 0usize;
        let mut part = 1;
        let mut parts: Vec<ParsedChapter> = Vec::new();
        for p in ch.text.split('\n').filter(|p| !p.is_empty()) {
            let len = p.chars().count();
            if size + len > MAX_CHAPTER_CHARS && !buf.is_empty() {
                parts.push(ParsedChapter { title: format!("{} ({})", ch.title, part), text: buf.join("\n") });
                part += 1;
                buf.clear();
                size = 0;
            }
            buf.push(p);
            size += len + 1;
        }
        if !buf.is_empty() {
            parts.push(ParsedChapter { title: format!("{} ({})", ch.title, part), text: buf.join("\n") });
        }
        out.extend(parts);
    }
    out
}

/// TXT: split on chapter headings (第X章 / Chapter N / 序章 …).
pub fn parse_txt_book(text: &str, title: &str) -> ParsedBook {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n").replace('\r', "\n");
    let heading = chapter_heading_regex();
    let mut chapters: Vec<ParsedChapter> = Vec::new();
    let mut current_title = String::new();
    let mut body: Vec<&str> = Vec::new();
    let push = |t: &str, body: &mut Vec<&str>, chapters: &mut Vec<ParsedChapter>| {
        let joined = body.join("\n").trim().to_string();
        body.clear();
        if !joined.is_empty() || !t.is_empty() {
            chapters.push(ParsedChapter { title: t.to_string(), text: joined });
        }
    };
    for line in text.split('\n') {
        if heading.is_match(line) {
            push(&current_title, &mut body, &mut chapters);
            current_title = line.trim().to_string();
        } else {
            body.push(line);
        }
    }
    push(&current_title, &mut body, &mut chapters);
    let named: Vec<ParsedChapter> = chapters
        .into_iter()
        .enumerate()
        .map(|(i, c)| ParsedChapter {
            title: if c.title.is_empty() {
                if i == 0 { title.to_string() } else { format!("#{}", i + 1) }
            } else {
                c.title
            },
            text: c.text,
        })
        .filter(|c| !c.text.is_empty())
        .collect();
    let chapters = if named.is_empty() {
        vec![ParsedChapter { title: title.to_string(), text: text.trim().to_string() }]
    } else {
        named
    };
    ParsedBook {
        title: title.to_string(),
        author: None,
        language: None,
        format: "txt".into(),
        chapters: split_oversized(chapters),
    }
}

fn first_capture(re: &str, text: &str) -> Option<String> {
    Regex::new(re)
        .ok()?
        .captures(text)
        .and_then(|c| c.get(1))
        .map(|m| html_escape::decode_html_entities(m.as_str().trim()).into_owned())
        .map(|s| Regex::new(r"<[^>]*>").map(|r| r.replace_all(&s, "").trim().to_string()).unwrap_or(s))
        .filter(|s| !s.is_empty())
}

/// EPUB: one chapter per spine HTML document with text; title from h1–h3 or <title>.
pub fn parse_epub_book(path: &Path, fallback_title: &str) -> Result<ParsedBook, String> {
    let file = File::open(path).map_err(|error| format!("could not open file: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("invalid EPUB archive: {error}"))?;
    let container_xml = read_archive_text(&mut archive, "META-INF/container.xml", MAX_EPUB_METADATA_BYTES)?;
    let package_path = parse_package_path(&container_xml)
        .ok_or_else(|| "META-INF/container.xml has no rootfile path".to_string())?;
    let package_path = normalize_archive_path("", &package_path)?;
    let package_xml = read_archive_text(&mut archive, &package_path, MAX_EPUB_METADATA_BYTES)?;
    let (manifest, spine) = parse_package_document(&package_xml);
    let package_dir = package_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let by_id: HashMap<&str, &ManifestItem> = manifest.iter().map(|i| (i.id.as_str(), i)).collect();
    let items: Vec<&ManifestItem> = if spine.is_empty() {
        manifest.iter().filter(|i| is_html_item(i)).collect()
    } else {
        spine.iter().filter_map(|id| by_id.get(id.as_str()).copied()).filter(|i| is_html_item(i)).collect()
    };
    let mut chapters = Vec::new();
    for item in items {
        let Ok(entry) = normalize_archive_path(package_dir, &item.href) else { continue };
        let Ok(html) = read_archive_text(&mut archive, &entry, MAX_EPUB_CHAPTER_BYTES) else { continue };
        let text = html_document_to_text(&html);
        if text.trim().is_empty() {
            continue;
        }
        let heading = first_capture(r"(?is)<h[1-3]\b[^>]*>(.*?)</h[1-3]\s*>", &html)
            .or_else(|| first_capture(r"(?is)<title\b[^>]*>(.*?)</title\s*>", &html));
        chapters.push(ParsedChapter {
            title: heading.unwrap_or_else(|| format!("#{}", chapters.len() + 1)),
            text,
        });
    }
    if chapters.is_empty() {
        return Err("no readable chapters (image-only or fixed-layout EPUB?)".into());
    }
    Ok(ParsedBook {
        title: first_capture(r"(?is)<dc:title\b[^>]*>(.*?)</dc:title>", &package_xml)
            .unwrap_or_else(|| fallback_title.to_string()),
        author: first_capture(r"(?is)<dc:creator\b[^>]*>(.*?)</dc:creator>", &package_xml),
        language: first_capture(r"(?is)<dc:language\b[^>]*>(.*?)</dc:language>", &package_xml),
        format: "epub".into(),
        chapters: split_oversized(chapters),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_books_split_on_chapter_headings() {
        let book = parse_txt_book("前言文字\n第一章 开始\n正文一\n第二章 继续\n正文二\n", "小说");
        let titles: Vec<&str> = book.chapters.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, vec!["小说", "第一章 开始", "第二章 继续"]);
        assert_eq!(book.chapters[2].text, "正文二");
        let plain = parse_txt_book("no headings here", "T");
        assert_eq!(plain.chapters.len(), 1);
        let big = split_oversized(vec![ParsedChapter { title: "c".into(), text: "x".repeat(40_000) + "\n" + &"y".repeat(40_000) }]);
        assert_eq!(big.len(), 2);
        assert_eq!(big[0].title, "c (1)");
    }

    #[test]
    fn archive_paths_resolve_relative_segments_and_percent_encoding() {
        assert_eq!(
            normalize_archive_path("OEBPS/package", "../Text/chapter%201.xhtml").unwrap(),
            "OEBPS/Text/chapter 1.xhtml"
        );
        assert!(normalize_archive_path("", "../../outside.xhtml").is_err());
    }
}
