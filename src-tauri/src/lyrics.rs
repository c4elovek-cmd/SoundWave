//! Поиск текста песни и таймингов для караоке.
//!
//! Логика повторяет Electron-версию один в один: те же варианты названия,
//! та же оценка совпадений, тот же запасной источник LRCLIB.
//! Genius отдаёт текст без таймингов, LRCLIB — текст с таймингами.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::soundcloud::BROWSER_UA;

const GENIUS_ORIGIN: &str = "https://genius.com";
const GENIUS_TIMEOUT: Duration = Duration::from_secs(12);
const GENIUS_CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const GENIUS_CACHE_LIMIT: usize = 200;

const LRCLIB_API: &str = "https://lrclib.net/api/search";
const LRCLIB_UA: &str = "SoundWave/0.1 (https://github.com/c4elovek-cmd/SoundWave)";
const LRCLIB_TIMEOUT: Duration = Duration::from_secs(10);
const LRCLIB_CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const LRCLIB_CACHE_LIMIT: usize = 200;

/// Признаки перевода на Genius: такие результаты не берём, если артист другой.
const GENIUS_TRANSLATION_MARKERS: [&str; 6] = [
    "translation",
    "translations",
    "romanization",
    "romanizations",
    "перевод",
    "транскрипция",
];

/// Текст песни без таймингов.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlainLyrics {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lyrics: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Откуда взят текст: genius или lrclib.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Трек — версия с изменённым темпом (speed up, slowed и т. п.).
    ///
    /// Тайминги оригинала не подходят: строки караоке разъезжаются со
    /// звуком. Флаг говорит интерфейсу не включать караоке.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tempo_modified: Option<bool>,
}

/// Текст с таймингами строк (LRC).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncedLyrics {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synced_lyrics: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

type Cache = Mutex<HashMap<String, (Value, Instant)>>;

static PLAIN_CACHE: Lazy<Cache> = Lazy::new(|| Mutex::new(HashMap::new()));
static SYNC_CACHE: Lazy<Cache> = Lazy::new(|| Mutex::new(HashMap::new()));

static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(GENIUS_TIMEOUT)
        .build()
        .expect("не удалось собрать HTTP-клиент")
});

static RE_PAREN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\([^()]*\)|\[[^\]]*\]").unwrap());
static RE_NON_WORD: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());
static RE_SPACES: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());
static RE_BR: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)<br\s*/?>").unwrap());
static RE_TAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());
static RE_HEX_ENTITY: Lazy<Regex> = Lazy::new(|| Regex::new(r"&#x([0-9a-fA-F]+);").unwrap());
static RE_DEC_ENTITY: Lazy<Regex> = Lazy::new(|| Regex::new(r"&#(\d+);").unwrap());
static RE_SECTION: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^[ \t]*\[[^\]\n]+\][ \t]*$").unwrap());
static RE_YOU_MIGHT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?im)^[ \t]*You might also like[ \t]*$").unwrap());
static RE_TRAILING_SPACE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[ \t]+\n").unwrap());
static RE_MANY_NEWLINES: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n{3,}").unwrap());
static RE_CURLY: Lazy<Regex> = Lazy::new(|| Regex::new(r"\{[^{}]*\}").unwrap());
static RE_PROD_BY: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bprod\.?\s*by\b.*$").unwrap());
static RE_MIX_TAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bmix\b.*$").unwrap());
static RE_PIPE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[|_]+").unwrap());
static RE_DOUBLE_SPACES: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s{2,}").unwrap());
static RE_DASH_SPLIT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+[-–—]\s+").unwrap());
static RE_TAIL_WORDS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\s*\b(remix|prod|edit|version|live|bootleg|mix|demo)\b.*$").unwrap()
});

/// Приписки, которыми перезаливают трек с изменённым темпом или частотой.
///
/// Для таких версий караоке бессмысленно: LRC ищется по оригиналу, у
/// которого другая длительность, и строки разъезжаются со звуком. Текст
/// при этом ищем как обычно — он нужен.
static RE_TEMPO_MARK: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?ix)
        \s* [\(\[\{]\s*
        (?: speed\s*up | sped\s*up | speedup
          | slowed (?: \s+ (?: and | & | n ) \s* reverb | \s+ down | \s+ \+ )?
          | ultra \s+ slowed
          | super \s+ slowed
          | daycore
          | nightcore
          | reverb
          | bass \s+ boost (?: \s+ ed)?
          | bass \s+ boosted
          | 8d
          | \d+(?:\.\d+)?x
          | \d+\s*%
        )\s* [\)\]\}]
        | \s*\b(?:speed\s*up|sped\s*up|speedup|slowed|nightcore|daycore)\b
        ",
    )
    .unwrap()
});

