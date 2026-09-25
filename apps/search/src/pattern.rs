//! Turns an rg pattern into a trigram requirement for candidate selection.
//!
//! The requirement must hold for every file that contains a match, so each
//! rule below only ever weakens what it cannot prove. Patterns that cannot be
//! narrowed produce no requirement and the caller falls back to a full rg walk.

use crate::content::{fold, fold_char};
use regex_syntax::{
    hir::{Class, Hir, HirKind, Repetition},
    ParserBuilder,
};
use std::collections::BTreeSet;
use tantivy::{
    query::{BooleanQuery, Query, TermQuery},
    schema::{Field, IndexRecordOption},
    Term,
};

/// Trigram n-gram size used by the content analyzer.
pub const GRAM_CHARS: usize = 3;
/// Upper bound on the strings tracked for one sub-expression.
const MAX_EXACT_STRINGS: usize = 16;
/// Upper bound on the length of a tracked string, in characters.
const MAX_EXACT_CHARS: usize = 64;
/// Classes larger than this are treated as "any character".
const MAX_CLASS_CHARS: u32 = 32;
/// Folded classes with more distinct characters than this are not expanded.
const MAX_CLASS_FOLDED: usize = 4;

/// A necessary condition on a file's folded content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Requirement {
    /// Every trigram of the folded literal occurs in the file.
    Literal(String),
    All(Vec<Requirement>),
    Any(Vec<Requirement>),
}

/// Derives the requirement for `pattern` under rg's matching flags. Returns
/// `None` when the index cannot narrow the search, including patterns this
/// parser rejects: rg stays the authority on syntax errors.
pub fn requirement(
    pattern: &str,
    fixed_strings: bool,
    case_insensitive: bool,
) -> Option<Requirement> {
    let req = if fixed_strings {
        literal_req(&fold(pattern))
    } else {
        let hir = ParserBuilder::new()
            .case_insensitive(case_insensitive)
            // rg searches bytes, so patterns such as (?-u:\xFF) are valid.
            .utf8(false)
            .build()
            .parse(pattern)
            .ok()?;
        analyze(&hir).req
    };
    req.into_requirement()
}

