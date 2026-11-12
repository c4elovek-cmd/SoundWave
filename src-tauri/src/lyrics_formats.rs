//! Разбор форматов караоке: LRC, Enhanced LRC/RichSync, TTML, QRC, YRC.
//!
//! Модель повторяет нормализатор NeDotify: источник отдаёт свой формат,
//! мы превращаем его в единую структуру строк со слово-таймингами. Валидация
//! общая — монотонность строк и слов, ограничения по количеству и размеру.
//! Порт логики: `services/lyrics_formats.py` из NeDotify.

use regex::Regex;

/// Максимальный размер входного текста — 2 МиБ.
const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
/// Потолок строк в одной разметке.
const MAX_LINES: usize = 5000;
/// Потолок слов.
const MAX_WORDS: usize = 50_000;
/// Потолок времени (24 часа).
const MAX_TIME_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// Ошибки парсинга: неверный формат, небезопасные данные, битые тайминги.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LyricParseError {
    /// Пустой или слишком большой ввод.
    InvalidInput,
    /// Строка/слово с невалидным таймингом.
    InvalidTiming,
    /// В тексте есть DTD/сущности (запрещено ради безопасности).
    UnsafeXml,
    /// XML не разобрался.
    BadXml,
    /// Слишком много узлов XML (защита от раздутого документа).
    TooManyXmlNodes,
    /// Формат не определён или не поддерживается.
    UnsupportedFormat,
    /// Текст пустой после разбора.
    Empty,
}

/// Слово с таймингом (миллисекунды).
#[derive(Debug, Clone, Default)]
pub struct Word {
    pub text: String,
    pub start_ms: f64,
    pub end_ms: f64,
}

/// Строка караоке: общие границы + слова + флаг фоновой строки.
#[derive(Debug, Clone, Default)]
pub struct Line {
    pub start_ms: f64,
    pub end_ms: f64,
    pub words: Vec<Word>,
    pub background: bool,
}

/// Нормализованная разметка караоке.
#[derive(Debug, Clone, Default)]
pub struct Lyrics {
    /// `plain` — без таймингов, `line` — строки, `word`/`syllable` — слова.
    pub sync_type: String,
    pub lines: Vec<Line>,
}

impl Lyrics {
    /// Проверка корректности модели — как `validate_lyrics` в NeDotify.
    pub fn validate(&self, duration_ms: f64) -> bool {
        if self.lines.is_empty() || self.lines.len() > MAX_LINES {
            return false;
        }
        let limit = if duration_ms > 0.0 {
            (duration_ms + (duration_ms * 0.01).max(2000.0)).min(MAX_TIME_MS)
        } else {
            MAX_TIME_MS
        };
        let mut previous_line = -1.0f64;
        let mut words_total = 0usize;
        let mut chars_total = 0usize;
        for line in &self.lines {
            if line.words.is_empty() {
                return false;
            }
            if !(line.start_ms >= 0.0
                && line.start_ms <= line.end_ms
                && line.end_ms <= limit
                && line.start_ms >= previous_line)
            {
                return false;
            }
            previous_line = line.start_ms;
            let mut previous_word = line.start_ms;
            for word in &line.words {
                if !(word.start_ms >= line.start_ms
                    && word.start_ms <= word.end_ms
                    && word.end_ms <= line.end_ms
                    && word.start_ms >= previous_word)
                {
                    return false;
                }
                previous_word = word.start_ms;
                words_total += 1;
                chars_total += word.text.chars().count();
            }
            if !line.words.iter().any(|w| !w.text.trim().is_empty()) {
                return false;
            }
        }
        words_total <= MAX_WORDS && chars_total <= MAX_INPUT_BYTES
    }