/// Трек — переработанная версия (speed up, slowed, reverb и т. п.).
///
/// У неё другой темп, поэтому тайминги оригинала не подходят: строки
/// караоке разъезжаются со звуком.
pub fn is_tempo_modified(title: &str) -> bool {
    RE_TEMPO_MARK.is_match(title)
}

/// Название без приписок про темп и частоту.
pub fn strip_tempo_marks(title: &str) -> String {
    let text = RE_TEMPO_MARK.replace_all(title, " ");
    let text = RE_DOUBLE_SPACES.replace_all(&text, " ");
    text.trim().trim_matches(|c| c == '-' || c == '–' || c == '—' || c == '_')
        .trim()
        .to_string()
}

/// Варианты названия без приписок про темп: «speed up» только мешает поиску.
pub fn strip_tempo_marks_all(title: &str) -> String {
    let text = strip_tempo_marks(title);
    if text.is_empty() {
        title.to_string()
    } else {
        text
    }
}
static RE_QUOTED: Lazy<Regex> = Lazy::new(|| Regex::new(r#"["'«]([^"'»\n]{2,80})["'»]"#).unwrap());
static RE_LABELLED: Lazy<Regex> = Lazy::new(|| Regex::new(
    r"(?i)(?:original|оригинал|source|lyrics|текст|слова)\s*[:\-—]\s*([^\n]{2,80})",
)
.unwrap());

/// Приводит название и имя артиста к сравнимому виду.
pub fn normalize_text(value: &str) -> String {
    let lowered = value.to_lowercase();
    let without_brackets = RE_PAREN.replace_all(&lowered, " ");
    let only_words = RE_NON_WORD.replace_all(&without_brackets, " ");
    RE_SPACES.replace_all(&only_words, " ").trim().to_string()
}

/// Декодирует HTML-сущности, которые Genius использует в текстах.
pub fn decode_html_entities(text: &str) -> String {
    let text = RE_HEX_ENTITY.replace_all(text, |caps: &regex::Captures| {
        match u32::from_str_radix(&caps[1], 16).ok().and_then(char::from_u32) {
            Some(ch) => ch.to_string(),
            None => String::new(),
        }
    });

    let text = RE_DEC_ENTITY.replace_all(&text, |caps: &regex::Captures| {
        match caps[1].parse::<u32>().ok().and_then(char::from_u32) {
            Some(ch) => ch.to_string(),
            None => String::new(),
        }
    });

    text.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&laquo;", "«")
        .replace("&raquo;", "»")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Вырезает блоки `<div data-lyrics-container="true">…</div>`.
///
/// Внутри контейнера бывают вложенные div, поэтому считаем глубину тегов.
fn extract_genius_lyrics(html: &str) -> String {
    let marker = "data-lyrics-container=\"true\"";
    let mut chunks: Vec<String> = Vec::new();
    let mut from = 0usize;

    while let Some(start) = html[from..].find(marker) {
        let start = from + start;
        let Some(tag_start) = html[..start].rfind("<div") else {
            break;
        };

        let mut depth = 0i32;
        let mut i = tag_start;
        let mut end = None;

        while i < html.len() {
            let open = html[i..].find("<div").map(|p| i + p);
            let close = html[i..].find("</div>").map(|p| i + p);

            let Some(close) = close else {
                break;
            };

            match open {
                Some(open) if open < close => {
                    depth += 1;
                    i = open + 4;
                }
                _ => {
                    depth -= 1;
                    i = close + 6;
                    if depth == 0 {
                        end = Some(close + 6);
                        break;
                    }
                }
            }
        }

        let Some(end) = end else {
            break;
        };

        chunks.push(html[tag_start..end].to_string());
        from = end;
    }

    let mut text = chunks.join("\n");
    text = RE_BR.replace_all(&text, "\n").to_string();
    text = RE_TAG.replace_all(&text, "").to_string();
    text = decode_html_entities(&text);

    // Перед текстом Genius печатает «N Contributors… Read More».
    if let Some(first) = RE_SECTION.find(&text) {
        if first.start() > 0 {
            text = text[first.start()..].to_string();
        }
    } else if let Some(read_more) = text.find("Read More") {
        if read_more < 800 {
            if let Some(line_end) = text[read_more..].find('\n') {
                text = text[read_more + line_end + 1..].to_string();
            }
        }
    }

    let text = RE_YOU_MIGHT.replace_all(&text, "");
    let text = RE_TRAILING_SPACE.replace_all(&text, "\n");
    let text = RE_MANY_NEWLINES.replace_all(&text, "\n\n");

    text.trim().to_string()
}

/// Убирает из названия приписки, которыми перезаливают треки.
pub fn clean_title(title: &str) -> String {
    let text = RE_PAREN.replace_all(title, " ");
    let text = RE_CURLY.replace_all(&text, " ");
    let text = RE_PROD_BY.replace_all(&text, " ");
    let text = RE_MIX_TAIL.replace_all(&text, " ");
    let text = RE_PIPE.replace_all(&text, " ");
    let text = RE_DOUBLE_SPACES.replace_all(&text, " ");
    text.trim().to_string()
}

/// Варианты названия: исходное, очищенное, часть после тире и без хвоста.
pub fn title_variants(title: &str) -> Vec<String> {
    let mut variants: Vec<String> = Vec::new();
    let mut add = |value: String| {
        let trimmed = value.trim();
        if trimmed.chars().count() > 1 && !variants.iter().any(|v| v == trimmed) {
            variants.push(trimmed.to_string());
        }
    };

    add(title.to_string());

    let cleaned = clean_title(title);
    add(cleaned.clone());

    // «Артист - Песня»: песня обычно после тире.
    let parts: Vec<&str> = RE_DASH_SPLIT.split(&cleaned).collect();
    if parts.len() > 1 {
        add(parts[parts.len() - 1].to_string());
        add(parts[0].to_string());
    }

    // Хвост вроде «remix», «prod», «live», «bootleg».
    add(RE_TAIL_WORDS.replace_all(&cleaned, "").trim().to_string());

    // «(speed up)», «slowed + reverb» и подобное: версия другого трека,
    // текст тот же, а приписка только мешает поиску.
    add(strip_tempo_marks_all(&cleaned));

    let without_tempo = strip_tempo_marks_all(&cleaned);
    let stripped_parts: Vec<&str> = RE_DASH_SPLIT.split(&without_tempo).collect();
    if stripped_parts.len() > 1 {
        add(stripped_parts[stripped_parts.len() - 1].to_string());
        add(stripped_parts[0].to_string());
    }

    variants
}

/// Варианты имени артиста: без скобок и приписок.
pub fn artist_variants(artist: &str) -> Vec<String> {
    let mut variants: Vec<String> = Vec::new();
    let mut add = |value: String| {
        let trimmed = value.trim();
        if trimmed.chars().count() > 1 && !variants.iter().any(|v| v == trimmed) {
            variants.push(trimmed.to_string());
        }
    };

    add(artist.to_string());
    add(RE_PAREN.replace_all(artist, " ").trim().to_string());

    variants
}

/// Кандидаты названия из описания трека.
fn title_candidates_from_description(description: &str) -> Vec<String> {
    if description.trim().is_empty() {
        return Vec::new();
    }

    let text = description.trim();
    if text.chars().count() > 800 {
        return Vec::new();
    }

    let mut result: Vec<String> = Vec::new();
    let mut add = |value: String| {
        let trimmed = value
            .trim()
            .trim_matches(|c| c == '"' || c == '\'' || c == '«' || c == '»');
        let len = trimmed.chars().count();
        if len > 2 && len < 120 && !result.iter().any(|v| v == trimmed) {
            result.push(trimmed.to_string());
        }
    };

    for caps in RE_QUOTED.captures_iter(text) {
        add(caps[1].to_string());
    }

    for caps in RE_LABELLED.captures_iter(text) {
        add(caps[1].to_string());
    }

    let first_line = text.split('\n').next().unwrap_or("").trim().to_string();
    if !first_line.is_empty()
        && first_line.chars().count() <= 80
        && !first_line.chars().take(40).any(|c| c == '.' || c == '!' || c == '?')
    {
        add(first_line);
    }

    result.truncate(4);
    result
}

/// Два слова отличаются не больше чем на одну опечатку.
///
/// Перезаливы часто содержат опечатки в названии («Офицантка» вместо
/// «Официантка»), и строгое сравнение такие треки не находит. Допускаем
/// одну вставку, удаление или замену символа — но только для слов от пяти
/// букв, иначе «дом» и «дым» станут одним словом.
fn words_similar(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }

    let left: Vec<char> = a.chars().collect();
    let right: Vec<char> = b.chars().collect();
    let (long, short) = if left.len() >= right.len() {
        (&left, &right)
    } else {
        (&right, &left)
    };

    if short.len() < 5 || long.len() - short.len() > 1 {
        return false;
    }

    // Расстояние Левенштейна с ранним выходом: больше одной правки не нужно.
    let mut prev: Vec<usize> = (0..=short.len()).collect();
    let mut current = vec![0usize; short.len() + 1];

    for (i, lc) in long.iter().enumerate() {
        current[0] = i + 1;
        let mut row_min = current[0];

        for (j, sc) in short.iter().enumerate() {
            let cost = usize::from(lc != sc);
            let value = (prev[j] + cost).min(prev[j + 1] + 1).min(current[j] + 1);
            current[j + 1] = value;
            row_min = row_min.min(value);
        }

        if row_min > 1 {
            return false;
        }

        std::mem::swap(&mut prev, &mut current);
    }

    prev[short.len()] <= 1
}

/// Насколько результат поиска похож на нужный трек.
fn score_genius_song(song: &Value, titles: &[String], artists: &[String]) -> i32 {
    let song_title = normalize_text(song.get("title").and_then(|v| v.as_str()).unwrap_or(""));
    let song_artist = normalize_text(
        song.get("primary_artist")
            .and_then(|a| a.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or(""),
    );

    if song_title.is_empty() || song_artist.is_empty() {
        return -100;
    }

    let want_titles: Vec<String> = titles.iter().map(|t| normalize_text(t)).filter(|t| !t.is_empty()).collect();
    let want_artists: Vec<String> = artists.iter().map(|a| normalize_text(a)).filter(|a| !a.is_empty()).collect();

    // Перевод на другой язык — берём только если артист совпал.
    let is_translation = song_artist.starts_with("genius ")
        && GENIUS_TRANSLATION_MARKERS
            .iter()
            .any(|marker| song_artist.contains(marker));
    if is_translation && !want_artists.iter().any(|a| a == &song_artist) {
        return -100;
    }

    let title_score = |want_title: &str| -> i32 {
        if want_title.is_empty() {
            return 0;
        }
        if song_title == want_title {
            return 10;
        }

        let words: Vec<&str> = want_title.split(' ').filter(|w| w.chars().count() > 2).collect();
        if words.is_empty() || want_title.chars().count() < 5 {
            return 0;
        }

        // Название из одного слова («Официантка»): сравниваем с любым словом
        // в названии на Genius — там бывает и перевод в скобках. Поправка на
        // опечатку нужна: в перезаливах название часто искажено.
        if words.len() == 1 {
            let song_words: Vec<&str> = song_title.split(' ').collect();
            let hit = song_words.iter().any(|sw| words_similar(sw, words[0]));
            return if hit { 6 } else { 0 };
        }

        if want_title.chars().count() < 8 {
            return 0;
        }

        if song_title.contains(want_title) || want_title.contains(&song_title) {
            return 6;
        }

        // Сравниваем слова по отдельности: так ловятся опечатки в названии
        // («Офицантка» ↔ «Официантка») и лишние слова с одной стороны.
        let song_words: Vec<&str> = song_title.split(' ').filter(|w| !w.is_empty()).collect();
        let matched = words
            .iter()
            .filter(|w| song_words.iter().any(|sw| words_similar(sw, w)))
            .count();

        if matched >= 2 && matched as f32 / words.len() as f32 >= 0.5 {
            // Полное совпадение по словам (с точностью до опечатки) — почти
            // наверняка та же песня.
            if matched == words.len() && words.len() >= 2 {
                return 6;
            }
            return 3;
        }

        0
    };

    let artist_score = |want_artist: &str| -> i32 {
        if want_artist.is_empty() || song_artist.is_empty() {
            return 0;
        }
        if song_artist == want_artist {
            return 8;
        }
        if song_artist.contains(want_artist) || want_artist.contains(&song_artist) {
            return 4;
        }
        0
    };

    let mut score = 0;
    for want_title in &want_titles {
        score = score.max(title_score(want_title));
    }
    for want_artist in &want_artists {
        score = score.max(artist_score(want_artist));
    }

    score
}

/// Запрос к Genius: JSON для поиска, HTML для страницы песни.
async fn fetch_genius(url: &str, as_json: bool) -> Result<String, String> {
    let mut request = HTTP.get(url);
    request = request.header("Accept-Language", "ru-RU,ru;q=0.9,en;q=0.8");
    request = request.header("Referer", "https://genius.com/");
    request = request.header(
        "Accept",
        if as_json {
            "application/json"
        } else {
            "text/html,application/xhtml+xml"
        },
    );

    let response = request
        .send()
        .await
        .map_err(|e| format!("Genius недоступен: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Genius ответил {}", response.status()));
    }

    response
        .text()
        .await
        .map_err(|e| format!("не удалось прочитать ответ Genius: {e}"))
}

/// Ищет песню на Genius и достаёт из её страницы текст.
async fn find_genius_lyrics(
    title: &str,
    artist: &str,
    description: &str,
) -> PlainLyrics {
    let mut titles = title_variants(title);
    for candidate in title_candidates_from_description(description) {
        if !titles.contains(&candidate) {
            titles.push(candidate);
        }
    }
    let artists = artist_variants(artist);

    let mut queries: Vec<String> = Vec::new();
    let mut add_query = |value: String| {
        let trimmed = value.trim().to_string();
        if !trimmed.is_empty() && !queries.contains(&trimmed) {
            queries.push(trimmed);
        }
    };

    // Чередуем запросы с исполнителем и без него. Ник на SoundCloud часто не
    // совпадает с именем артиста на Genius («nsssive» вместо «Папин
    // Олимпос»), и запрос вместе с ним не находит вообще ничего. Раньше
    // первые четыре запроса были только с исполнителем — и поиск упирался
    // в пустоту.
    for t in &titles {
        for a in &artists {
            add_query(format!("{t} {a}"));
        }
        add_query(t.clone());
    }

    let mut seen: Vec<String> = Vec::new();
    let mut songs: Vec<Value> = Vec::new();

    for query in queries.iter().take(6) {
        let url = format!(
            "{GENIUS_ORIGIN}/api/search/multi?per_page=5&q={}",
            encode_uri_component(query)
        );

        let text = match fetch_genius(&url, true).await {
            Ok(text) => text,
            Err(_) => continue,
        };

        let search: Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let sections = search
            .get("response")
            .and_then(|r| r.get("sections"))
            .and_then(|s| s.as_array());

        if let Some(sections) = sections {
            for section in sections {
                let Some(hits) = section.get("hits").and_then(|h| h.as_array()) else {
                    continue;
                };
                for hit in hits {
                    let Some(song) = hit.get("result") else {
                        continue;
                    };
                    let url = song.get("url").and_then(|v| v.as_str());
                    let title = song.get("title").and_then(|v| v.as_str());
                    if url.is_none() || title.is_none() {
                        continue;
                    }

                    let key = song
                        .get("id")
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| url.unwrap_or_default().to_string());
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.push(key);
                    songs.push(song.clone());
                }
            }
        }

        // Уверенное совпадение найдено — дальше не лезем.
        let best = songs
            .iter()
            .map(|song| score_genius_song(song, &titles, &artists))
            .max()
            .unwrap_or(-100);
        if best >= 13 {
            break;
        }
    }

    let mut ranked: Vec<(i32, Value)> = songs
        .iter()
        .map(|song| (score_genius_song(song, &titles, &artists), song.clone()))
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0));

    // Слишком слабые совпадения пропускаем: лучше честное «не найдено»,
    // чем текст совсем другой песни.
    for (score, song) in ranked.into_iter().take(3) {
        if score < 5 {
            continue;
        }

        let Some(url) = song.get("url").and_then(|v| v.as_str()) else {
            continue;
        };

        let html = match fetch_genius(url, false).await {
            Ok(html) => html,
            Err(_) => continue,
        };

        let lyrics = extract_genius_lyrics(&html);
        if lyrics.chars().count() >= 80 {
            return PlainLyrics {
                found: true,
                title: song.get("title").and_then(|v| v.as_str()).map(String::from),
                artist: song
                    .get("primary_artist")
                    .and_then(|a| a.get("name"))
                    .and_then(|n| n.as_str())
                    .map(String::from)
                    .or_else(|| Some(artist.to_string())),
                url: Some(url.to_string()),
                lyrics: Some(lyrics),
                error: None,
                source: Some("genius".to_string()),
                tempo_modified: None,
            };
        }
    }

    PlainLyrics::default()
}

