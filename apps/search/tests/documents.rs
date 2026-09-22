use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tempfile::TempDir;

struct IndexFixture {
    root: TempDir,
    schema: PathBuf,
    index: PathBuf,
}
impl IndexFixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let schema = root.path().join("schema.json");
        let index = root.path().join("index");
        fs::write(
            &schema,
            json!({
                "family":"business.documents", "schemaVersion":1,
                "fields": {
                    "title":{"kind":"text","stored":true},
                    "content":{"kind":"trigram","stored":false},
                    "snippet":{"kind":"trigram","stored":true},
                    "label":{"kind":"keyword","stored":true}
                }
            })
            .to_string(),
        )
        .unwrap();
        Self {
            root,
            schema,
            index,
        }
    }
    fn serve(&self) -> RunningEngine {
        let socket = self.root.path().join("run/search.sock");
        let child = Command::new(env!("CARGO_BIN_EXE_cohub-search"))
            .arg("serve")
            .arg("--schema")
            .arg(&self.schema)
            .arg("--index")
            .arg(&self.index)
            .arg("--socket")
            .arg(&socket)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut running = RunningEngine { child, socket };
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if UnixStream::connect(&running.socket).is_ok() {
                return running;
            }
            assert!(
                running.child.try_wait().unwrap().is_none(),
                "engine exited before listening"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("engine did not listen");
    }
    fn run(&self, command: &str, input: Option<Value>) -> Result<Value, String> {
        let mut child = Command::new(env!("CARGO_BIN_EXE_cohub-search"))
            .args([command, "--schema"])
            .arg(&self.schema)
            .arg("--index")
            .arg(&self.index)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(input) = input {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.to_string().as_bytes())
                .unwrap();
        }
        drop(child.stdin.take());
        let output = child.wait_with_output().unwrap();
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        Ok(serde_json::from_slice(&output.stdout).unwrap())
    }
    fn apply(
        &self,
        expected: Option<&str>,
        cursor: &str,
        changes: Vec<Value>,
    ) -> Result<Value, String> {
        self.run("apply", Some(json!({"expectedCursor":expected,"cursor":cursor,"changes":changes,"coverage":"complete"})))
    }
    fn query(&self, terms: Value, filters: Value) -> Value {
        self.run(
            "query",
            Some(json!({"terms":terms,"filters":filters,"limit":100})),
        )
        .unwrap()
    }
}
struct RunningEngine {
    child: Child,
    socket: PathBuf,
}
impl Drop for RunningEngine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl RunningEngine {
    fn request(&self, path: &str, body: Value) -> (u16, Value) {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let body = body.to_string();
        write!(stream, "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, serde_json::from_str(body).unwrap())
    }
}

#[test]
fn http_checkpoints_survive_kill_and_snapshot_conflicts_are_explicit() {
    let fixture = IndexFixture::new();
    let engine = fixture.serve();
    let batch = json!({"expectedCursor":null,"cursor":"one","coverage":"complete","changes":[upsert("app","s1","a",json!({"title":"First"}))]});
    assert_eq!(engine.request("/documents/apply", batch.clone()).0, 200);
    let (code, first) = engine.request("/query", json!({"limit":1}));
    assert_eq!(code, 200);
    assert_eq!(engine.request("/documents/apply",json!({"expectedCursor":"one","cursor":"two","changes":[delete("app","s1","a")],"coverage":"complete"})).0, 200);
    assert_eq!(
        engine
            .request("/query", json!({"snapshot":first["snapshot"]}))
            .0,
        409
    );
    assert_eq!(engine.request("/documents/apply", batch).0, 409);
    assert_eq!(
        engine
            .request("/query", json!({"terms":[{"field":"unknown","value":"x"}]}))
            .0,
        400
    );
    // A second writer must fail without unlinking the live process's socket.
    let output = Command::new(env!("CARGO_BIN_EXE_cohub-search"))
        .arg("serve")
        .arg("--schema")
        .arg(&fixture.schema)
        .arg("--index")
        .arg(&fixture.index)
        .arg("--socket")
        .arg(&engine.socket)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(engine.request("/query", json!({})).0, 200);
    drop(engine);
    let status = fixture.run("status", None).unwrap();
    assert_eq!(status["sourceCursor"], "two");
    assert_eq!(status["documentCount"], 0);
}

#[test]
fn missing_metadata_does_not_overwrite_existing_segments() {
    let fixture = IndexFixture::new();
    fixture
        .apply(
            None,
            "one",
            vec![upsert("app", "s1", "a", json!({"title":"Original"}))],
        )
        .unwrap();
    fs::remove_file(fixture.index.join("meta.json")).unwrap();
    assert!(fixture
        .run("status", None)
        .unwrap_err()
        .contains("metadata is missing"));
    assert!(!fixture.index.join("meta.json").exists());
}

fn upsert(kind: &str, space: &str, id: &str, fields: Value) -> Value {
    json!({"operation":"upsert","document":{"type":kind,"spaceId":space,"id":id},"fields":fields})
}
fn delete(kind: &str, space: &str, id: &str) -> Value {
    json!({"operation":"delete","document":{"type":kind,"spaceId":space,"id":id}})
}
fn ids(result: &Value) -> Vec<String> {
    let mut ids = result["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hit| hit["document"]["id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    ids.sort();
    ids
}

#[test]
fn new_business_types_use_the_same_binary_and_persist_across_processes() {
    let fixture = IndexFixture::new();
    fixture.apply(None, "one", vec![
        upsert("app", "s1", "a", json!({"title":"Release Planner","content":"发布计划 needle","label":"Team"})),
        upsert("session", "s1", "b", json!({"title":"Release discussion","content":"讨论计划 needle","label":"Team"})),
        upsert("future.custom", "s1", "c", json!({"title":"Custom release","content":"自定义内容 needle","label":"Private"})),
    ]).unwrap();
    let result = fixture.query(json!([{"field":"title","value":"RELEASE"}]), json!([]));
    assert_eq!(ids(&result), ["a", "b", "c"]);
    assert_eq!(result["sourceCursor"], "one");
    assert_eq!(result["coverage"], "complete");
    assert!(result["hits"][0]["fields"].get("content").is_none());
    let result = fixture.query(json!([{"field":"content","value":"发布计"}]), json!([]));
    assert_eq!(ids(&result), ["a"]);
    let result = fixture.query(
        json!([]),
        json!([{"field":"_type","operation":"equal","value":"future.custom"}]),
    );
    assert_eq!(ids(&result), ["c"]);
}

#[test]
fn identity_is_scoped_by_type_and_space_and_deletes_do_not_cross_scopes() {
    let fixture = IndexFixture::new();
    fixture
        .apply(
            None,
            "one",
            vec![
                upsert("app", "s1", "same", json!({"title":"First"})),
                upsert("session", "s1", "same", json!({"title":"Second"})),
                upsert("app", "s2", "same", json!({"title":"Third"})),
            ],
        )
        .unwrap();
    fixture
        .apply(Some("one"), "two", vec![delete("app", "s1", "same")])
        .unwrap();
    assert_eq!(fixture.run("status", None).unwrap()["documentCount"], 2);
    let result = fixture.query(
        json!([]),
        json!([{"field":"_space","operation":"equal","value":"s2"}]),
    );
    assert_eq!(result["hits"][0]["fields"]["title"], "Third");
}

#[test]
fn exact_batch_retries_are_idempotent_and_old_writes_cannot_resurrect_deletes() {
    let fixture = IndexFixture::new();
    let original = vec![upsert("app", "s1", "a", json!({"title":"Original"}))];
    fixture.apply(None, "one", original.clone()).unwrap();
    fixture.apply(None, "one", original.clone()).unwrap();
    assert_eq!(fixture.run("status", None).unwrap()["documentCount"], 1);
    assert!(fixture
        .apply(
            None,
            "one",
            vec![upsert("app", "s1", "a", json!({"title":"Changed"}))]
        )
        .unwrap_err()
        .contains("cursor conflict"));
    fixture
        .apply(Some("one"), "two", vec![delete("app", "s1", "a")])
        .unwrap();
    assert!(fixture
        .apply(None, "one", original)
        .unwrap_err()
        .contains("cursor conflict"));
    assert!(fixture
        .apply(
            Some("one"),
            "three",
            vec![upsert("app", "s1", "a", json!({"title":"Resurrected"}))]
        )
        .is_err());
    let status = fixture.run("status", None).unwrap();
    assert_eq!(status["documentCount"], 0);
    assert_eq!(status["sourceCursor"], "two");
}

#[test]
fn invalid_batch_is_rejected_before_any_document_or_cursor_changes() {
    let fixture = IndexFixture::new();
    fixture
        .apply(
            None,
            "one",
            vec![upsert("app", "s1", "a", json!({"title":"Original"}))],
        )
        .unwrap();
    assert!(fixture
        .apply(
            Some("one"),
            "two",
            vec![
                delete("app", "s1", "a"),
                upsert("app", "s1", "b", json!({"undeclared":"invalid"})),
            ]
        )
        .unwrap_err()
        .contains("unknown field"));
    let result = fixture.query(json!([]), json!([]));
    assert_eq!(ids(&result), ["a"]);
    assert_eq!(result["sourceCursor"], "one");
}

#[test]
fn all_fields_are_strings_and_unknown_request_fields_fail() {
    let fixture = IndexFixture::new();
    assert!(fixture
        .apply(
            None,
            "one",
            vec![upsert("app", "s1", "a", json!({"title":12}))]
        )
        .is_err());
    assert!(fixture
        .run("query", Some(json!({"literals":["legacy"]})))
        .is_err());
    assert!(fixture
        .apply(
            None,
            "one",
            vec![upsert("app", "", "a", json!({"title":"bad identity"}))]
        )
        .is_err());
}

#[test]
fn stored_trigram_values_preserve_original_case_and_unicode() {
    let fixture = IndexFixture::new();
    fixture
        .apply(
            None,
            "one",
            vec![upsert(
                "note",
                "s1",
                "a",
                json!({"snippet":"HELLO 发布计划 İSTANBUL"}),
            )],
        )
        .unwrap();
    let result = fixture.query(
        json!([{"field":"snippet","value":"hello"}]),
        json!([{"field":"snippet","operation":"prefix","value":"HELLO"}]),
    );
    assert_eq!(ids(&result), ["a"]);
    assert_eq!(
        result["hits"][0]["fields"]["snippet"],
        "HELLO 发布计划 İSTANBUL"
    );
}

#[test]
fn keyword_matching_is_exact_and_case_sensitive() {
    let fixture = IndexFixture::new();
    fixture
        .apply(
            None,
            "one",
            vec![
                upsert("app", "s1", "a", json!({"label":"Team"})),
                upsert("app", "s1", "b", json!({"label":"team"})),
            ],
        )
        .unwrap();
    assert_eq!(
        ids(&fixture.query(
            json!([]),
            json!([{"field":"label","operation":"equal","value":"Team"}])
        )),
        ["a"]
    );
}

#[test]
fn filtered_pagination_does_not_lose_matches_after_a_full_candidate_page() {
    let fixture = IndexFixture::new();
    let first = (0..1000)
        .map(|n| {
            upsert(
                "file",
                "s1",
                &format!("other/{n}"),
                json!({"content":"common needle"}),
            )
        })
        .collect();
    fixture.apply(None, "one", first).unwrap();
    fixture
        .apply(
            Some("one"),
            "two",
            vec![
                upsert(
                    "file",
                    "s1",
                    "target/a.txt",
                    json!({"content":"common needle"}),
                ),
                upsert(
                    "file",
                    "s1",
                    "target/b.txt",
                    json!({"content":"common needle"}),
                ),
            ],
        )
        .unwrap();
    let result = fixture
        .run(
            "query",
            Some(json!({
                "terms":[{"field":"content","value":"needle"}],
                "filters":[{"field":"_id","operation":"glob","value":"target/*.txt"}],"limit":1
            })),
        )
        .unwrap();
    assert_eq!(result["hits"].as_array().unwrap().len(), 1);
    assert_eq!(result["truncated"], true);
    let result = fixture
        .run(
            "query",
            Some(json!({"terms":[],"filters":[],"offset":1001,"limit":1})),
        )
        .unwrap();
    assert_eq!(result["truncated"], false);
}

#[test]
fn schema_changes_fail_without_modifying_existing_index() {
    let fixture = IndexFixture::new();
    fixture
        .apply(
            None,
            "one",
            vec![upsert("app", "s1", "a", json!({"title":"Original"}))],
        )
        .unwrap();
    let original = fs::read(&fixture.schema).unwrap();
    let mut changed: Value = serde_json::from_slice(&original).unwrap();
    changed["schemaVersion"] = json!(2);
    fs::write(&fixture.schema, changed.to_string()).unwrap();
    assert!(fixture
        .run("status", None)
        .unwrap_err()
        .contains("new directory"));
    fs::write(&fixture.schema, original).unwrap();
    assert_eq!(ids(&fixture.query(json!([]), json!([]))), ["a"]);
}

#[test]
fn corrupt_index_is_preserved_and_never_silently_recreated() {
    let fixture = IndexFixture::new();
    fixture
        .apply(
            None,
            "one",
            vec![upsert("app", "s1", "a", json!({"title":"Original"}))],
        )
        .unwrap();
    fs::write(fixture.index.join("meta.json"), "corrupt").unwrap();
    assert!(fixture.run("status", None).is_err());
    assert_eq!(
        fs::read_to_string(fixture.index.join("meta.json")).unwrap(),
        "corrupt"
    );
}

#[test]
fn generic_index_requires_no_workspace_or_file_access() {
    let fixture = IndexFixture::new();
    fixture
        .apply(
            None,
            "one",
            vec![upsert(
                "business",
                "space",
                "../not-a-file",
                json!({"title":"Some string"}),
            )],
        )
        .unwrap();
    assert_eq!(ids(&fixture.query(json!([]), json!([]))), ["../not-a-file"]);
    assert!(!Path::new(&fixture.root.path().join("not-a-file")).exists());
}