/// Builds the tantivy query for a requirement over the trigram content field.
pub fn build_query(requirement: &Requirement, field: Field) -> Box<dyn Query> {
    match requirement {
        Requirement::Literal(literal) => {
            let chars: Vec<char> = literal.chars().collect();
            let grams: BTreeSet<String> = chars
                .windows(GRAM_CHARS)
                .map(|window| window.iter().collect())
                .collect();
            let mut queries: Vec<Box<dyn Query>> = grams
                .into_iter()
                .map(|gram| {
                    Box::new(TermQuery::new(
                        Term::from_field_text(field, &gram),
                        IndexRecordOption::Basic,
                    )) as Box<dyn Query>
                })
                .collect();
            if queries.len() == 1 {
                queries.remove(0)
            } else {
                Box::new(BooleanQuery::intersection(queries))
            }
        }
        Requirement::All(parts) => Box::new(BooleanQuery::intersection(
            parts.iter().map(|part| build_query(part, field)).collect(),
        )),
        Requirement::Any(parts) => Box::new(BooleanQuery::union(
            parts.iter().map(|part| build_query(part, field)).collect(),
        )),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Req {
    True,
    Literal(String),
    All(Vec<Req>),
    Any(Vec<Req>),
}

impl Req {
    fn all(parts: Vec<Req>) -> Req {
        let mut flat = Vec::new();
        for part in parts {
            match part {
                Req::True => {}
                Req::All(inner) => flat.extend(inner),
                other => flat.push(other),
            }
        }
        dedup(&mut flat);
        match flat.len() {
            0 => Req::True,
            1 => flat.remove(0),
            _ => Req::All(flat),
        }
    }

    fn any(parts: Vec<Req>) -> Req {
        let mut flat = Vec::new();
        for part in parts {
            match part {
                Req::True => return Req::True,
                Req::Any(inner) => flat.extend(inner),
                other => flat.push(other),
            }
        }
        dedup(&mut flat);
        match flat.len() {
            // An empty alternation matches nothing; claiming nothing is safe.
            0 => Req::True,
            1 => flat.remove(0),
            _ => Req::Any(flat),
        }
    }

    fn into_requirement(self) -> Option<Requirement> {
        match self {
            Req::True => None,
            Req::Literal(literal) => Some(Requirement::Literal(literal)),
            Req::All(parts) => Some(Requirement::All(
                parts
                    .into_iter()
                    .filter_map(Req::into_requirement)
                    .collect(),
            )),
            Req::Any(parts) => Some(Requirement::Any(
                parts
                    .into_iter()
                    .filter_map(Req::into_requirement)
                    .collect(),
            )),
        }
    }
}

fn dedup(parts: &mut Vec<Req>) {
    let mut seen = Vec::with_capacity(parts.len());
    parts.retain(|part| {
        if seen.contains(part) {
            false
        } else {
            seen.push(part.clone());
            true
        }
    });
}

/// `exact` lists every folded string the expression can match when that set
/// is small; `req` holds for any file containing a match.
struct Info {
    exact: Option<Vec<String>>,
    req: Req,
}

impl Info {
    fn unknown(req: Req) -> Info {
        Info { exact: None, req }
    }

    fn exact(strings: Vec<String>) -> Info {
        Info {
            req: any_literal(&strings),
            exact: Some(strings),
        }
    }
}

fn literal_req(folded: &str) -> Req {
    if folded.chars().count() >= GRAM_CHARS {
        Req::Literal(folded.to_string())
    } else {
        Req::True
    }
}

/// A match of one of `strings` implies one of their literal requirements. A
/// short member means the match may contain no trigram at all.
fn any_literal(strings: &[String]) -> Req {
    if strings.is_empty() {
        return Req::True;
    }
    Req::any(strings.iter().map(|string| literal_req(string)).collect())
}

fn analyze(hir: &Hir) -> Info {
    match hir.kind() {
        HirKind::Empty | HirKind::Look(_) => Info::exact(vec![String::new()]),
        HirKind::Literal(literal) => match std::str::from_utf8(&literal.0) {
            Ok(text) => Info::exact(vec![fold(text)]),
            Err(_) => Info::unknown(Req::True),
        },
        HirKind::Class(class) => class_info(class),
        HirKind::Repetition(repetition) => repetition_info(repetition),
        HirKind::Capture(capture) => analyze(&capture.sub),
        HirKind::Concat(parts) => concat_info(parts),
        HirKind::Alternation(parts) => alternation_info(parts),
    }
}

fn class_info(class: &Class) -> Info {
    let mut folded = BTreeSet::new();
    let mut size = 0u32;
    match class {
        Class::Unicode(class) => {
            for range in class.ranges() {
                size += range.end() as u32 - range.start() as u32 + 1;
                if size > MAX_CLASS_CHARS {
                    return Info::unknown(Req::True);
                }
                folded.extend((range.start()..=range.end()).map(fold_char));
            }
        }
        Class::Bytes(class) => {
            for range in class.ranges() {
                size += u32::from(range.end() - range.start()) + 1;
                if size > MAX_CLASS_CHARS || !range.end().is_ascii() {
                    return Info::unknown(Req::True);
                }
                folded.extend((range.start()..=range.end()).map(|byte| fold_char(byte as char)));
            }
        }
    }
    // An empty class matches nothing; treat it as unconstrained.
    if folded.is_empty() || folded.len() > MAX_CLASS_FOLDED {
        return Info::unknown(Req::True);
    }
    Info::exact(folded.into_iter().map(String::from).collect())
}

fn repetition_info(repetition: &Repetition) -> Info {
    if repetition.min == 0 {
        return Info::unknown(Req::True);
    }
    let sub = analyze(&repetition.sub);
    if repetition.max == Some(repetition.min) && repetition.min <= 3 {
        if let Some(strings) = &sub.exact {
            let mut product = vec![String::new()];
            for _ in 0..repetition.min {
                match cross(&product, strings) {
                    Some(next) => product = next,
                    None => return Info::unknown(sub.req),
                }
            }
            return Info::exact(product);
        }
    }
    // At least one occurrence of the sub-expression is required.
    Info::unknown(sub.req)
}

fn concat_info(parts: &[Hir]) -> Info {
    let mut reqs = Vec::new();
    let mut run = vec![String::new()];
    let mut whole = true;
    for part in parts {
        let info = analyze(part);
        match info.exact {
            Some(strings) => match cross(&run, &strings) {
                Some(product) => run = product,
                None => {
                    reqs.push(any_literal(&run));
                    run = strings;
                    whole = false;
                }
            },
            None => {
                reqs.push(any_literal(&run));
                reqs.push(info.req);
                run = vec![String::new()];
                whole = false;
            }
        }
    }
    if whole {
        return Info::exact(run);
    }
    reqs.push(any_literal(&run));
    Info::unknown(Req::all(reqs))
}

fn alternation_info(parts: &[Hir]) -> Info {
    let infos: Vec<Info> = parts.iter().map(analyze).collect();
    let mut union = BTreeSet::new();
    let mut exact = true;
    for info in &infos {
        match &info.exact {
            Some(strings) => union.extend(strings.iter().cloned()),
            None => exact = false,
        }
    }
    if exact && union.len() <= MAX_EXACT_STRINGS {
        return Info::exact(union.into_iter().collect());
    }
    Info::unknown(Req::any(infos.into_iter().map(|info| info.req).collect()))
}

fn cross(prefixes: &[String], suffixes: &[String]) -> Option<Vec<String>> {
    if prefixes.len() * suffixes.len() > MAX_EXACT_STRINGS {
        return None;
    }
    let mut product = BTreeSet::new();
    for prefix in prefixes {
        for suffix in suffixes {
            let joined = format!("{prefix}{suffix}");
            if joined.chars().count() > MAX_EXACT_CHARS {
                return None;
            }
            product.insert(joined);
        }
    }
    Some(product.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lit(text: &str) -> Requirement {
        Requirement::Literal(fold(text))
    }

    fn all(parts: Vec<Requirement>) -> Requirement {
        Requirement::All(parts)
    }

    fn any(parts: Vec<Requirement>) -> Requirement {
        Requirement::Any(parts)
    }

    fn regex(pattern: &str) -> Option<Requirement> {
        requirement(pattern, false, false)
    }

    #[test]
    fn literals_and_escapes_resolve_like_rg() {
        assert_eq!(regex("handleFSSearch"), Some(lit("handleFSSearch")));
        assert_eq!(regex(r"foo\.bar"), Some(lit("foo.bar")));
        assert_eq!(regex(r"\bfoo\b"), Some(lit("foo")));
        // Escapes that name characters must not split the literal.
        assert_eq!(regex(r"NEEDLE_S\x52C"), Some(lit("NEEDLE_SRC")));
        assert_eq!(regex(r"foo\u0041bar"), Some(lit("fooAbar")));
        assert_eq!(regex(r"\x{41}bcd"), Some(lit("Abcd")));
        // rg's default engine rejects \Q...\E; rg reports that error itself.
        assert_eq!(regex(r"foo\Qa.b\E"), None);
        // (?x) ignores whitespace in the pattern.
        assert_eq!(regex("(?x) NEEDLE _SRC"), Some(lit("NEEDLE_SRC")));
    }

    #[test]
    fn unbounded_pieces_split_the_requirement() {
        assert_eq!(regex("foo.*bar"), Some(all(vec![lit("foo"), lit("bar")])));
        assert_eq!(regex(r"foo\s+bar"), Some(all(vec![lit("foo"), lit("bar")])));
        assert_eq!(regex(r"foo\pLbar"), Some(all(vec![lit("foo"), lit("bar")])));
        assert_eq!(
            regex(r"abc\d{3}def"),
            Some(all(vec![lit("abc"), lit("def")]))
        );
        assert_eq!(regex("colou?r"), Some(lit("colo")));
        assert_eq!(regex("(foo)*bar"), Some(lit("bar")));
        assert_eq!(regex("(foo)+bar"), Some(all(vec![lit("foo"), lit("bar")])));
    }

    #[test]
    fn small_classes_and_alternations_expand_into_or_queries() {
        assert_eq!(
            regex("ab[cd]ef"),
            Some(any(vec![lit("abcef"), lit("abdef")]))
        );
        assert_eq!(
            regex("handle(Search|Grep)"),
            Some(any(vec![lit("handleGrep"), lit("handleSearch")]))
        );
        assert_eq!(
            regex("[a[bc]]def"),
            Some(any(vec![lit("adef"), lit("bdef"), lit("cdef")]))
        );
        assert_eq!(regex(r"\w+Tool|Tool\w+"), Some(lit("Tool")));
        // One short branch can match without any trigram.
        assert_eq!(regex("foo|ab"), None);
    }

    #[test]
    fn case_insensitive_patterns_collapse_to_folded_literals() {
        assert_eq!(
            requirement("ToolUseList", false, true),
            Some(lit("tooluselist"))
        );
        assert_eq!(
            regex("(?i)Foo\\w+Bar"),
            Some(all(vec![lit("foo"), lit("bar")]))
        );
        assert_eq!(requirement("ΚΑΣ", false, true), Some(lit("κας")));
    }

    #[test]
    fn unusable_patterns_yield_no_requirement() {
        assert_eq!(regex("a.b.c"), None);
        assert_eq!(regex(r"\w+"), None);
        assert_eq!(regex("ab"), None);
        // Syntax errors are left for rg to report.
        assert_eq!(regex("zzqq( {"), None);
        assert_eq!(regex("trailing\\"), None);
        // Non-UTF-8 byte literals cannot be looked up as text.
        assert_eq!(regex(r"(?-u:\xFF)"), None);
    }

    #[test]
    fn fixed_strings_are_whole_literals() {
        assert_eq!(requirement("foo.bar(", true, false), Some(lit("foo.bar(")));
        assert_eq!(requirement("ab", true, false), None);
        assert_eq!(requirement("a b", true, false), Some(lit("a b")));
    }
}