/// Кэш: тексты не меняются, а Genius не любит частые запросы.
fn cache_get(cache: &Cache, key: &str, ttl: Duration) -> Option<Value> {
    let guard = cache.lock().ok()?;
    let (value, at) = guard.get(key)?;
    if at.elapsed() < ttl {
        return Some(value.clone());
    }
    None
}

fn cache_set(cache: &Cache, key: String, value: Value, limit: usize) {
    let Ok(mut guard) = cache.lock() else {
        return;
    };

    guard.insert(key.clone(), (value, Instant::now()));

    // Удаляем самые старые записи, пока кэш не уляжется в лимит.
    while guard.len() > limit {
        let Some(oldest) = guard
            .iter()
            .min_by_key(|(_, (_, at))| *at)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        guard.remove(&oldest);
    }
}

/// Текст песни: сначала Genius, при неудаче — LRCLIB.
pub async fn get_lyrics(title: &str, artist: &str, description: &str) -> PlainLyrics {
    let key = format!("{}|{}", title.to_lowercase(), artist.to_lowercase());

    if let Some(cached) = cache_get(&PLAIN_CACHE, &key, GENIUS_CACHE_TTL) {
        return serde_json::from_value(cached).unwrap_or_default();
    }

    let mut result = match find_genius_lyrics(title, artist, description).await {
        result if result.found => result,
        _ => get_lrclib_plain_lyrics(title, artist).await,
    };

    // Караоке для speed up / slowed версий бессмысленно: тайминги оригинала
    // разъедутся со звуком. Говорим интерфейсу, но текст всё равно отдаём.
    if is_tempo_modified(title) {
        result.tempo_modified = Some(true);
    }

    if let Ok(value) = serde_json::to_value(&result) {
        cache_set(&PLAIN_CACHE, key, value, GENIUS_CACHE_LIMIT);
    }

    result
}

