//! Content normalization shared by indexing and query planning.
//!
//! The index answers "can this file contain a match?" for rg. Every step here
//! must keep that answer sound: any byte sequence rg could report as a match
//! must survive as a substring of the normalized text.

use regex_syntax::hir::{ClassUnicode, ClassUnicodeRange};
use std::{borrow::Cow, cell::RefCell, collections::HashMap};

/// Bytes read from a large file to decide whether rg would treat it as binary.
/// rg's walker fills a 64 KiB buffer and stops at the first NUL it contains.
pub const BINARY_PROBE_BYTES: usize = 64 * 1024;

/// What the index knows about a file's searchable text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentKind {
    /// The whole file is indexed and contains no NUL byte.
    Text,
    /// Indexed up to the first NUL. rg's directory walk never reports text
    /// after it, but an explicit file argument would, so these files must be
    /// searched through a directory walk.
    Binary,
    /// Nothing is indexed; rg must always scan the file.
    Unindexed,
}

impl ContentKind {
    pub fn code(self) -> u64 {
        match self {
            ContentKind::Text => 0,
            ContentKind::Binary => 1,
            ContentKind::Unindexed => 2,
        }
    }

    pub fn from_code(code: u64) -> Option<Self> {
        match code {
            0 => Some(ContentKind::Text),
            1 => Some(ContentKind::Binary),
            2 => Some(ContentKind::Unindexed),
            _ => None,
        }
    }
}

pub struct Prepared {
    pub text: String,
    pub kind: ContentKind,
}

/// Normalizes file bytes the way rg sees them in a directory walk: BOM-marked
/// UTF-16 is transcoded, everything from the first NUL on is dropped, invalid
/// UTF-8 becomes U+FFFD without disturbing the valid text around it, and
/// characters are case-folded.
pub fn prepare(bytes: &[u8]) -> Prepared {
    let decoded: Cow<'_, str> = match bytes {
        [0xFF, 0xFE, rest @ ..] => Cow::Owned(decode_utf16(rest, u16::from_le_bytes)),
        [0xFE, 0xFF, rest @ ..] => Cow::Owned(decode_utf16(rest, u16::from_be_bytes)),
        _ => {
            let end = bytes.iter().position(|byte| *byte == 0);
            let prefix = &bytes[..end.unwrap_or(bytes.len())];
            let text = String::from_utf8_lossy(prefix);
            let kind = if end.is_some() {
                ContentKind::Binary
            } else {
                ContentKind::Text
            };
            return Prepared {
                text: fold(&text),
                kind,
            };
        }
    };
    match decoded.find('\0') {
        Some(end) => Prepared {
            text: fold(&decoded[..end]),
            kind: ContentKind::Binary,
        },
        None => Prepared {
            text: fold(&decoded),
            kind: ContentKind::Text,
        },
    }
}

fn decode_utf16(bytes: &[u8], unit: fn([u8; 2]) -> u16) -> String {
    let units = bytes.chunks(2).map(|pair| match pair {
        [a, b] => unit([*a, *b]),
        // A dangling byte decodes to a replacement character, like rg does.
        _ => 0xFFFD,
    });
    char::decode_utf16(units)
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

/// Case-folds text one character at a time. Context-free folding keeps the
/// mapping a homomorphism, so a substring of the original always maps to a
/// substring of the folded text (unlike `str::to_lowercase`, which picks a
/// final sigma based on the following character).
pub fn fold(text: &str) -> String {
    text.chars().map(fold_char).collect()
}

/// Maps a character to one canonical member of its Unicode simple case-folding
/// orbit, the equivalence rg uses for `--ignore-case`. Equal images mean the
/// characters can match each other with or without case sensitivity.
pub fn fold_char(c: char) -> char {
    if c.is_ascii() {
        // The smallest member of every ASCII letter orbit is its uppercase
        // form, including orbits with non-ASCII members such as KELVIN SIGN.
        return c.to_ascii_uppercase();
    }
    thread_local! {
        static CACHE: RefCell<HashMap<char, char>> = RefCell::new(HashMap::new());
    }
    CACHE.with(|cache| {
        *cache
            .borrow_mut()
            .entry(c)
            .or_insert_with(|| orbit_minimum(c))
    })
}

fn orbit_minimum(c: char) -> char {
    let mut class = ClassUnicode::new([ClassUnicodeRange::new(c, c)]);
    if class.try_case_fold_simple().is_err() {
        return c;
    }
    class.ranges().first().map_or(c, |range| range.start())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding_is_context_free_and_follows_simple_case_orbits() {
        // "ΚΑΣ".to_lowercase() ends in a final sigma, which would not be a
        // substring of "ΚΑΣΑ".to_lowercase().
        assert!(fold("ΚΑΣΑ").contains(&fold("ΚΑΣ")));
        assert_eq!(fold("κας"), fold("ΚΑΣ"));
        // KELVIN SIGN and LONG S fold together with ASCII letters under -i.
        assert_eq!(fold("\u{212A}"), fold("k"));
        assert_eq!(fold("\u{17F}"), fold("S"));
        assert_eq!(fold("ToolUseList"), fold("TOOLUSELIST"));
        assert_eq!(fold("路径"), "路径");
    }

    #[test]
    fn prepare_keeps_valid_text_from_non_utf8_files() {
        let prepared = prepare(b"caf\xe9 NEEDLE_LATIN1\n");
        assert_eq!(prepared.kind, ContentKind::Text);
        assert!(prepared.text.contains(&fold("NEEDLE_LATIN1")));
    }

    #[test]
    fn prepare_transcodes_utf16_with_a_bom() {
        let mut little = vec![0xFF, 0xFE];
        little.extend("NEEDLE_UTF16\n".encode_utf16().flat_map(u16::to_le_bytes));
        let mut big = vec![0xFE, 0xFF];
        big.extend("NEEDLE_UTF16\n".encode_utf16().flat_map(u16::to_be_bytes));
        for bytes in [little, big] {
            let prepared = prepare(&bytes);
            assert_eq!(prepared.kind, ContentKind::Text);
            assert!(prepared.text.contains(&fold("NEEDLE_UTF16")));
        }
    }

    #[test]
    fn prepare_stops_at_the_first_nul_like_rg() {
        let prepared = prepare(b"before NEEDLE\n\0after SECRET\n");
        assert_eq!(prepared.kind, ContentKind::Binary);
        assert!(prepared.text.contains(&fold("NEEDLE")));
        assert!(!prepared.text.contains(&fold("SECRET")));
    }
}
