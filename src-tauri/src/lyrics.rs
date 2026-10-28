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
const KARALYR_API: &str = "https://karalyr.com/api/get";
const KARALYR_TIMEOUT: Duration = Duration::from_secs(10);
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
/// Расширение файла в названии: «cachalot.mp3» на Genius зовётся «cachalot»,
/// и с расширением поиск не находит ничего.
static RE_FILE_EXT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\.(mp3|wav|m4a|flac|ogg|aac|opus|webm)\b").unwrap()
});
static RE_DOUBLE_SPACES: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s{2,}").unwrap());
static RE_DASH_SPLIT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+[-–—]\s+").unwrap());
/// Слэшем склеивают несколько песен или название с исполнителем:
/// «RANE/ШИПЫ ONDA ANDAR», «Артист/Песня».
static RE_SLASH_SPLIT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s*/\s*").unwrap());
/// Хвостовые метки вроде «#2016»: на LRCLIB и Genius их обычно нет.
static RE_HASHTAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|\s)#\S+").unwrap());
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

/// Кириллица в латиницу: страницы Genius часто озаглавлены транслитерацией
/// («Красавица» → «Krasavitsa», «Гуляю» → «Gulyayu»), и без такого варианта
/// русское название не совпадает ни с чем. Схема близка к той, которой
/// пользуется Genius: ц → ts, ч → ch, ш → sh, щ → shch, х → kh, ю → yu,
/// я → ya; твёрдый и мягкий знаки отбрасываются.
fn translit_ru(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut changed = false;

    for ch in value.chars() {
        let lower = ch.to_lowercase().next().unwrap_or(ch);
        let mapped = match lower {
            'а' => "a",
            'б' => "b",
            'в' => "v",
            'г' => "g",
            'д' => "d",
            'е' => "e",
            'ё' => "e",
            'ж' => "zh",
            'з' => "z",
            'и' => "i",
            'й' => "y",
            'к' => "k",
            'л' => "l",
            'м' => "m",
            'н' => "n",
            'о' => "o",
            'п' => "p",
            'р' => "r",
            'с' => "s",
            'т' => "t",
            'у' => "u",
            'ф' => "f",
            'х' => "kh",
            'ц' => "ts",
            'ч' => "ch",
            'ш' => "sh",
            'щ' => "shch",
            'ъ' => "",
            'ы' => "y",
            'ь' => "",
            'э' => "e",
            'ю' => "yu",
            'я' => "ya",
            'і' => "i",
            'ї' => "yi",
            'є' => "ye",
            'ґ' => "g",
            _ => {
                result.push(ch);
                continue;
            }
        };

        changed = true;
        result.push_str(mapped);
    }

    if changed {
        result
    } else {
        value.to_string()
    }
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
    let text = RE_FILE_EXT.replace_all(&text, " ");
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

    // Слэш и хвостовые метки: «RANE/ШИПЫ ONDA ANDAR #2016» на LRCLIB лежит
    // как «RANE — ONDA ANDAR», и целиком такое название не находится.
    add(RE_HASHTAG.replace_all(&without_tempo, "").trim().to_string());

    for piece in RE_SLASH_SPLIT.split(&without_tempo) {
        let piece = RE_HASHTAG.replace_all(piece, "");
        add(piece.trim().to_string());
    }

    // Каждое слово отдельно: по названию из одного слова LRCLIB и Genius
    // ищут гораздо лучше, чем по склейке из нескольких.
    for piece in RE_SLASH_SPLIT.split(&without_tempo) {
        for word in RE_HASHTAG.replace_all(piece, "").split_whitespace() {
            if word.chars().count() >= 4 {
                add(word.trim_matches(|c: char| !c.is_alphanumeric()).to_string());
            }
        }
    }

    // Транслитерация кириллицы: «Anguish - Красавица» на Genius лежит как
    // «ANGUISH — Krasavitsa (Remix)». Вариант добавляем в конец, чтобы он не
    // отнимал место у обычных запросов.
    drop(add);

    let transliterated: Vec<String> = variants
        .iter()
        .filter(|value| value.chars().any(|c| c.is_alphabetic() && !c.is_ascii()))
        .map(|value| translit_ru(value))
        .collect();

    for value in transliterated {
        let trimmed = value.trim();
        if trimmed.chars().count() > 1 && !variants.iter().any(|v| v == trimmed) {
            variants.push(trimmed.to_string());
        }
    }

    variants
}

/// Варианты имени артиста: без скобок и приписок.
pub fn artist_variants(artist: &str) -> Vec<String> {
    let mut variants: Vec<String> = Vec::new();
    let mut add = |value: String| {
        let trimmed = value.trim();
        // Звёздочки, точки и прочие заглушки («*») артистом не считаем:
        // с ними LRCLIB не находит ничего.
        let has_letters = trimmed.chars().any(|c| c.is_alphanumeric());
        if trimmed.chars().count() > 1 && has_letters && !variants.iter().any(|v| v == trimmed) {
            variants.push(trimmed.to_string());
        }
    };

    add(artist.to_string());
    add(RE_PAREN.replace_all(artist, " ").trim().to_string());

    variants
}

/// Исполнитель, названный прямо в названии трека: «RANE/ШИПЫ ONDA ANDAR
/// #2016» → «шипы onda andar», «Песня - Артист» → «артист». Нужно, чтобы
/// короткий запрос вроде «RANE» не подхватывал чужую песню с тем же словом,
/// но другим исполнителем (Genius по слову «RANE» отдаёт «Rane — Anastasija»).
/// Работает по сырому названию: разделители «/» и «-» нормализация уже
/// убрала бы.
fn artist_from_title(title: &str) -> Option<String> {
    let text = title.trim();
    if text.is_empty() {
        return None;
    }

    // Часть после слэша: коллабы и перезаливы часто пишут так.
    if let Some(after) = text.split('/').nth(1) {
        let cleaned = strip_tempo_marks_all(&RE_HASHTAG.replace_all(after, "").to_string());
        let cleaned = clean_title(&cleaned);
        let cleaned = normalize_text(&cleaned);
        if cleaned.chars().count() >= 4 {
            return Some(cleaned);
        }
    }

    // Часть после последнего тире: «Песня - Артист» или «Артист - Песня».
    if let Some((_, after)) = text.rsplit_once('-') {
        let cleaned = strip_tempo_marks_all(after);
        let cleaned = clean_title(&cleaned).trim().to_string();
        let cleaned = normalize_text(&cleaned);
        if cleaned.chars().count() >= 4
            && !cleaned
                .split_whitespace()
                .any(|w| w == "feat" || w == "ft")
        {
            return Some(cleaned);
        }
    }

    None
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
    one_typo_apart(a, b, 5)
}