/// Запасной источник текста — LRCLIB.
async fn get_lrclib_plain_lyrics(title: &str, artist: &str) -> PlainLyrics {
    let cache_key = format!("plain|{}|{}", title.to_lowercase(), artist.to_lowercase());

    if let Some(cached) = cache_get(&PLAIN_CACHE, &cache_key, GENIUS_CACHE_TTL) {
        return serde_json::from_value(cached).unwrap_or_default();
    }

    let mut titles = vec![title.to_string()];
    for variant in title_variants(title).into_iter().take(2) {
        if !titles.contains(&variant) {
            titles.push(variant);
        }
    }
    titles.truncate(3);

    let mut artists = vec![artist.to_string()];
    for variant in artist_variants(artist).into_iter().take(1) {
        if !artists.contains(&variant) {
            artists.push(variant);
        }
    }
    artists.truncate(2);

    let mut best: Option<(f32, Value)> = None;

    'outer: for t in &titles {
        for a in &artists {
            let url = format!(
                "{LRCLIB_API}?track_name={}&artist_name={}",
                encode_uri_component(t),
                encode_uri_component(a)
            );

            let Ok(response) = HTTP
                .get(&url)
                .header("User-Agent", LRCLIB_UA)
                .header("Accept", "application/json")
                .timeout(LRCLIB_TIMEOUT)
                .send()
                .await
            else {
                continue;
            };

            if !response.status().is_success() {
                continue;
            }

            let Ok(list) = response.json::<Value>().await else {
                continue;
            };

            let Some(items) = list.as_array() else {
                continue;
            };

            for entry in items {
                let Some(plain) = entry.get("plainLyrics").and_then(|v| v.as_str()) else {
                    continue;
                };
                if plain.trim().chars().count() < 40 {
                    continue;
                }

                let score = score_lrc_track(entry, title, artist, 0.0);
                if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                    best = Some((score, entry.clone()));
                }
            }

            if best.as_ref().map(|(s, _)| *s >= 12.0).unwrap_or(false) {
                break 'outer;
            }
        }
    }

    let result = match best {
        Some((score, entry)) if score >= 4.0 => PlainLyrics {
            found: true,
            title: entry
                .get("trackName")
                .and_then(|v| v.as_str())
                .map(String::from),
            artist: entry
                .get("artistName")
                .and_then(|v| v.as_str())
                .map(String::from),
            url: entry
                .get("url")
                .and_then(|v| v.as_str())
                .map(|path| format!("https://lrclib.net{path}")),
            lyrics: entry
                .get("plainLyrics")
                .and_then(|v| v.as_str())
                .map(String::from),
            error: None,
            source: Some("lrclib".to_string()),
            tempo_modified: None,
        },
        _ => PlainLyrics::default(),
    };

    if let Ok(value) = serde_json::to_value(&result) {
        cache_set(&PLAIN_CACHE, cache_key, value, GENIUS_CACHE_LIMIT);
    }

    result
}