    /// Человекочитаемый текст без таймингов.
    pub fn plain_text(&self) -> String {
        self.lines
            .iter()
            .map(|line| {
                line.words
                    .iter()
                    .map(|w| w.text.as_str())
                    .collect::<Vec<_>>()
                    .concat()
                    .trim()
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Универсальный разбор: определяет формат и разбирает.
pub fn parse(text: &str, duration_ms: f64) -> Result<Lyrics, LyricParseError> {
    if text.len() > MAX_INPUT_BYTES {
        return Err(LyricParseError::InvalidInput);
    }
    if text.trim().is_empty() {
        return Err(LyricParseError::Empty);
    }

    let looks_ttml = Regex::new(r"(?i)<(?:\w+:)?tt\b")
        .map(|re| re.is_match(text))
        .unwrap_or(false);
    let looks_lrc = Regex::new(r"\[\d{1,3}:\d{2}")
        .map(|re| re.is_match(text))
        .unwrap_or(false);

    let result = if looks_ttml {
        parse_ttml(text)?
    } else if looks_lrc {
        parse_lrc(text, duration_ms)?
    } else {
        return Err(LyricParseError::UnsupportedFormat);
    };

    if !result.validate(duration_ms) {
        return Err(LyricParseError::InvalidTiming);
    }
    Ok(result)
}

/// миллисекунды из `mm:ss.xx` / `hh:mm:ss.xx` (минуты и секунды — числа).
fn stamp_to_ms(minutes: &str, seconds: &str, fraction: &str) -> Result<f64, LyricParseError> {
    let min: f64 = minutes.parse().map_err(|_| LyricParseError::InvalidTiming)?;
    let sec: f64 = seconds.parse().map_err(|_| LyricParseError::InvalidTiming)?;
    if sec >= 60.0 {
        return Err(LyricParseError::InvalidTiming);
    }
    let frac_ms = if fraction.is_empty() {
        0.0
    } else {
        // Дробная часть: берём до 3 знаков, дополняем нулями до 3.
        let mut f = fraction.to_string();
        f.truncate(3);
        while f.len() < 3 {
            f.push('0');
        }
        f.parse::<f64>().map_err(|_| LyricParseError::InvalidTiming)?
    };
    Ok(min * 60_000.0 + sec * 1_000.0 + frac_ms)
}

/// LRC + Enhanced LRC (метки слов `<mm:ss.xx>`).
pub fn parse_lrc(text: &str, duration_ms: f64) -> Result<Lyrics, LyricParseError> {
    let re_line = Regex::new(r"\[(\d{1,3}):(\d{2})(?:[.:](\d+))?\]").unwrap();
    let re_word = Regex::new(r"<(\d{1,3}):(\d{2})(?:[.:](\d+))?>").unwrap();

    // Сначала собираем пары «время строки → текст строки».
    let mut rows: Vec<(f64, String)> = Vec::new();
    for raw in text.lines() {
        let mut stamps: Vec<f64> = Vec::new();
        let mut last_end = 0usize;
        for cap in re_line.captures_iter(raw) {
            let m = cap.get(0).unwrap();
            last_end = m.end();
            stamps.push(stamp_to_ms(
                cap.get(1).map(|c| c.as_str()).unwrap_or("0"),
                cap.get(2).map(|c| c.as_str()).unwrap_or("0"),
                cap.get(3).map(|c| c.as_str()).unwrap_or(""),
            )?);
        }
        if stamps.is_empty() {
            continue;
        }
        let content = raw[last_end..].trim();
        if content.is_empty() {
            continue;
        }
        // Повторяющиеся метки подряд = повтор строки.
        for stamp in stamps {
            rows.push((stamp, content.to_string()));
            if rows.len() > MAX_LINES {
                return Err(LyricParseError::InvalidTiming);
            }
        }
    }
    rows.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

    let mut lines: Vec<Line> = Vec::new();
    let mut has_words = false;
    for (index, (raw_start, content)) in rows.iter().enumerate() {
        let raw_end = if index + 1 < rows.len() {
            rows[index + 1].0
        } else {
            duration_ms + 1000.0
        };
        let markers: Vec<(usize, usize, f64)> = re_word
            .captures_iter(content)
            .map(|cap| {
                let whole = cap.get(0).unwrap();
                (
                    whole.start(),
                    whole.end(),
                    stamp_to_ms(
                        cap.get(1).map(|c| c.as_str()).unwrap_or("0"),
                        cap.get(2).map(|c| c.as_str()).unwrap_or("0"),
                        cap.get(3).map(|c| c.as_str()).unwrap_or(""),
                    )
                    .unwrap_or(0.0),
                )
            })
            .collect();

        let line_start = (*raw_start).max(0.0);
        let line_end = raw_end.max(line_start);
        if markers.is_empty() {
            lines.push(Line {
                start_ms: line_start,
                end_ms: line_end,
                words: vec![Word {
                    text: content.clone(),
                    start_ms: line_start,
                    end_ms: line_end,
                }],
                background: false,
            });
            continue;
        }

        // Текст до первой метки без тайминга — считаем ошибкой разметки.
        if !content[..markers[0].0].trim().is_empty() {
            return Err(LyricParseError::InvalidTiming);
        }

        let mut words: Vec<Word> = Vec::new();
        for (i, (_start, end, stamp)) in markers.iter().enumerate() {
            let stop = if i + 1 < markers.len() {
                markers[i + 1].0
            } else {
                content.len()
            };
            let fragment = content[*end..stop].trim();
            if fragment.is_empty() {
                continue;
            }
            let next_start = if i + 1 < markers.len() {
                markers[i + 1].2
            } else {
                line_end
            };
            if *stamp < line_start || next_start < *stamp {
                return Err(LyricParseError::InvalidTiming);
            }
            words.push(Word {
                text: fragment.to_string(),
                start_ms: (*stamp).max(0.0),
                end_ms: next_start.max(0.0),
            });
        }
        if words.is_empty() {
            continue;
        }
        let end = words
            .iter()
            .map(|w| w.end_ms)
            .fold(line_end, |acc, v| acc.max(v));
        has_words = true;
        lines.push(Line {
            start_ms: line_start,
            end_ms: end,
            words,
            background: false,
        });
    }

    Ok(Lyrics {
        sync_type: if has_words { "word".into() } else { "line".into() },
        lines,
    })
}

/// Безопасная проверка XML: запрет DTD/сущностей, лимит узлов.
fn check_xml_safety(xml: &str) -> Result<(), LyricParseError> {
    let lower = xml.to_lowercase();
    if lower.contains("<!doctype") || lower.contains("<!entity") {
        return Err(LyricParseError::UnsafeXml);
    }
    let opens = xml.matches('<').count();
    let closes = xml.matches('>').count();
    if opens > 10_000 || closes > 10_000 {
        return Err(LyricParseError::TooManyXmlNodes);
    }
    Ok(())
}

/// TTML-время в миллисекунды (относительные единицы и `hh:mm:ss.ff`).
fn ttml_time(value: &str, parent_start: f64, frame_rate: f64, tick_rate: f64) -> Result<f64, LyricParseError> {
    let value = value.trim();
    let units: [(&str, f64); 6] = [
        ("ms", 1.0),
        ("h", 3_600_000.0),
        ("m", 60_000.0),
        ("s", 1_000.0),
        ("f", 1000.0 / frame_rate),
        ("t", 1000.0 / tick_rate),
    ];
    // Порядок важен: «ms» раньше «m» и «s».
    for (suffix, factor) in units {
        if let Some(num) = value.strip_suffix(suffix) {
            let amount: f64 = num.trim().parse().map_err(|_| LyricParseError::InvalidTiming)?;
            return Ok(parent_start + amount * factor);
        }
    }
    // Абсолютное время `hh:mm:ss.xx` / `mm:ss.xx`.
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return Err(LyricParseError::InvalidTiming);
    }
    let (hh, mm, rest) = if parts.len() == 3 {
        (parts[0], parts[1], parts[2])
    } else {
        ("0", parts[0], parts[1])
    };
    let hour: f64 = hh.parse().map_err(|_| LyricParseError::InvalidTiming)?;
    let minute: f64 = mm.parse().map_err(|_| LyricParseError::InvalidTiming)?;
    if minute >= 60.0 {
        return Err(LyricParseError::InvalidTiming);
    }
    let (sec, frac) = if let Some((s, f)) = rest.split_once('.') {
        (s, f)
    } else {
        (rest, "")
    };
    let sec_f = stamp_to_ms("0", sec, frac)?;
    Ok(hour * 3_600_000.0 + minute * 60_000.0 + sec_f)
}

/// Разбор TTML. Намеренно без полноценного XML-парсера: источники отдают
/// предсказуемый TTML, а DTD/сущности уже отсечены.
pub fn parse_ttml(text: &str) -> Result<Lyrics, LyricParseError> {
    check_xml_safety(text)?;

    let re_frame = Regex::new(r#"frameRate\s*=\s*"(\d+(?:\.\d+)?)""#).unwrap();
    let re_tick = Regex::new(r#"tickRate\s*=\s*"(\d+)"#).unwrap();
    let frame_rate = re_frame
        .captures(text)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0 && *v <= 240.0)
        .unwrap_or(30.0);
    let tick_rate = re_tick
        .captures(text)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(1.0);

    let re_begin = Regex::new(r#"begin\s*=\s*"([^"]+)""#).unwrap();
    let re_end = Regex::new(r#"end\s*=\s*"([^"]+)""#).unwrap();
    let re_dur = Regex::new(r#"dur\s*=\s*"([^"]+)""#).unwrap();
    let re_p = Regex::new(r"(?s)<p\b[^>]*>(.*?)</p>").unwrap();
    let re_span = Regex::new(r"(?s)<span\b([^>]*)>(.*?)</span>").unwrap();
    let re_text = Regex::new(r"(?s)<[^>]+>").unwrap();

    let mut lines: Vec<Line> = Vec::new();

    for p in re_p.captures_iter(text) {
        let p_all = p.get(0).unwrap().as_str();
        let p_body = p.get(1).unwrap().as_str();

        // Тег <p ...>: атрибуты берём из начала p_all.
        let p_tag_end = p_all.find('>').unwrap_or(p_all.len());
        let p_tag = &p_all[..p_tag_end];

        let line_start = re_begin
            .captures(p_tag)
            .and_then(|c| c.get(1))
            .and_then(|m| ttml_time(m.as_str(), 0.0, frame_rate, tick_rate).ok())
            .unwrap_or(0.0);
        let line_end = re_end
            .captures(p_tag)
            .and_then(|c| c.get(1))
            .and_then(|m| ttml_time(m.as_str(), line_start, frame_rate, tick_rate).ok())
            .or_else(|| {
                re_dur
                    .captures(p_tag)
                    .and_then(|c| c.get(1))
                    .and_then(|m| ttml_time(m.as_str(), line_start, frame_rate, tick_rate).ok())
                    .map(|d| line_start + d)
            })
            .unwrap_or(line_start + 3000.0);

        // Слова из <span begin=...>: тайминг у спана, текст — его содержимое.
        let mut words: Vec<Word> = Vec::new();
        let mut last_end = line_start;
        for span in re_span.captures_iter(p_body) {
            let attrs = span.get(1).map(|m| m.as_str()).unwrap_or("");
            let body = span.get(2).map(|m| m.as_str()).unwrap_or("");
            let text = re_text.replace_all(body, " ");
            let text = text
                .replace("<br/>", "\n")
                .replace("<br>", "\n")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">");
            let text = text.trim();
            if text.is_empty() {
                continue;
            }

            let begin = re_begin
                .captures(attrs)
                .and_then(|c| c.get(1))
                .and_then(|m| ttml_time(m.as_str(), line_start, frame_rate, tick_rate).ok());
            let end = re_end
                .captures(attrs)
                .and_then(|c| c.get(1))
                .and_then(|m| ttml_time(m.as_str(), line_start, frame_rate, tick_rate).ok())
                .or_else(|| {
                    re_dur
                        .captures(attrs)
                        .and_then(|c| c.get(1))
                        .and_then(|m| ttml_time(m.as_str(), line_start, frame_rate, tick_rate).ok())
                        .map(|d| (begin.unwrap_or(last_end)) + d)
                });

            match (begin, end) {
                (Some(b), Some(e)) if b >= line_start && e >= b => {
                    words.push(Word {
                        text: text.to_string(),
                        start_ms: b,
                        end_ms: e,
                    });
                    last_end = e;
                }
                _ => {
                    // Спан без тайминга — просто текст строки.
                    words.push(Word {
                        text: text.to_string(),
                        start_ms: last_end,
                        end_ms: last_end,
                    });
                }
            }
        }

        // Полный текст <p> без тегов — сравниваем с текстом таймированных
        // спанов. Если fuera остаётся текст («Привет, <span>мир</span>»),
        // у строки есть untimed-часть: по правилам NeDotify слово-тайминги
        // считать нельзя — делаем строку line-level, но разбиваем её на
        // слова с равномерными таймингами, чтобы фронтенд мог подсвечивать.
        let plain_all = re_text.replace_all(p_body, " ");
        let plain_all = plain_all
            .replace("<br/>", "\n")
            .replace("<br>", "\n")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">");
        let plain_all = plain_all.trim().to_string();
        let timed_text: String = words
            .iter()
            .filter(|w| w.end_ms > w.start_ms)
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .concat()
            .trim()
            .to_string();

        let has_timed = !timed_text.is_empty();
        let has_untimed = has_timed && plain_all != timed_text;

        if !has_timed || has_untimed {
            if plain_all.is_empty() {
                continue;
            }
            let tokens: Vec<&str> = plain_all.split_whitespace().collect();
            let count = tokens.len().max(1) as f64;
            let span = (line_end - line_start) / count;
            let line_words: Vec<Word> = tokens
                .iter()
                .enumerate()
                .map(|(i, token)| Word {
                    text: (*token).to_string(),
                    start_ms: line_start + span * i as f64,
                    end_ms: line_start + span * (i + 1) as f64,
                })
                .collect();
            lines.push(Line {
                start_ms: line_start,
                end_ms: line_end,
                words: line_words,
                background: false,
            });
        } else {
            let start = words.first().map(|w| w.start_ms).unwrap_or(line_start);
            let end = words.last().map(|w| w.end_ms).unwrap_or(line_end);
            lines.push(Line {
                start_ms: start,
                end_ms: end,
                words,
                background: false,
            });
        }
    }

    if lines.is_empty() {
        return Err(LyricParseError::Empty);
    }
    lines.sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap());
    Ok(Lyrics {
        sync_type: if lines.iter().any(|l| l.words.iter().any(|w| w.end_ms > w.start_ms)) {
            "word".into()
        } else {
            "line".into()
        },
        lines,
    })
}

/// Перевод нормализованной модели в стандартный строчный LRC
/// `[mm:ss.xx] Текст строки`. Аналог `to_lrc(model)` из NeDotify.
pub fn to_lrc(lyrics: &Lyrics) -> String {
    if lyrics.sync_type == "plain" {
        return lyrics.plain_text();
    }
    let mut out: Vec<String> = Vec::with_capacity(lyrics.lines.len());
    for line in &lyrics.lines {
        let total_ms = line.start_ms.max(0.0).round() as u64;
        let minute = total_ms / 60_000;
        let remainder = total_ms % 60_000;
        let second = remainder / 1000;
        let frac_hundredths = (remainder % 1000) / 10;
        let line_text: String = line
            .words
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .concat();
        let trimmed = line_text.trim();
        if trimmed.is_empty() {
            continue;
        }
        out.push(format!(
            "[{:02}:{:02}.{:02}] {}",
            minute, second, frac_hundredths, trimmed
        ));
    }
    out.join("\n")
}

/// QRC/YRC (`[start,length]` строки + `(start,length)` слова).
pub fn parse_numeric(text: &str, format: &str) -> Result<Lyrics, LyricParseError> {
    let body = if text.trim_start().starts_with('<') {
        check_xml_safety(text)?;
        let re_content = Regex::new(r"(?s)<LyricContent>(.*?)</LyricContent>").unwrap();
        re_content
            .captures(text)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .ok_or(LyricParseError::BadXml)?
    } else {
        text.to_string()
    };

    let re_line = Regex::new(r"\[(\d+),(\d+)\]").unwrap();
    let re_word = if format == "yrc" {
        Regex::new(r"\((\d+),(\d+),(\d+)\)").unwrap()
    } else {
        Regex::new(r"\((\d+),(\d+)\)").unwrap()
    };

    let headers: Vec<(usize, usize, u64, u64)> = re_line
        .captures_iter(&body)
        .map(|cap| {
            let whole = cap.get(0).unwrap();
            (
                whole.start(),
                whole.end(),
                cap.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(0),
                cap.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0),
            )
        })
        .collect();

    let mut lines: Vec<Line> = Vec::new();
    for (index, (_start_pos, end_pos, line_start, line_len)) in headers.iter().enumerate() {
        let content_end = if index + 1 < headers.len() {
            headers[index + 1].0
        } else {
            body.len()
        };
        let content = &body[*end_pos..content_end];
        let markers: Vec<(usize, usize, u64, u64)> = re_word
            .captures_iter(content)
            .map(|cap| {
                let whole = cap.get(0).unwrap();
                (
                    whole.start(),
                    whole.end(),
                    cap.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(0),
                    cap.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0),
                )
            })
            .collect();

        let mut words: Vec<Word> = Vec::new();
        if format == "yrc" {
            // YRC: маркер перед словом, текст — до следующего маркера.
            if let Some(first) = markers.first() {
                if !content[..first.0].trim().is_empty() {
                    return Err(LyricParseError::InvalidTiming);
                }
            }
            for (i, (_start, end, word_start, word_len)) in markers.iter().enumerate() {
                let stop = if i + 1 < markers.len() {
                    markers[i + 1].0
                } else {
                    content.len()
                };
                let fragment = content[*end..stop].trim();
                if fragment.is_empty() {
                    continue;
                }
                words.push(Word {
                    text: fragment.to_string(),
                    start_ms: *word_start as f64,
                    end_ms: (*word_start + *word_len) as f64,
                });
            }
        } else {
            // QRC: маркер после слова.
            let mut cursor = 0usize;
            for (start, end, word_start, word_len) in markers.iter() {
                let fragment = content[cursor..*start].trim();
                if !fragment.is_empty() {
                    words.push(Word {
                        text: fragment.to_string(),
                        start_ms: *word_start as f64,
                        end_ms: (*word_start + *word_len) as f64,
                    });
                }
                cursor = *end;
            }
            let tail = content[cursor.min(content.len())..].trim();
            if !tail.is_empty() {
                return Err(LyricParseError::InvalidTiming);
            }
        }

        if words.is_empty() {
            continue;
        }
        let start_ms = words.first().map(|w| w.start_ms).unwrap_or(*line_start as f64);
        let end_ms = words.last().map(|w| w.end_ms).unwrap_or((*line_start + *line_len) as f64);
        lines.push(Line {
            start_ms,
            end_ms,
            words,
            background: false,
        });
    }

    if lines.is_empty() {
        return Err(LyricParseError::Empty);
    }
    lines.sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap());
    Ok(Lyrics {
        sync_type: "word".into(),
        lines,
    })
}

/// Модель в JSON — формат, который ждёт фронтенд.
pub fn to_json(lyrics: &Lyrics) -> String {
    serde_json::json!({
        "syncType": lyrics.sync_type,
        "lines": lyrics.lines.iter().map(|line| {
            serde_json::json!({
                "startMs": line.start_ms,
                "endMs": line.end_ms,
                "background": line.background,
                "words": line.words.iter().map(|w| {
                    serde_json::json!({
                        "text": w.text,
                        "startMs": w.start_ms,
                        "endMs": w.end_ms
                    })
                }).collect::<Vec<_>>()
            })
        }).collect::<Vec<_>>()
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_lrc() {
        let text = "[00:12.00]Привет, мир\n[00:15.50]Как дела";
        let parsed = parse(text, 20_000.0).unwrap();
        assert_eq!(parsed.lines.len(), 2);
        assert_eq!(parsed.lines[0].words[0].text, "Привет, мир");
        assert!((parsed.lines[0].start_ms - 12_000.0).abs() < 1.0);
    }

    #[test]
    fn parses_enhanced_lrc() {
        let text = "[00:12.00]<00:12.00>При<00:12.40>вет<00:12.90> мир";
        let parsed = parse(text, 20_000.0).unwrap();
        assert_eq!(parsed.sync_type, "word");
        assert_eq!(parsed.lines[0].words.len(), 3);
        assert_eq!(parsed.lines[0].words[1].text, "вет");
        assert!((parsed.lines[0].words[1].start_ms - 12_400.0).abs() < 1.0);
    }

    #[test]
    fn parses_ttml() {
        let text = r#"<?xml version="1.0"?>
            <tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter">
              <body>
                <div>
                  <p begin="00:00:12.00" end="00:00:15.00">Привет, <span begin="00:00:12.50" end="00:00:13.00">мир</span></p>
                </div>
              </body>
            </tt>"#;
        let parsed = parse_ttml(text).unwrap();
        assert_eq!(parsed.lines.len(), 1);
        assert!(parsed.lines[0].words.len() >= 2);
        let lrc = to_lrc(&parsed);
        assert!(lrc.starts_with("[00:12.00]"));
    }

    #[test]
    fn parses_qrc() {
        // QRC: маркер `(start,len)` стоит ПОСЛЕ фрагмента, к которому относится.
        let text = "[1000,2000]Hello(0,500)world(500,500)";
        let parsed = parse_numeric(text, "qrc").unwrap();
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].words.len(), 2);
        assert_eq!(parsed.lines[0].words[0].text, "Hello");
        assert_eq!(parsed.lines[0].words[1].text, "world");
    }

    #[test]
    fn parses_yrc() {
        let text = "[1000,2000](0,500,0)Hello(500,500,100)world";
        let parsed = parse_numeric(text, "yrc").unwrap();
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].words.len(), 2);
        assert_eq!(parsed.lines[0].words[1].text, "world");
    }

    #[test]
    fn rejects_unsafe_xml() {
        let text = "<!DOCTYPE tt [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><tt/>";
        assert!(parse_ttml(text).is_err());
    }
}