/// Одна опечатка в слове имени артиста.
///
/// В названиях перезаливов имя исполнителя часто искажено: «ondra adar -
/// cachalot.mp3» вместо «ONDA ANDAR — cachalot». Короткие псевдонимы — это
/// обычно четыре буквы, и порог в пять букв такое имя не ловит. Послабление
/// действует только для имён: в названиях оно склеивало бы разные песни.
fn artist_word_similar(a: &str, b: &str) -> bool {
    one_typo_apart(a, b, 4)
}

/// Слова отличаются не больше чем на одну вставку, удаление или замену.
///
/// `min_short` — минимальная длина более короткого слова: короткие слова
/// сравниваем строго, иначе «дом» и «дым» станут одним словом.
fn one_typo_apart(a: &str, b: &str, min_short: usize) -> bool {
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

    if short.len() < min_short || long.len() - short.len() > 1 {
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

/// Слова, которые в теге артиста отделяют одного исполнителя от другого.
const ARTIST_JOIN_WORDS: [&str; 9] = [
    "feat", "ft", "featuring", "x", "х", "і", "и", "and", "with",
];

/// Отдельные исполнители внутри тега: «k0vertessence; B4YLUm» → два имени.
///
/// Нормализация стирает запятые и амперсанды, поэтому делим по сырой строке.
/// «city» в «Gorgon City» остаётся частью имени: это не второй исполнитель,
/// и «gorgon» не должен считаться совпадением с «gorgon city».
fn artist_parts(artist: &str) -> Vec<String> {
    let text = RE_PAREN.replace_all(artist, " ").to_lowercase();

    let mut parts: Vec<String> = Vec::new();

    for chunk in text.split(|c: char| matches!(c, ',' | ';' | '&' | '/' | '+' | '|' | '·' | '×'))
    {
        let mut current: Vec<String> = Vec::new();

        for word in chunk.split_whitespace() {
            let word = normalize_text(word);
            if word.is_empty() {
                continue;
            }

            if ARTIST_JOIN_WORDS.contains(&word.as_str()) {
                if !current.is_empty() {
                    parts.push(current.join(" "));
                    current.clear();
                }
            } else {
                current.push(word);
            }
        }

        if !current.is_empty() {
            parts.push(current.join(" "));
        }
    }

    parts
}

/// Совпадают ли имена исполнителей.
///
/// Сравнение строгое: «gorgon» и «gorgon city» — разные артисты, хотя одно
/// имя целиком входит в другое. Совпадением считаем:
///  * полностью одинаковые имена;
///  * общего участника коллаборации («k0vertessence» ↔ «k0vertessence; B4YLUm»);
///  * одну опечатку при одинаковом числе слов.
fn artist_names_match(left: &str, right: &str) -> bool {
    let left_norm = normalize_text(left);
    let right_norm = normalize_text(right);

    if left_norm.is_empty() || right_norm.is_empty() {
        return false;
    }
    if left_norm == right_norm {
        return true;
    }

    let left_parts = artist_parts(left);
    let right_parts = artist_parts(right);

    if left_parts
        .iter()
        .any(|a| right_parts.iter().any(|b| a == b))
    {
        return true;
    }

    // Одна опечатка в имени. Число слов должно совпадать: иначе «gorgon»
    // и «gorgon city» прошли бы как опечатка.
    let same_words = |a: &str, b: &str| {
        let a_words: Vec<&str> = a.split(' ').filter(|w| !w.is_empty()).collect();
        let b_words: Vec<&str> = b.split(' ').filter(|w| !w.is_empty()).collect();
        a_words.len() == b_words.len()
            && a_words
                .iter()
                .zip(b_words.iter())
                .all(|(a, b)| words_similar(a, b))
    };

    same_words(&left_norm, &right_norm)
        || left_parts
            .iter()
            .any(|a| right_parts.iter().any(|b| same_words(a, b)))
}

/// Насколько результат поиска похож на нужный трек.
fn score_genius_song(song: &Value, titles: &[String], artists: &[String]) -> i32 {
    let raw_song_artist = song
        .get("primary_artist")
        .and_then(|a| a.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("");
    let song_title = normalize_text(song.get("title").and_then(|v| v.as_str()).unwrap_or(""));
    let song_artist = normalize_text(raw_song_artist);

    if song_title.is_empty() || song_artist.is_empty() {
        return -100;
    }

    let want_titles: Vec<String> = titles.iter().map(|t| normalize_text(t)).filter(|t| !t.is_empty()).collect();
    let want_artists: Vec<String> = artists.iter().map(|a| normalize_text(a)).filter(|a| !a.is_empty()).collect();

    // Исполнитель, названный в самом названии трека («RANE/ШИПЫ ONDA ANDAR
    // #2016» → «шипы onda andar»). Если Genius вернул другого артиста —
    // короткое совпадение названия (одно слово) нельзя считать уверенным,
    // иначе «RANE» подхватывает чужую «Rane — Anastasija».
    let title_artist = titles
        .first()
        .and_then(|t| artist_from_title(t))
        .map(|a| normalize_text(&a))
        .filter(|a| !a.is_empty());
    let artist_consistent = title_artist
        .as_ref()
        .map(|ta| artist_names_match(raw_song_artist, ta))
        .unwrap_or(true);

    // Исполнитель записи совпал с кем-то из известных нам имён (тег трека
    // или его вариант). Это главный признак, что песня та же.
    let artist_matched = artists
        .iter()
        .any(|want_artist| artist_names_match(raw_song_artist, want_artist));

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
        if normalize_text(want_artist) == song_artist {
            return 8;
        }
        if artist_names_match(raw_song_artist, want_artist) {
            return 4;
        }
        0
    };

    // Название и артист складываются: точное совпадение обоих — сильнее,
    // чем любого по отдельности. Раньше брался максимум, и чужая песня с
    // точным названием весила столько же, сколько верная пара «название +
    // артист», а при равном счёте побеждала та, что попалась раньше.
    let title_best = want_titles
        .iter()
        .map(|want_title| title_score(want_title))
        .max()
        .unwrap_or(0);
    let artist_best = artists.iter().map(|a| artist_score(a)).max().unwrap_or(0);
    let mut score = title_best + artist_best;

    // Артист на Genius назван словами сырого названия SoundCloud-трека
    // («миномет нежеголь(The mortar)» → «Нежеголь (Nezhegol)»): сильный
    // признак, что запись правильная, ведь тег артиста часто содержит
    // ник загрузившего, а не настоящего исполнителя. Без этой поправки
    // чужая песня с тем же названием («Миномёт» другого исполнителя)
    // обгоняет верную: у неё точное совпадение слова, у верной — лишь
    // частичное, а якорь по артисту у никого не срабатывает.
    // Сравнение по словам через words_similar ловит и транслит, и опечатки:
    // «Нежеголь (Nezhegol)» ↔ «нежеголь» из названия.
    //
    // Бонус работает только когда название уже хоть как-то совпало. Иначе
    // «The Temptations — My Girl» проходила бы на трек с названием
    // «temptation»: имя группы похоже на слово из названия, а сама песня —
    // совсем другая.
    let mut artist_named_in_title = false;
    {
        let raw_title = titles.first().map(|t| normalize_text(t)).unwrap_or_default();
        let title_words: Vec<&str> = raw_title
            .split(' ')
            .filter(|w| w.chars().count() >= 4)
            .collect();
        let artist_words: Vec<&str> = song_artist
            .split(' ')
            .filter(|w| w.chars().count() >= 4)
            .collect();

        if !title_words.is_empty() && !artist_words.is_empty() && title_best > 0 {
            let matched = artist_words
                .iter()
                .filter(|aw| title_words.iter().any(|tw| artist_word_similar(tw, aw)))
                .count();
            if matched as f32 / artist_words.len() as f32 >= 0.5 {
                score += 8;
                artist_named_in_title = true;
            }
        }
    }

    // Название в треке называет исполнителя («…/… ONDA ANDAR»), а у записи
    // Genius — чужой. Короткое совпадение в одно слово («RANE») тогда не
    // должно давать «уверенный» балл: это другая песня. Жёстко режем ниже
    // порога приёма (4): такой результат не должен побеждать LRCLIB, где
    // лежит верная запись.
    if !artist_consistent && score < 13 {
        score = score.min(3);
    }

    // Без совпадения артиста держаться можно только за сильное название.
    //  * Однословное «GLUTTONY» есть у десятков исполнителей, а «temptation»
    //    от Gorgon City — не «temptation» от gorgon. Даже точная длительность
    //    не делает такую запись верной.
    //  * Название покрывает половину слов трека или меньше — скорее всего,
    //    найдена другая песня с общим словом («Truth» внутри «truth yandere»).
    // Исключения — артист назван в названии трека: это обычные перезаливы,
    // где в теге загрузчика стоит ник, а настоящий исполнитель в названии.
    let artist_confident = artist_matched
        || artist_named_in_title
        || (title_artist.is_some() && artist_consistent);

    if !artist_confident {
        let raw_title = titles
            .first()
            .map(|t| normalize_text(t))
            .unwrap_or_default();
        let words: Vec<&str> = raw_title
            .split(' ')
            .filter(|w| w.chars().count() > 1)
            .collect();
        let single_word_title = words.len() < 2;
        let coverage = if words.is_empty() {
            1.0
        } else {
            let matched = words.iter().filter(|w| song_title.contains(**w)).count();
            matched as f32 / words.len() as f32
        };

        if single_word_title || coverage <= 0.5 {
            score = score.min(3);
        }
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

    for query in queries.iter().take(10) {
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
pub async fn get_lyrics(title: &str, artist: &str, description: &str, duration_ms: f64) -> PlainLyrics {
    let key = format!(
        "{}|{}|{}",
        title.to_lowercase(),
        artist.to_lowercase(),
        (duration_ms / 1000.0).round() as i64
    );

    if let Some(cached) = cache_get(&PLAIN_CACHE, &key, GENIUS_CACHE_TTL) {
        return serde_json::from_value(cached).unwrap_or_default();
    }

    let mut result = match find_genius_lyrics(title, artist, description).await {
        result if result.found => result,
        _ => get_lrclib_plain_lyrics(title, artist, duration_ms).await,
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
async fn get_lrclib_plain_lyrics(title: &str, artist: &str, duration_ms: f64) -> PlainLyrics {
    let cache_key = format!(
        "plain|{}|{}|{}",
        title.to_lowercase(),
        artist.to_lowercase(),
        (duration_ms / 1000.0).round() as i64
    );

    if let Some(cached) = cache_get(&PLAIN_CACHE, &cache_key, GENIUS_CACHE_TTL) {
        return serde_json::from_value(cached).unwrap_or_default();
    }

    let mut titles = vec![title.to_string()];
    for variant in title_variants(title) {
        if !titles.contains(&variant) {
            titles.push(variant);
        }
    }
    // Вариантов бывает много (слэш, отдельные слова) — по одному запросу на
    // каждый LRCLIB не любит, поэтому ограничиваемся самыми полезными.
    titles.truncate(6);

    let mut artists = vec![artist.to_string()];
    for variant in artist_variants(artist).into_iter().take(1) {
        if !artists.contains(&variant) {
            artists.push(variant);
        }
    }
    // Пустой артист — это поиск только по названию; так тоже ищем.
    artists.push(String::new());
    artists.truncate(3);

    let mut best: Option<(f32, Value)> = None;

    'outer: for t in &titles {
        for a in &artists {
            let url = if a.is_empty() {
                format!("{LRCLIB_API}?track_name={}", encode_uri_component(t))
            } else {
                format!(
                    "{LRCLIB_API}?track_name={}&artist_name={}",
                    encode_uri_component(t),
                    encode_uri_component(a)
                )
            };

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

                // Название должно хоть как-то совпасть: иначе при поиске по
                // одному слову («RANE») в выборку попадают десятки чужих
                // песен, и побеждает случайная с подходящей длительностью.
                if !lrc_title_matches(entry, title) {
                    continue;
                }

                // Оценка идёт по исходному названию, а не по варианту запроса:
                // иначе «RANE» из «RANE/ШИПЫ» засчиталось бы как точное
                // совпадение с чужой песней «Rane» другого исполнителя.
                let score = score_lrc_track(entry, title, artist, duration_ms);
                if is_better_lrc(score, entry, &best, duration_ms) {
                    best = Some((score, entry.clone()));
                }
            }

            if best.as_ref().map(|(s, _)| *s >= 18.0).unwrap_or(false) {
                break 'outer;
            }
        }
    }

    // Fallback: Karalyr — LRCLIB-совместимый, отдаёт plain-текст тоже.
    if best.is_none() {
        let url = format!(
            "{}?track_name={}&artist_name={}&duration={}",
            KARALYR_API,
            encode_uri_component(title),
            encode_uri_component(artist),
            (duration_ms / 1000.0).round() as i64
        );
        if let Ok(response) = HTTP
            .get(&url)
            .header("User-Agent", LRCLIB_UA)
            .header("Accept", "application/json")
            .timeout(KARALYR_TIMEOUT)
            .send()
            .await
        {
            if response.status().is_success() {
                if let Ok(entry) = response.json::<Value>().await {
                    if let Some(plain) = entry.get("plainLyrics").and_then(|v| v.as_str()) {
                        if plain.trim().chars().count() > 20 {
                            let track_name = entry
                                .get("trackName")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if lrc_title_matches(&entry, title)
                                && version_markers_compatible(title, track_name)
                                && lrc_artist_matches(&entry, title, artist)
                            {
                                best = Some((8.0, entry));
                            }
                        }
                    }
                }
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

/// Возвращает набор «ключевых слов версии» из названия: remix, mix, edit,
/// version, live, bootleg, acoustic, instrumental, radio, extended, slowed,
/// sped, reverb, nightcore, bass boosted, cover, acapella и т.п.
/// Используется, чтобы не подхватить тайминги оригинала для ремикса:
/// если в названии трека есть такой маркер, а у записи LRCLIB его нет —
/// это разные версии с разными словами.
fn version_markers(title: &str) -> Vec<String> {
    const MARKERS: &[&str] = &[
        "remix", "mix", "edit", "version", "live", "bootleg", "acoustic",
        "instrumental", "radio", "extended", "slowed", "sped", "reverb",
        "nightcore", "boosted", "cover", "acapella", "mashup", "flip",
    ];
    let lowered = title.to_lowercase();
    let mut found: Vec<String> = Vec::new();
    for marker in MARKERS {
        if lowered.contains(marker) {
            found.push((*marker).to_string());
        }
    }
    found
}

/// Совместимы ли маркеры версии: если в названии трека есть маркер, он
/// должен быть и в названии записи LRCLIB.
fn version_markers_compatible(want_title: &str, track_title: &str) -> bool {
    let want_markers = version_markers(want_title);
    if want_markers.is_empty() {
        return true;
    }
    let track_markers = version_markers(track_title);
    want_markers.iter().all(|m| track_markers.contains(m))
}

/// Совпадает ли название записи LRCLIB с искомым.
///
/// Отдельно от оценки: одной только близкой длительности и знакомого
/// исполнителя мало — иначе для «Официантка - Папин Олимпос» побеждала бы
/// любая другая песня того же артиста, лишь бы совпала по времени.
fn lrc_title_matches(entry: &Value, title: &str) -> bool {
    let want = normalize_text(title);
    let track = normalize_text(entry.get("trackName").and_then(|v| v.as_str()).unwrap_or(""));

    if want.is_empty() || track.is_empty() {
        return false;
    }

    if track == want || track.contains(&want) || want.contains(&track) {
        return true;
    }

    // Хотя бы одно слово названия должно найтись в названии записи:
    // «RANE» из «RANE/ШИПЫ ONDA ANDAR #2016» подходит, «СХИ» — нет.
    want.split(' ')
        .filter(|w| w.chars().count() > 2)
        .any(|w| track.contains(w))
}

/// Артист записи LRCLIB совпадает с артистом трека или назван в названии.
///
/// Название в названии — обычный случай перезалива: в теге артиста стоит ник
/// загрузившего («nsssive»), а настоящий исполнитель указан в самом названии.
/// Пустой артист трека ничего не говорит — тогда не мешаем выбирать по
/// названию и длительности.
fn lrc_artist_matches(entry: &Value, title: &str, artist: &str) -> bool {
    let want_title = normalize_text(title);
    let want_artist = normalize_text(artist);
    let raw_track_artist = entry
        .get("artistName")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let track_artist = normalize_text(raw_track_artist);

    if want_artist.is_empty() {
        return true;
    }

    if track_artist.is_empty() {
        return false;
    }

    if track_artist.chars().count() >= 4 && want_title.contains(&track_artist) {
        return true;
    }

    artist_names_match(artist, raw_track_artist)
}

/// Доля слов искомого названия, которые есть в названии записи LRCLIB.
///
/// «Truth» от Jaxomy покрывает лишь одно слово из «truth yandere^^ (ultra
/// slowed)» — это другая песня, даже если длительности случайно совпали.
fn lrc_title_coverage(entry: &Value, title: &str) -> f32 {
    let want = normalize_text(title);
    let track = normalize_text(
        entry
            .get("trackName")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );

    let words: Vec<&str> = want
        .split(' ')
        .filter(|w| w.chars().count() > 1)
        .collect();
    if words.is_empty() {
        return 0.0;
    }

    let matched = words.iter().filter(|w| track.contains(**w)).count();
    matched as f32 / words.len() as f32
}

/// Стоит ли заменить текущего кандидата LRCLIB этим.
///
/// При равной оценке выбираем запись, ближайшую по длительности: на одну
/// песню на LRCLIB бывают и оригинал, и ускоренная версия, и по названию с
/// артистом они неотличимы — но ближайшая по времени точнее по структуре.
fn is_better_lrc(
    score: f32,
    entry: &Value,
    best: &Option<(f32, Value)>,
    duration_ms: f64,
) -> bool {
    match best {
        None => true,
        Some((best_score, best_entry)) => {
            score > *best_score
                || (score == *best_score
                    && lrc_duration_diff(entry, duration_ms)
                        < lrc_duration_diff(best_entry, duration_ms))
        }
    }
}

/// Разница длительности записи LRCLIB и трека в миллисекундах.
fn lrc_duration_diff(entry: &Value, duration_ms: f64) -> f64 {
    entry
        .get("duration")
        .and_then(|v| v.as_f64())
        .map(|duration| (duration * 1000.0 - duration_ms).abs())
        .unwrap_or(f64::INFINITY)
}

/// Насколько запись LRCLIB похожа на нужный трек.
fn score_lrc_track(entry: &Value, title: &str, artist: &str, duration_ms: f64) -> f32 {
    let want_title = normalize_text(title);
    let want_artist = normalize_text(artist);
    let track_title = normalize_text(entry.get("trackName").and_then(|v| v.as_str()).unwrap_or(""));
    let raw_track_artist = entry.get("artistName").and_then(|v| v.as_str()).unwrap_or("");
    let track_artist = normalize_text(raw_track_artist);

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

    // Артист записи назван в нашем названии трека — сильный признак, что это
    // та же песня. Нужен и когда артист трека известен: у перезаливов в теге
    // стоит ник загрузившего («nsssive»), а не настоящий исполнитель, и без
    // этой проверки побеждает чужая песня того же исполнителя с похожей
    // длительностью.
    if track_artist.chars().count() >= 4 && want_title.contains(&track_artist) {
        score += 8.0;
    }

    if !want_artist.is_empty() && !track_artist.is_empty() {
        if track_artist == want_artist {
            score += 8.0;
        } else if artist_names_match(artist, raw_track_artist) {
            // Коллаборация: у записи «k0vertessence; B4YLUm», у трека
            // «k0vertessence». Исполнитель тот же, просто тег полнее.
            score += 4.0;
        }
    } else if want_artist.is_empty()
        && track_artist.chars().count() >= 4
        && want_title.contains(&track_artist)
    {
        // Артиста в теге трека нет (или там заглушка «*»), зато он назван в
        // самом названии: «RANE/ШИПЫ ONDA ANDAR #2016» на LRCLIB лежит как
        // «RANE — ONDA ANDAR». Совпадение артиста внутри названия — сильный
        // признак, иначе побеждает чужая песня «Rane» той же длительности.
        score += 8.0;
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

    // Чужой артист — доверять одному названию нельзя.
    //  * Название покрывает половину слов трека или меньше («Truth» внутри
    //    «truth yandere» после отбрасывания «(ultra slowed)») — это другая
    //    песня, даже если длительности совпали.
    //  * Однословное название вроде «Рассвет» или «temptation» слишком общее:
    //    без совпадения артиста это другая песня, даже при точной
    //    длительности. «gorgon — temptation» и «Gorgon City — Sweet
    //    Temptation» — разные треки, хотя слова входят друг в друга.
    //  * Многословное и уникальное название («ВЫЗВАЛ ШЛЮХУ x mylancore»)
    //    пропускаем: перезаливы и ремиксы часто отличаются по длительности.
    let single_word_title = want_title.split(' ').filter(|w| !w.is_empty()).count() < 2;
    if !lrc_artist_matches(entry, title, artist) {
        let weak_title = lrc_title_coverage(entry, title) <= 0.5;

        if weak_title || single_word_title {
            score = score.min(3.0);
        }
    }

    score
}

/// Тайминги строк для караоке — из открытого каталога LRCLIB.
pub async fn get_synced_lyrics(title: &str, artist: &str, duration_ms: f64) -> SyncedLyrics {
    if is_tempo_modified(title) {
        return SyncedLyrics::default();
    }
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
    for variant in title_variants(title) {
        if !titles.contains(&variant) {
            titles.push(variant);
        }
    }
    // Вариантов бывает много (слэш, отдельные слова) — по одному запросу на
    // каждый LRCLIB не любит, поэтому ограничиваемся самыми полезными.
    titles.truncate(6);

    let mut artists = vec![artist.to_string()];
    for variant in artist_variants(artist).into_iter().take(1) {
        if !artists.contains(&variant) {
            artists.push(variant);
        }
    }
    // Пустой артист — это поиск только по названию; так тоже ищем.
    artists.push(String::new());
    artists.truncate(3);

    let mut best: Option<(f32, Value)> = None;

    'outer: for t in &titles {
        for a in &artists {
            let url = if a.is_empty() {
                format!("{LRCLIB_API}?track_name={}", encode_uri_component(t))
            } else {
                format!(
                    "{LRCLIB_API}?track_name={}&artist_name={}",
                    encode_uri_component(t),
                    encode_uri_component(a)
                )
            };

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

                // Та же проверка названия, что и для текста: иначе караоке
                // подхватит тайминги чужой песни того же исполнителя.
                if !lrc_title_matches(entry, title) {
                    continue;
                }

                // Ремикс/версия: если в названии трека есть маркер версии
                // (remix, mix, …), а у записи LRCLIB его нет — это другая
                // песня с другими словами, тайминги не подойдут.
                let track_name = entry
                    .get("trackName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !version_markers_compatible(title, track_name) {
                    continue;
                }

                let score = score_lrc_track(entry, title, artist, duration_ms);
                if is_better_lrc(score, entry, &best, duration_ms) {
                    best = Some((score, entry.clone()));
                }
            }

            if best.as_ref().map(|(s, _)| *s >= 18.0).unwrap_or(false) {
                break 'outer;
            }
        }
    }

    // Fallback: Karalyr — LRCLIB-совместимый сервис с word-synced караоке.
    if best.is_none() {
        let url = format!(
            "{}?track_name={}&artist_name={}&duration={}",
            KARALYR_API,
            encode_uri_component(title),
            encode_uri_component(artist),
            (duration_ms / 1000.0).round() as i64
        );
        if let Ok(response) = HTTP
            .get(&url)
            .header("User-Agent", LRCLIB_UA)
            .header("Accept", "application/json")
            .timeout(KARALYR_TIMEOUT)
            .send()
            .await
        {
            if response.status().is_success() {
                if let Ok(entry) = response.json::<Value>().await {
                    if let Some(synced) = entry.get("syncedLyrics").and_then(|v| v.as_str()) {
                        if synced.trim().chars().count() > 20 {
                            let track_name = entry
                                .get("trackName")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if lrc_title_matches(&entry, title)
                                && version_markers_compatible(title, track_name)
                                && lrc_artist_matches(&entry, title, artist)
                            {
                                best = Some((8.0, entry));
                            }
                        }
                    }
                }
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
    fn splits_slash_and_hashtag() {
        // «RANE/ШИПЫ ONDA ANDAR #2016» на LRCLIB лежит как «RANE — ONDA
        // ANDAR»: без деления по слэшу и без метки «#2016» поиск пуст.
        let variants = title_variants("RANE/ШИПЫ ONDA ANDAR #2016");
        assert!(variants.iter().any(|v| v == "RANE"), "нет RANE: {variants:?}");
        assert!(
            variants.iter().any(|v| v == "RANE/ШИПЫ ONDA ANDAR"),
            "нет варианта без метки: {variants:?}"
        );
        assert!(variants.iter().any(|v| v == "ONDA"), "нет ONDA: {variants:?}");
        assert!(variants.iter().any(|v| v == "ANDAR"), "нет ANDAR: {variants:?}");
    }

    #[test]
    fn rejects_genius_wrong_artist_short_title() {
        // Genius по слову «RANE» отдаёт чужую «Rane — Anastasija», хотя в
        // названии трека назван другой исполнитель («… ONDA ANDAR»). Короткое
        // совпадение в одно слово не должно давать «уверенный» балл — иначе
        // блокируется LRCLIB с верной записью.
        let titles = title_variants("RANE/ШИПЫ ONDA ANDAR #2016");
        let artists = artist_variants("*");

        let wrong = serde_json::json!({
            "title": "Rane",
            "primary_artist": { "name": "Anastasija" }
        });
        let wrong_score = score_genius_song(&wrong, &titles, &artists);
        assert!(
            wrong_score < 5,
            "чужой исполнитель не должен давать уверенный балл, получили {wrong_score}"
        );

        // Верная запись с тем же названием и нужным артистом — проходит.
        let right = serde_json::json!({
            "title": "RANE",
            "primary_artist": { "name": "ONDA ANDAR" }
        });
        let right_score = score_genius_song(&right, &titles, &artists);
        assert!(
            right_score >= 5,
            "верный исполнитель должен давать уверенный балл, получили {right_score}"
        );
    }

    #[test]
    fn ignores_junk_artist() {
        // Звёздочка вместо артиста: с таким «артистом» LRCLIB не находит ничего.
        assert!(artist_variants("*").is_empty());
        assert!(artist_variants("***").is_empty());
        // Настоящий артист остаётся.
        assert!(artist_variants("ONDA ANDAR").contains(&"ONDA ANDAR".to_string()));
    }

    #[test]
    fn prefers_genius_artist_named_in_title() {
        // Трек «миномет нежеголь(The mortar)» от загрузчика pammperrrs.
        // На Genius есть и чужая «Миномёт» (другой исполнитель, точное
        // совпадение слова — 10 баллов), и верная «Миномёт (The Mortar)»
        // от Нежеголь (частичное совпадение — 6). Якорь по артисту из
        // названия («нежеголь» в названии ↔ «Нежеголь (Nezhegol)») должен
        // вытащить верную запись наверх, а чужую оставить позади.
        let titles = title_variants("миномет нежеголь(The mortar)");
        let artists = artist_variants("pammperrrs");

        let wrong = serde_json::json!({
            "title": "Миномёт",
            "primary_artist": { "name": "pammpers" }
        });
        let wrong_score = score_genius_song(&wrong, &titles, &artists);

        let right = serde_json::json!({
            "title": "Миномёт (The Mortar)",
            "primary_artist": { "name": "Нежеголь (Nezhegol)" }
        });
        let right_score = score_genius_song(&right, &titles, &artists);

        assert!(
            right_score > wrong_score,
            "верная запись ({right_score}) должна бить чужую ({wrong_score})"
        );
        assert!(
            right_score >= 13,
            "верная запись должна давать уверенный балл, получили {right_score}"
        );
    }

    #[test]
    fn matches_artist_inside_title() {
        // Артиста в теге нет, но он назван в названии: это сильный признак.
        let entry = serde_json::json!({
            "trackName": "RANE",
            "artistName": "ONDA ANDAR",
            "duration": 168.0
        });

        let score = score_lrc_track(&entry, "RANE/ШИПЫ ONDA ANDAR #2016", "*", 168_000.0);
        assert!(score >= 12.0, "ожидали не меньше 12, получили {score}");
    }

    #[test]
    fn rejects_unrelated_title() {
        // При поиске по одному слову («RANE») в выборку попадают чужие
        // песни. Название должно хоть как-то совпасть, иначе для
        // «Официантка - Папин Олимпос» побеждала бы песня «СХИ» того же
        // артиста с подходящей длительностью.
        let other = serde_json::json!({
            "trackName": "СХИ",
            "artistName": "Папин Олимпос",
            "duration": 143.0
        });
        assert!(!lrc_title_matches(&other, "Официантка - Папин Олимпос (speed up)"));

        let right = serde_json::json!({
            "trackName": "Официантка",
            "artistName": "Папин Олимпос",
            "duration": 146.0
        });
        assert!(lrc_title_matches(&right, "Официантка - Папин Олимпос (speed up)"));

        // «RANE» из склеенного названия — подходит.
        let rane = serde_json::json!({ "trackName": "RANE", "artistName": "ONDA ANDAR" });
        assert!(lrc_title_matches(&rane, "RANE/ШИПЫ ONDA ANDAR #2016"));
    }

    #[test]
    fn rane_lrc_candidates() {
        // Реальные записи из LRCLIB по запросу «RANE» (поиск по одному слову).
        // Проверяем, что нужная «RANE — ONDA ANDAR» бьёт чужие песни, которые
        // тоже проходят фильтр названия по слову «rane».
        let title = "RANE/ШИПЫ ONDA ANDAR #2016";

        let candidates = [
            serde_json::json!({ "trackName": "RANE", "artistName": "ONDA ANDAR", "duration": 168.0 }),
            serde_json::json!({ "trackName": "Rane", "artistName": "Dino Merlin", "duration": 250.88 }),
            serde_json::json!({ "trackName": "Rane", "artistName": "z i x", "duration": 189.0 }),
            serde_json::json!({ "trackName": "Rane", "artistName": "Anastasija", "duration": 171.0 }),
            serde_json::json!({ "trackName": "Rane", "artistName": "DJ Shone", "duration": 160.0 }),
        ];

        for c in &candidates {
            let matches = lrc_title_matches(c, title);
            let score = score_lrc_track(c, title, "*", 168_000.0);
            println!(
                "  -> match={matches} score={score:.1} | {} — {}",
                c["trackName"], c["artistName"]
            );
        }

        let right = score_lrc_track(&candidates[0], title, "*", 168_000.0);
        let anastasija = score_lrc_track(&candidates[3], title, "*", 168_000.0);
        assert!(
            right > anastasija,
            "ONDA ANDAR ({right}) должен бить Anastasija ({anastasija})"
        );
    }

    #[test]
    fn prefers_right_song_by_duration() {
        // «Rane» от Dino Merlin короче — при длительности 168 с побеждает
        // нужная запись, а не первая попавшаяся.
        let wrong = serde_json::json!({
            "trackName": "Rane",
            "artistName": "Dino Merlin",
            "duration": 4.0
        });
        let right = serde_json::json!({
            "trackName": "RANE",
            "artistName": "ONDA ANDAR",
            "duration": 168.0
        });

        let title = "RANE/ШИПЫ ONDA ANDAR #2016";
        let wrong_score = score_lrc_track(&wrong, title, "*", 168_000.0);
        let right_score = score_lrc_track(&right, title, "*", 168_000.0);

        assert!(
            right_score > wrong_score,
            "нужный трек должен победить: {right_score} против {wrong_score}"
        );
    }

    #[test]
    fn rejects_foreign_song_with_common_title() {
        // «Рассвет» — одно слово, на LRCLIB его носят десятки разных песен.
        // Для трека FORTUNA 812 (114 с) запись «Какая Разница» (121 с) чужая:
        // другой артист и другая длительность. Точное название не спасает.
        let wrong = serde_json::json!({
            "trackName": "Рассвет",
            "artistName": "Какая Разница",
            "duration": 121.0
        });
        let wrong_score = score_lrc_track(
            &wrong,
            "Рассвет (prod. cloudly006)",
            "FORTUNA 812",
            114_000.0,
        );
        assert!(
            wrong_score < 4.0,
            "чужая запись не должна проходить порог, получили {wrong_score}"
        );

        // Верная запись того же артиста — принимается.
        let right = serde_json::json!({
            "trackName": "Рассвет (Dawn)",
            "artistName": "FORTUNA 812",
            "duration": 114.0
        });
        let right_score = score_lrc_track(
            &right,
            "Рассвет (prod. cloudly006)",
            "FORTUNA 812",
            114_000.0,
        );
        assert!(
            right_score >= 6.0,
            "верная запись должна проходить, получили {right_score}"
        );
    }

    #[test]
    fn takes_artist_from_title_only_with_separator() {
        // Название без разделителя артиста не содержит. Иначе «Рассвет
        // (prod. cloudly006)» считался бы артистом «рассвет», и верная
        // страница Genius отбрасывалась бы как чужая.
        assert_eq!(artist_from_title("Рассвет (prod. cloudly006)"), None);
        assert_eq!(
            artist_from_title("Официантка - Папин Олимпос").as_deref(),
            Some("папин олимпос")
        );
        assert_eq!(
            artist_from_title("RANE/ШИПЫ ONDA ANDAR #2016").as_deref(),
            Some("шипы onda andar")
        );
    }

    #[test]
    fn rejects_short_title_inside_long_one() {
        // «truth yandere^^ (ultra slowed)» от загрузчика: на LRCLIB нашлась
        // чужая «Truth» Jaxomy. Одно слово из четырёх — не та песня, даже
        // если длительности совпали.
        let wrong = serde_json::json!({
            "trackName": "Truth",
            "artistName": "Jaxomy",
            "duration": 129.0
        });
        let score = score_lrc_track(
            &wrong,
            "truth yandere^^ (ultra slowed)",
            "elevenpillsbeforedisaster",
            129_000.0,
        );
        assert!(
            score < 4.0,
            "чужая «Truth» не должна проходить, получили {score}"
        );
    }

    #[test]
    fn rejects_single_word_without_duration() {
        // У записи «魔法使いの約束, Mili — Gluttony» длительность не указана.
        // Для «GLUTTONY» от Anor (97 с) это всё равно чужая песня: без
        // артиста и без длительности одного названия мало.
        let wrong = serde_json::json!({
            "trackName": "Gluttony",
            "artistName": "魔法使いの約束, Mili"
        });
        let score = score_lrc_track(&wrong, "GLUTTONY", "Anor", 97_000.0);
        assert!(
            score < 4.0,
            "чужая «Gluttony» не должна проходить, получили {score}"
        );
    }

    #[test]
    fn keeps_distinctive_title_from_other_uploader() {
        // Перезалив/ремикс: артист в теге загрузчика не совпадает, длительность
        // отличается, но название многословное и уникальное — текст тот же.
        let entry = serde_json::json!({
            "trackName": "ВЫЗВАЛ ШЛЮХУ",
            "artistName": "Школа №134",
            "duration": 172.0
        });
        let score = score_lrc_track(
            &entry,
            "Вызвал шлюху x mylancore",
            "qwzbtw0",
            152_000.0,
        );
        assert!(score >= 6.0, "ожидали не меньше 6, получили {score}");
    }

    #[test]
    fn rejects_common_genius_title_without_artist() {
        // Для «GLUTTONY» от Anor на Genius нет верной страницы, зато есть
        // чужие песни с тем же однословным названием. Без совпадения
        // артиста такую запись принимать нельзя.
        let titles = title_variants("GLUTTONY");
        let artists = artist_variants("Anor");

        let wrong = serde_json::json!({
            "title": "Gluttony",
            "primary_artist": { "name": "Andrew Hulshult" }
        });

        let score = score_genius_song(&wrong, &titles, &artists);
        assert!(
            score < 5,
            "чужая «Gluttony» не должна проходить, получили {score}"
        );
    }

    #[test]
    fn accepts_truth_yandere_by_real_artist() {
        // Перезалив «truth yandere^^ (ultra slowed)» от elevenpills-
        // beforedisaster: на Genius песня лежит у akkiemi. Артист в теге
        // не совпадает, но название многословное и точное — текст верный.
        let titles = title_variants("truth yandere^^ (ultra slowed)");
        let artists = artist_variants("elevenpillsbeforedisaster");

        let right = serde_json::json!({
            "title": "truth yandere^^",
            "primary_artist": { "name": "akkiemi" }
        });

        let score = score_genius_song(&right, &titles, &artists);
        assert!(
            score >= 5,
            "верная страница должна проходить, получили {score}"
        );
    }

    #[test]
    fn finds_fortuna_dawn_on_genius() {
        // «Рассвет (prod. cloudly006)» от FORTUNA 812: приписка в скобках
        // мешает поисковому запросу, но чистое название плюс артист находят
        // верную страницу Genius «Рассвет (Dawn)».
        let titles = title_variants("Рассвет (prod. cloudly006)");
        let artists = artist_variants("FORTUNA 812");

        let song = serde_json::json!({
            "title": "Рассвет (Dawn)",
            "primary_artist": { "name": "FORTUNA 812" }
        });

        let score = score_genius_song(&song, &titles, &artists);
        assert!(
            score >= 13,
            "верная страница должна давать уверенный балл, получили {score}"
        );
    }

    #[test]
    fn transliterates_native_title_for_genius() {
        // «Anguish - Красавица» на Genius озаглавлена латиницей:
        // «ANGUISH — Krasavitsa (Remix)». Без варианта-транслита название
        // не совпадает ни с чем.
        let titles = title_variants("Anguish - Красавица (Ремикс) [muzson_com]");
        assert!(
            titles.iter().any(|t| t == "krasavitsa"),
            "нет транслита среди вариантов: {titles:?}"
        );
    }

    #[test]
    fn finds_krasavitsa_remix_by_transliteration() {
        let titles = title_variants("Anguish - Красавица (Ремикс) [muzson_com]");
        let artists = artist_variants("Gradoxi");

        let song = serde_json::json!({
            "title": "Krasavitsa (Remix)",
            "primary_artist": { "name": "ANGUISH" }
        });

        let score = score_genius_song(&song, &titles, &artists);
        assert!(
            score >= 13,
            "страница ремикса должна проходить, получили {score}"
        );
    }

    #[test]
    fn rejects_the_temptations_my_girl() {
        // «The Temptations — My Girl»: имя группы похоже на слово
        // «temptation» из названия трека, но песня совсем другая. Бонус за
        // артиста в названии не должен вытягивать её выше порога, когда
        // само название не совпало.
        let titles = title_variants("temptation (OUT NOW ON SPOTIFY)");
        let artists = artist_variants("gorgon");

        let song = serde_json::json!({
            "title": "My Girl",
            "primary_artist": { "name": "The Temptations" }
        });

        let score = score_genius_song(&song, &titles, &artists);
        assert!(
            score < 5,
            "чужая песня не должна проходить, получили {score}"
        );
    }

    #[test]
    fn separates_collaboration_artists_from_similar_names() {
        // «k0vertessence» и «k0vertessence; B4YLUm» — один и тот же исполнитель.
        assert!(artist_names_match("k0vertessence", "k0vertessence; B4YLUm"));
        assert!(artist_names_match("k0vertessence", "k0vertessence, B4YLUm"));
        assert!(artist_names_match("k0vertessence", "k0vertessence feat. B4YLUm"));
        // «gorgon» и «Gorgon City» — разные исполнители: «city» часть имени,
        // а не второй участник коллаборации.
        assert!(!artist_names_match("gorgon", "Gorgon City"));
        assert!(!artist_names_match("Gorgon City", "gorgon"));
        // Опечатка в одном слове — совпадение.
        assert!(artist_names_match("k0vertesence", "k0vertessence"));
    }

    #[test]
    fn rejects_gorgon_city_temptation() {
        // Трек «gorgon — temptation (OUT NOW ON SPOTIFY)» (133 с). На Genius и
        // LRCLIB нашлась чужая «Gorgon City — Sweet Temptation»: «gorgon»
        // входило в «gorgon city», «temptation» — в «sweet temptation».
        // Текст этой песни чужой, поэтому обе оценки должны быть ниже порога.
        let titles = title_variants("temptation (OUT NOW ON SPOTIFY)");
        let artists = artist_variants("gorgon");

        let genius = serde_json::json!({
            "title": "Sweet Temptation",
            "primary_artist": { "name": "Gorgon City" }
        });
        let genius_score = score_genius_song(&genius, &titles, &artists);
        assert!(
            genius_score < 4,
            "чужая страница Genius не должна проходить, получили {genius_score}"
        );

        let lrc = serde_json::json!({
            "trackName": "Sweet Temptation",
            "artistName": "Gorgon City",
            "duration": 133.0
        });
        let lrc_score = score_lrc_track(
            &lrc,
            "temptation (OUT NOW ON SPOTIFY)",
            "gorgon",
            133_000.0,
        );
        assert!(
            lrc_score < 6.0,
            "чужие тайминги LRCLIB не должны проходить, получили {lrc_score}"
        );
    }

    #[test]
    fn rejects_vibecoder_remix_of_eight_mile() {
        // «8 миля (вайбкодер remix)» raveisdead: на LRCLIB лежит оригинал
        // «8 миля» madk1d той же длительности, но слова другие. Запись
        // должна отсеиваться по маркеру версии.
        assert!(
            !version_markers_compatible("8 миля (вайбкодер remix)", "8 миля"),
            "маркер версии несовместим, но функция пропустила"
        );
    }

    #[test]
    fn accepts_collaboration_lrc_record() {
        // Верная запись: артист в теге трека один, у записи — коллаборация.
        let entry = serde_json::json!({
            "trackName": "что тебя гложет",
            "artistName": "k0vertessence; B4YLUm",
            "duration": 153.0
        });
        let score = score_lrc_track(&entry, "что тебя гложет", "k0vertessence", 153_000.0);
        assert!(score >= 6.0, "верная запись должна проходить, получили {score}");
    }

    #[test]
    fn strips_file_extension_from_title() {
        // «cachalot.mp3» на Genius зовётся «cachalot»: расширение мешает
        // поиску, а вариант без него обязан появиться среди названий.
        let titles = title_variants("ondra adar - cachalot.mp3 (ты не про всех, как и я тоже)");
        assert!(
            titles.iter().any(|t| t == "cachalot"),
            "нет варианта без расширения: {titles:?}"
        );
    }

    #[test]
    fn finds_cachalot_with_typo_in_artist_name() {
        // «ondra adar - cachalot.mp3 (ты не про всех, как и я тоже)» от
        // «alisa-prishhenko»: на Genius песня лежит как «ONDA ANDAR —
        // cachalot». Ник загрузчика чужой, а имя артиста в названии
        // искажено двумя опечатками в коротких словах («ondra», «adar»).
        let titles = title_variants("ondra adar - cachalot.mp3 (ты не про всех, как и я тоже)");
        let artists = artist_variants("alisa-prishhenko");

        let song = serde_json::json!({
            "title": "cachalot",
            "primary_artist": { "name": "ONDA ANDAR" }
        });

        let score = score_genius_song(&song, &titles, &artists);
        assert!(
            score >= 5,
            "верная страница должна проходить, получили {score}"
        );
    }

    #[tokio::test]
    #[ignore = "ходит в сеть: запускать вручную, когда проверяем живой поиск"]
    async fn live_finds_cachalot_by_typo_in_artist() {
        let result = get_lyrics(
            "ondra adar - cachalot.mp3 (ты не про всех, как и я тоже)",
            "alisa-prishhenko",
            "Ты не про всех, как и я тоже. услышь как шипит моя кожа.",
            0.0,
        )
        .await;

        assert!(result.found, "текст не найден: {:?}", result.error);
        let lyrics = result.lyrics.unwrap_or_default();
        assert!(
            lyrics.to_lowercase().contains("как и я тоже"),
            "найден чужой текст: {:?} — {:?}",
            result.title,
            result.artist
        );
        eprintln!("найдено: {:?} — {:?}", result.title, result.artist);
    }

    #[tokio::test]
    #[ignore = "ходит в сеть: запускать вручную, когда проверяем живой поиск"]
    async fn live_finds_love_potions() {
        let result = get_lyrics(
            "Love Potions (feat. Princess Paparazzi)",
            "BJ Lips",
            "",
            173_000.0,
        )
        .await;

        assert!(result.found, "текст не найден: {:?}", result.error);
        let artist = result.artist.clone().unwrap_or_default().to_lowercase();
        assert!(
            artist.contains("bj lips"),
            "найден чужой текст: {:?} — {:?}",
            result.title,
            result.artist
        );
        eprintln!("найдено: {:?} — {:?}", result.title, result.artist);
    }

    #[tokio::test]
    #[ignore = "ходит в сеть: запускать вручную, когда проверяем живой поиск"]
    async fn live_finds_krasavitsa_remix() {
        let result = get_lyrics(
            "Anguish - Красавица (Ремикс) [muzson_com]",
            "Gradoxi",
            "",
            139_000.0,
        )
        .await;

        assert!(result.found, "текст не найден: {:?}", result.error);
        let title = result.title.clone().unwrap_or_default().to_lowercase();
        let artist = result.artist.clone().unwrap_or_default().to_lowercase();
        assert!(
            title.contains("krasavitsa") || artist.contains("anguish"),
            "найден чужой текст: {:?} — {:?}",
            result.title,
            result.artist
        );
        eprintln!("найдено: {:?} — {:?}", result.title, result.artist);
    }

    #[tokio::test]
    #[ignore = "ходит в сеть: запускать вручную, когда проверяем живой поиск"]
    async fn live_rejects_gorgon_city_temptation() {
        let result = get_lyrics("temptation (OUT NOW ON SPOTIFY)", "gorgon", "", 133_000.0).await;

        if result.found {
            let title = result.title.clone().unwrap_or_default().to_lowercase();
            let artist = result.artist.clone().unwrap_or_default().to_lowercase();
            assert!(
                !title.contains("sweet temptation")
                    && !artist.contains("gorgon city")
                    && !title.contains("my girl")
                    && !artist.contains("temptations"),
                "принят чужой текст: {title:?} — {artist:?}"
            );
        }

        eprintln!("итог: found={} {:?}", result.found, result.artist);
    }
}