/// Насколько запись LRCLIB похожа на нужный трек.
fn score_lrc_track(entry: &Value, title: &str, artist: &str, duration_ms: f64) -> f32 {
    let want_title = normalize_text(title);
    let want_artist = normalize_text(artist);
    let track_title = normalize_text(entry.get("trackName").and_then(|v| v.as_str()).unwrap_or(""));
    let track_artist = normalize_text(entry.get("artistName").and_then(|v| v.as_str()).unwrap_or(""));

    if track_title.is_empty() {
        return -100.0;
    }

    let mut score = 0.0f32;

    if track_title == want_title {
        score += 10.0;
    } else if track_title.contains(&want_title) || want_title.contains(&track_title) {
        score += 6.0;
    } else {
        let words: Vec<&str> = want_title.split(' ').filter(|w| w.chars().count() > 1).collect();
        if !words.is_empty() {
            let matched = words.iter().filter(|w| track_title.contains(*w)).count();
            score += (matched as f32 / words.len() as f32) * 3.0;
        }
    }

    if !want_artist.is_empty() && !track_artist.is_empty() {
        if track_artist == want_artist {
            score += 8.0;
        } else if track_artist.contains(&want_artist) || want_artist.contains(&track_artist) {
            score += 4.0;
        }
    }

    // Длительность помогает выбрать нужную версию среди ремиксов.
    if duration_ms > 0.0 {
        if let Some(duration) = entry.get("duration").and_then(|v| v.as_f64()) {
            let diff = (duration * 1000.0 - duration_ms).abs();
            if diff <= 3000.0 {
                score += 4.0;
            } else if diff <= 10_000.0 {
                score += 2.0;
            } else if diff > 45_000.0 {
                score -= 3.0;
            }
        }
    }

    score
}

