use anyhow::{anyhow, Context, Result};
use globset::Glob;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fmt, fs,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tantivy::{
    collector::TopDocs,
    query::{AllQuery, BooleanQuery, Query, TermQuery},
    schema::{
        Field, IndexRecordOption, Schema, TantivyDocument, TextFieldIndexing, TextOptions, Value,
        STORED, STRING,
    },
    tokenizer::{NgramTokenizer, TextAnalyzer, TokenStream},
    Index, IndexReader, IndexWriter, ReloadPolicy, Term,
};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
const MAX_FIELD_BYTES: usize = 4 * 1024 * 1024;
const PAGE_SIZE: usize = 1024;

#[derive(Debug)]
pub struct InvalidInput(pub String);
impl fmt::Display for InvalidInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} / 请求无效", self.0)
    }
}
impl std::error::Error for InvalidInput {}

#[derive(Debug)]
pub struct CursorConflict;
impl fmt::Display for CursorConflict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "source cursor conflict; reconcile before retrying / 来源游标冲突，请重新同步"
        )
    }
}
impl std::error::Error for CursorConflict {}

fn require(condition: bool, message: &str) -> Result<()> {
    if !condition {
        return Err(InvalidInput(message.to_string()).into());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FieldKind {
    Text,
    Keyword,
    Trigram,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FieldDefinition {
    pub kind: FieldKind,
    #[serde(default)]
    pub stored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexDefinition {
    pub family: String,
    pub schema_version: u32,
    pub fields: BTreeMap<String, FieldDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentRef {
    #[serde(rename = "type")]
    pub document_type: String,
    pub space_id: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum Mutation {
    Upsert {
        document: DocumentRef,
        fields: BTreeMap<String, String>,
    },
    Delete {
        document: DocumentRef,
    },
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Coverage {
    Complete,
    Partial,
    #[default]
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationBatch {
    pub expected_cursor: Option<String>,
    pub cursor: String,
    pub changes: Vec<Mutation>,
    pub coverage: Coverage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchTerm {
    pub field: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOperation {
    Equal,
    Prefix,
    Glob,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchFilter {
    pub field: String,
    pub operation: FilterOperation,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryRequest {
    #[serde(default)]
    pub terms: Vec<SearchTerm>,
    #[serde(default)]
    pub filters: Vec<SearchFilter>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
    /// Pins a multi-page scan to one reader lifetime and source position.
    #[serde(default)]
    pub snapshot: Option<String>,
}
fn default_limit() -> usize {
    1000
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub document: DocumentRef,
    pub fields: BTreeMap<String, String>,
    pub score: f32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResponse {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
    pub snapshot: String,
    #[serde(flatten)]
    pub status: IndexStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub protocol_version: u32,
    pub family: String,
    pub generation: String,
    pub schema_version: u32,
    pub state: String,
    pub coverage: Coverage,
    pub document_count: u64,
    pub source_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitState {
    protocol_version: u32,
    definition: IndexDefinition,
    generation: String,
    cursor: Option<String>,
    digest: Option<String>,
    coverage: Coverage,
}

struct WriterState {
    writer: IndexWriter,
    reader: IndexReader,
    commit: CommitState,
    readable: bool,
}

pub struct Engine {
    index: Index,
    definition: IndexDefinition,
    fields: BTreeMap<String, Field>,
    stored_fields: BTreeMap<String, Field>,
    key: Field,
    id: Field,
    document_type: Field,
    space: Field,
    instance: String,
    state: Mutex<WriterState>,
}

fn identity(document: &DocumentRef) -> Result<String> {
    require(
        !document.id.is_empty() && document.id.len() <= 4096,
        "id must contain 1..4096 bytes",
    )?;
    require(
        !document.document_type.is_empty() && document.document_type.len() <= 128,
        "type must contain 1..128 bytes",
    )?;
    require(
        !document.space_id.is_empty() && document.space_id.len() <= 128,
        "spaceId must contain 1..128 bytes",
    )?;
    Ok(serde_json::to_string(&[
        &document.space_id,
        &document.document_type,
        &document.id,
    ])?)
}

fn generation() -> String {
    format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id()
    )
}

fn build_schema(definition: &IndexDefinition) -> Result<Schema> {
    require(
        !definition.family.is_empty() && definition.family.len() <= 128,
        "family must contain 1..128 bytes",
    )?;
    require(
        definition.schema_version > 0,
        "schemaVersion must be positive",
    )?;
    require(
        !definition.fields.is_empty() && definition.fields.len() <= 32,
        "schema must define 1..32 string fields",
    )?;
    let mut builder = Schema::builder();
    builder.add_text_field("_key", STRING);
    for name in ["_id", "_type", "_space"] {
        builder.add_text_field(name, STRING | STORED);
    }
    for (name, field) in &definition.fields {
        require(
            name.len() <= 64
                && name.starts_with(|ch: char| ch.is_ascii_alphabetic())
                && name
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || b"_.-".contains(&ch)),
            "field names must start with a letter and use only letters, digits, _, . or -",
        )?;
        let options = match field.kind {
            FieldKind::Keyword => TextOptions::default().set_indexing_options(
                TextFieldIndexing::default()
                    .set_tokenizer("raw")
                    .set_index_option(IndexRecordOption::Basic),
            ),
            FieldKind::Text => TextOptions::default().set_indexing_options(
                TextFieldIndexing::default()
                    .set_tokenizer("default")
                    .set_index_option(IndexRecordOption::WithFreqs),
            ),
            FieldKind::Trigram => TextOptions::default().set_indexing_options(
                TextFieldIndexing::default()
                    .set_tokenizer("trigram")
                    .set_index_option(IndexRecordOption::Basic),
            ),
        };
        if field.stored && field.kind == FieldKind::Trigram {
            builder.add_text_field(&format!("_stored_{name}"), STORED);
        }
        builder.add_text_field(
            name,
            if field.stored && field.kind != FieldKind::Trigram {
                options.set_stored()
            } else {
                options
            },
        );
    }
    Ok(builder.build())
}

impl Engine {
    pub fn open(directory: &Path, definition: IndexDefinition) -> Result<Self> {
        let schema = build_schema(&definition)?;
        fs::create_dir_all(directory).context("create index directory / 创建索引目录")?;
        let existing = directory.join("meta.json").exists();
        let index = if existing {
            Index::open_in_dir(directory)?
        } else {
            require(fs::read_dir(directory)?.next().is_none(), "index metadata is missing in a nonempty directory; rebuild in a new directory, existing data was not changed")?;
            Index::create_in_dir(directory, schema.clone())?
        };
        require(
            index.schema() == schema,
            "index schema differs; rebuild in a new directory, existing data was not changed",
        )?;
        index.tokenizers().register(
            "trigram",
            TextAnalyzer::builder(NgramTokenizer::new(3, 3, false)?).build(),
        );
        let mut writer = index.writer_with_num_threads(1, 64 * 1024 * 1024)?;
        let commit = if existing {
            let payload = index.load_metas()?.payload.context(
                "index has no document-engine manifest; use a new directory / 请使用新索引目录",
            )?;
            let commit: CommitState =
                serde_json::from_str(&payload).context("invalid index manifest / 索引清单无效")?;
            require(commit.protocol_version == PROTOCOL_VERSION && commit.definition == definition, "index definition changed; rebuild in a new directory, existing data was not changed")?;
            commit
        } else {
            let commit = CommitState {
                protocol_version: PROTOCOL_VERSION,
                definition: definition.clone(),
                generation: generation(),
                cursor: None,
                digest: None,
                coverage: Coverage::Stale,
            };
            let mut prepared = writer.prepare_commit()?;
            prepared.set_payload(&serde_json::to_string(&commit)?);
            prepared.commit()?;
            commit
        };
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        let fields = definition
            .fields
            .keys()
            .map(|name| Ok((name.clone(), schema.get_field(name)?)))
            .collect::<Result<_>>()?;
        let stored_fields = definition
            .fields
            .iter()
            .filter(|(_, field)| field.stored)
            .map(|(name, field)| {
                let stored = if field.kind == FieldKind::Trigram {
                    format!("_stored_{name}")
                } else {
                    name.clone()
                };
                Ok((name.clone(), schema.get_field(&stored)?))
            })
            .collect::<Result<_>>()?;
        Ok(Self {
            key: schema.get_field("_key")?,
            id: schema.get_field("_id")?,
            document_type: schema.get_field("_type")?,
            space: schema.get_field("_space")?,
            index,
            definition,
            fields,
            stored_fields,
            instance: generation(),
            state: Mutex::new(WriterState {
                writer,
                reader,
                commit,
                readable: true,
            }),
        })
    }

    fn status_for(state: &WriterState) -> IndexStatus {
        IndexStatus {
            protocol_version: PROTOCOL_VERSION,
            family: state.commit.definition.family.clone(),
            generation: state.commit.generation.clone(),
            schema_version: state.commit.definition.schema_version,
            state: if !state.readable {
                "error"
            } else if state.commit.coverage == Coverage::Complete {
                "ready"
            } else {
                "building"
            }
            .to_string(),
            coverage: if state.readable {
                state.commit.coverage
            } else {
                Coverage::Stale
            },
            document_count: state.reader.searcher().num_docs(),
            source_cursor: state.commit.cursor.clone(),
        }
    }

    pub fn status(&self) -> IndexStatus {
        Self::status_for(&self.state.lock().expect("index mutex poisoned"))
    }

    pub fn apply(&self, batch: &MutationBatch) -> Result<IndexStatus> {
        require(
            !batch.cursor.is_empty() && batch.cursor.len() <= 1024,
            "cursor must contain 1..1024 bytes",
        )?;
        require(
            batch
                .expected_cursor
                .as_ref()
                .is_none_or(|cursor| !cursor.is_empty() && cursor.len() <= 1024),
            "expectedCursor must be null or contain 1..1024 bytes",
        )?;
        require(
            batch.expected_cursor.as_ref() != Some(&batch.cursor),
            "cursor must advance",
        )?;
        require(batch.changes.len() <= 1000, "batch exceeds 1000 mutations")?;
        let mut prepared = Vec::with_capacity(batch.changes.len());
        for change in &batch.changes {
            match change {
                Mutation::Delete { document } => prepared.push((identity(document)?, None)),
                Mutation::Upsert { document, fields } => {
                    let key = identity(document)?;
                    let mut indexed = TantivyDocument::default();
                    indexed.add_text(self.key, &key);
                    indexed.add_text(self.id, &document.id);
                    indexed.add_text(self.document_type, &document.document_type);
                    indexed.add_text(self.space, &document.space_id);
                    let mut bytes = 0;
                    for (name, value) in fields {
                        let definition = self
                            .definition
                            .fields
                            .get(name)
                            .ok_or_else(|| InvalidInput(format!("unknown field {name}")))?;
                        require(value.len() <= MAX_FIELD_BYTES, "string field exceeds 4 MiB")?;
                        bytes += value.len();
                        if definition.stored && definition.kind == FieldKind::Trigram {
                            indexed.add_text(self.stored_fields[name], value);
                        }
                        let value = if definition.kind == FieldKind::Trigram {
                            value.to_lowercase()
                        } else {
                            value.clone()
                        };
                        indexed.add_text(self.fields[name], value);
                    }
                    require(bytes <= 8 * 1024 * 1024, "document exceeds 8 MiB")?;
                    prepared.push((key, Some(indexed)));
                }
            }
        }
        let encoded = serde_json::to_vec(batch)?;
        require(encoded.len() <= MAX_BODY_BYTES, "batch exceeds 32 MiB")?;
        let digest = format!("{:x}", Sha256::digest(&encoded));
        let mut state = self.state.lock().expect("index mutex poisoned");
        if state.commit.cursor.as_ref() == Some(&batch.cursor) {
            if state.commit.digest.as_ref() != Some(&digest) {
                return Err(CursorConflict.into());
            }
            state.reader.reload()?;
            state.readable = true;
            return Ok(Self::status_for(&state));
        }
        if state.commit.cursor != batch.expected_cursor {
            return Err(CursorConflict.into());
        }
        let next = CommitState {
            cursor: Some(batch.cursor.clone()),
            digest: Some(digest),
            coverage: batch.coverage,
            ..state.commit.clone()
        };
        // Documents and the source checkpoint are one Tantivy commit. HTTP success
        // is sent only after it is durable and visible to the local reader.
        let result = (|| -> Result<()> {
            for (key, document) in prepared {
                state
                    .writer
                    .delete_term(Term::from_field_text(self.key, &key));
                if let Some(document) = document {
                    state.writer.add_document(document)?;
                }
            }
            let mut commit = state.writer.prepare_commit()?;
            commit.set_payload(&serde_json::to_string(&next)?);
            commit.commit()?;
            Ok(())
        })();
        state.readable = false;
        if let Err(error) = result {
            state
                .writer
                .rollback()
                .context("rollback index mutation / 回滚索引写入")?;
            let payload = self
                .index
                .load_metas()?
                .payload
                .context("missing commit checkpoint / 缺少提交检查点")?;
            state.commit = serde_json::from_str(&payload)?;
            state.reader.reload()?;
            state.readable = true;
            return Err(error);
        }
        state.commit = next;
        state.reader.reload()?;
        state.readable = true;
        Ok(Self::status_for(&state))
    }

    fn field(&self, name: &str) -> Result<Field> {
        match name {
            "_id" => Ok(self.id),
            "_type" => Ok(self.document_type),
            "_space" => Ok(self.space),
            _ => self
                .fields
                .get(name)
                .copied()
                .ok_or_else(|| InvalidInput(format!("unknown field {name}")).into()),
        }
    }

    fn terms(&self, term: &SearchTerm) -> Result<Vec<Box<dyn Query>>> {
        let field = self.field(&term.field)?;
        require(
            !term.value.is_empty() && term.value.len() <= 4096,
            "query value must contain 1..4096 bytes",
        )?;
        let kind = self
            .definition
            .fields
            .get(&term.field)
            .map(|field| field.kind)
            .unwrap_or(FieldKind::Keyword);
        let mut tokens = Vec::new();
        match kind {
            FieldKind::Keyword => tokens.push(term.value.clone()),
            FieldKind::Trigram => {
                let value = term.value.trim().to_lowercase().chars().collect::<Vec<_>>();
                require(
                    value.len() >= 3,
                    "trigram queries need at least 3 characters",
                )?;
                for window in value.windows(3) {
                    tokens.push(window.iter().collect());
                }
            }
            FieldKind::Text => {
                let mut analyzer = self
                    .index
                    .tokenizers()
                    .get("default")
                    .context("default tokenizer missing")?;
                let mut stream = analyzer.token_stream(&term.value);
                while stream.advance() {
                    tokens.push(stream.token().text.clone());
                }
                require(!tokens.is_empty(), "query contains no searchable tokens")?;
            }
        }
        tokens.sort();
        tokens.dedup();
        let record = if kind == FieldKind::Text {
            IndexRecordOption::WithFreqs
        } else {
            IndexRecordOption::Basic
        };
        Ok(tokens
            .into_iter()
            .map(|token| {
                Box::new(TermQuery::new(Term::from_field_text(field, &token), record))
                    as Box<dyn Query>
            })
            .collect())
    }

    pub fn query(&self, request: &QueryRequest) -> Result<QueryResponse> {
        require(
            request.limit > 0 && request.limit <= 5000,
            "limit must be in 1..5000",
        )?;
        require(request.offset <= 1_000_000, "offset exceeds 1000000")?;
        require(
            request.terms.len() <= 32 && request.filters.len() <= 32,
            "query exceeds 32 terms or filters",
        )?;
        let mut clauses = Vec::new();
        for term in &request.terms {
            clauses.extend(self.terms(term)?);
        }
        let mut predicates = Vec::new();
        for filter in &request.filters {
            let field = self.field(&filter.field)?;
            require(
                filter.value.len() <= 4096,
                "filter value exceeds 4096 bytes",
            )?;
            let definition = self.definition.fields.get(&filter.field);
            match filter.operation {
                FilterOperation::Equal => {
                    require(
                        definition.is_none_or(|field| field.kind == FieldKind::Keyword),
                        "equality filters require keyword fields",
                    )?;
                    clauses.push(Box::new(TermQuery::new(
                        Term::from_field_text(field, &filter.value),
                        IndexRecordOption::Basic,
                    )) as Box<dyn Query>);
                }
                FilterOperation::Prefix | FilterOperation::Glob => {
                    require(
                        definition.is_none_or(|field| field.stored),
                        "prefix/glob filters require stored fields",
                    )?;
                    let glob = if matches!(filter.operation, FilterOperation::Glob) {
                        Some(
                            Glob::new(&filter.value)
                                .map_err(|error| InvalidInput(error.to_string()))?
                                .compile_matcher(),
                        )
                    } else {
                        None
                    };
                    let stored = self
                        .stored_fields
                        .get(&filter.field)
                        .copied()
                        .unwrap_or(field);
                    predicates.push((stored, filter.value.as_str(), glob));
                }
            }
        }
        let query: Box<dyn Query> = if clauses.is_empty() {
            Box::new(AllQuery)
        } else {
            Box::new(BooleanQuery::intersection(clauses))
        };
        let (searcher, status, snapshot) = {
            let state = self.state.lock().expect("index mutex poisoned");
            if !state.readable {
                return Err(anyhow!("index reader is unavailable / 索引读取暂不可用"));
            }
            let snapshot = serde_json::to_string(&(&self.instance, &state.commit.cursor))?;
            if request
                .snapshot
                .as_ref()
                .is_some_and(|expected| expected != &snapshot)
            {
                return Err(CursorConflict.into());
            }
            (state.reader.searcher(), Self::status_for(&state), snapshot)
        };
        let mut hits = Vec::new();
        let mut offset = 0;
        let mut skipped = 0;
        let mut response_bytes = 0;
        let mut truncated = false;
        'pages: loop {
            let page = searcher.search(
                query.as_ref(),
                &TopDocs::with_limit(PAGE_SIZE).and_offset(offset),
            )?;
            for (score, address) in &page {
                let document: TantivyDocument = searcher.doc(*address)?;
                if !predicates.iter().all(|(field, prefix, glob)| {
                    document
                        .get_first(*field)
                        .and_then(|value| value.as_str())
                        .is_some_and(|value| match glob {
                            Some(glob) => glob.is_match(value),
                            None => value.starts_with(prefix),
                        })
                }) {
                    continue;
                }
                if skipped < request.offset {
                    skipped += 1;
                    continue;
                }
                if hits.len() == request.limit {
                    truncated = true;
                    break 'pages;
                }
                let get = |field| {
                    document
                        .get_first(field)
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                        .context("document identity is corrupt / 文档标识损坏")
                };
                let fields = self
                    .definition
                    .fields
                    .iter()
                    .filter(|(_, field)| field.stored)
                    .filter_map(|(name, _)| {
                        document
                            .get_first(self.stored_fields[name])
                            .and_then(|value| value.as_str())
                            .map(|value| (name.clone(), value.to_string()))
                    })
                    .collect();
                let hit = SearchHit {
                    document: DocumentRef {
                        id: get(self.id)?,
                        document_type: get(self.document_type)?,
                        space_id: get(self.space)?,
                    },
                    fields,
                    score: *score,
                };
                let hit_bytes = serde_json::to_vec(&hit)?.len();
                if response_bytes + hit_bytes > MAX_BODY_BYTES - 64 * 1024 {
                    require(
                        !hits.is_empty(),
                        "stored document exceeds response limit; reduce stored fields",
                    )?;
                    truncated = true;
                    break 'pages;
                }
                response_bytes += hit_bytes;
                hits.push(hit);
            }
            if page.len() < PAGE_SIZE {
                break;
            }
            offset += page.len();
        }
        Ok(QueryResponse {
            hits,
            truncated,
            snapshot,
            status,
        })
    }
}