/// Тайминги строк для караоке — из открытого каталога LRCLIB.
pub async fn get_synced_lyrics(title: &str, artist: &str, duration_ms: f64) -> SyncedLyrics {
    let cache_key = format!(
        "{}|{}|{}",
        title.to_lowercase(),
        artist.to_lowercase(),
        (duration_ms / 1000.0).round() as i64
    );

    if let Some(cached) = cache_get(&SYNC_CACHE, &cache_key, LRCLIB_CACHE_TTL) {
        return serde_json::from_value(cached).unwrap_or_default();
    }

    let mut titles = vec![title.to_string()];
    for variant in title_variants(title).into_iter().take(2) {
        if !titles.contains(&variant) {
            titles.push(variant);
        }
    }
    titles.truncate(3);

    let mut artists = vec![artist.to_string()];
    for variant in artist_variants(artist).into_iter().take(1) {
        if !artists.contains(&variant) {
            artists.push(variant);
        }
    }
    artists.truncate(2);

    let mut best: Option<(f32, Value)> = None;

    'outer: for t in &titles {
        for a in &artists {
            let url = format!(
                "{LRCLIB_API}?track_name={}&artist_name={}",
                encode_uri_component(t),
                encode_uri_component(a)
            );

            let Ok(response) = HTTP
                .get(&url)
                .header("User-Agent", LRCLIB_UA)
                .header("Accept", "application/json")
                .timeout(LRCLIB_TIMEOUT)
                .send()
                .await
            else {
                continue;
            };

            if !response.status().is_success() {
                continue;
            }

            let Ok(list) = response.json::<Value>().await else {
                continue;
            };

            let Some(items) = list.as_array() else {
                continue;
            };

            for entry in items {
                let Some(synced) = entry.get("syncedLyrics").and_then(|v| v.as_str()) else {
                    continue;
                };
                if synced.trim().chars().count() <= 20 {
                    continue;
                }

                let score = score_lrc_track(entry, title, artist, duration_ms);
                if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                    best = Some((score, entry.clone()));
                }
            }

            if best.as_ref().map(|(s, _)| *s >= 12.0).unwrap_or(false) {
                break 'outer;
            }
        }
    }

    let result = match best {
        Some((score, entry)) if score >= 6.0 => SyncedLyrics {
            found: true,
            synced_lyrics: entry
                .get("syncedLyrics")
                .and_then(|v| v.as_str())
                .map(String::from),
            title: entry
                .get("trackName")
                .and_then(|v| v.as_str())
                .map(String::from),
            artist: entry
                .get("artistName")
                .and_then(|v| v.as_str())
                .map(String::from),
            duration: entry.get("duration").and_then(|v| v.as_f64()),
            error: None,
        },
        _ => SyncedLyrics::default(),
    };

    if let Ok(value) = serde_json::to_value(&result) {
        cache_set(&SYNC_CACHE, cache_key, value, LRCLIB_CACHE_LIMIT);
    }

    result
}

/// Кодирование строки для URL-параметра.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' => out.push(*byte as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_text() {
        // Скобочные приписки вырезаются: "(Original Song)" не мешает поиску.
        assert_eq!(normalize_text("I WANT (Original Song)"), "i want");
        assert_eq!(normalize_text("Don't Stop Me Now!"), "don t stop me now");
    }

    #[test]
    fn cleans_titles() {
        assert_eq!(clean_title("Track (prod. by X)"), "Track");
        assert_eq!(clean_title("Track [2024]"), "Track");
    }

    #[test]
    fn builds_title_variants() {
        let variants = title_variants("Артист - Песня (prod. by Someone)");
        assert!(variants.iter().any(|v| v == "Песня"));
        assert!(variants.iter().any(|v| v == "Артист"));
    }

    #[test]
    fn decodes_entities() {
        assert_eq!(decode_html_entities("a &amp; b"), "a & b");
        assert_eq!(decode_html_entities("&#39;quoted&#39;"), "'quoted'");
    }

    #[test]
    fn extracts_genius_block() {
        let html = r#"<div data-lyrics-container="true">[Verse]<br>Hello world</div>"#;
        let text = extract_genius_lyrics(html);
        assert!(text.contains("Hello world"));
        assert!(!text.contains("<br>"));
    }

    #[test]
    fn detects_tempo_versions() {
        // Приписки, которыми перезаливают трек с другим темпом.
        assert!(is_tempo_modified("Track (speed up)"));
        assert!(is_tempo_modified("Track (slowed)"));
        assert!(is_tempo_modified("Track (slowed + reverb)"));
        assert!(is_tempo_modified("Track (slowed n reverb)"));
        assert!(is_tempo_modified("Track (ultra slowed)"));
        assert!(is_tempo_modified("Track [nightcore]"));
        assert!(is_tempo_modified("Track (bass boosted)"));
        assert!(is_tempo_modified("Track (8D)"));
        assert!(is_tempo_modified("Track (1.25x)"));
        assert!(is_tempo_modified("Track speed up"));

        // Обычные приписки темп не меняют — караоке остаётся.
        assert!(!is_tempo_modified("Track (prod. by Someone)"));
        assert!(!is_tempo_modified("Track (Remix)"));
        assert!(!is_tempo_modified("Track (Live)"));
        assert!(!is_tempo_modified("Track [2024]"));
        assert!(!is_tempo_modified("Официантка - Папин Олимпос"));
    }

    #[test]
    fn strips_tempo_marks_for_search() {
        assert_eq!(strip_tempo_marks("Track (speed up)"), "Track");
        assert_eq!(
            strip_tempo_marks("Офицантка - Папин Олимпос (speed up)"),
            "Офицантка - Папин Олимпос"
        );
        assert_eq!(strip_tempo_marks("Track (slowed n reverb)"), "Track");
        // Без приписок название не меняется.
        assert_eq!(strip_tempo_marks("Track"), "Track");
    }

    #[test]
    fn tempo_variant_keeps_song_name() {
        // Для «Артист - Песня (speed up)» в вариантах должна появиться
        // чистая «Песня» — иначе Genius не найдёт оригинал.
        let variants = title_variants("Офицантка - Папин Олимпос (speed up)");
        assert!(variants.iter().any(|v| v == "Папин Олимпос"));
        assert!(variants.iter().any(|v| v == "Офицантка - Папин Олимпос"));
    }

    #[test]
    fn compares_words_with_one_typo() {
        // Перезаливы часто искажают название: одна опечатка не мешает.
        assert!(words_similar("официантка", "офицантка"));
        assert!(words_similar("олимпос", "олимпос"));
        assert!(!words_similar("олимпос", "олимпиада"));
        // Короткие слова сравниваем строго: «дом» и «дым» — разные песни.
        assert!(!words_similar("дом", "дым"));
        assert!(!words_similar("официантка", "пельмени"));
    }

    #[test]
    fn scores_typo_title_without_artist() {
        // Трек «Офицантка - Папин Олимпос (speed up)» от пользователя
        // «nsssive». На Genius песня зовётся «Официантка (Waitress)» и
        // принадлежит «Папин Олимпос». Ник перезаливщика там не встречается,
        // поэтому оценка держится на названии с поправкой на опечатку.
        let titles = title_variants("Офицантка - Папин Олимпос (speed up)");
        let artists = artist_variants("nsssive");

        let song = serde_json::json!({
            "title": "Официантка (Waitress)",
            "primary_artist": { "name": "Папин Олимпос (Papin Olympos)" }
        });

        let score = score_genius_song(&song, &titles, &artists);
        assert!(score >= 5, "ожидали не меньше 5, получили {score}");
    }

    #[test]
    fn rejects_other_song() {
        let titles = title_variants("Офицантка - Папин Олимпос (speed up)");
        let artists = artist_variants("nsssive");

        let song = serde_json::json!({
            "title": "Снежинка (Snowflake)",
            "primary_artist": { "name": "Папин Олимпос (Papin Olympos)" }
        });

        // Артист совпал, но песня другая: текст брать нельзя.
        assert!(score_genius_song(&song, &titles, &artists) < 10);
    }
}
