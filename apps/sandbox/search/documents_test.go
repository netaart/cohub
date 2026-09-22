package search

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testWorkspaceSchema(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs("../../../deploy/platform-config/platform/.cohub/search/workspace.candidates.json")
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func TestWorkspaceSchemaLoadsFromPlatformConfig(t *testing.T) {
	path := testWorkspaceSchema(t)
	definition, err := loadWorkspaceDefinition(path)
	if err != nil {
		t.Fatal(err)
	}
	if definition.Family != workspaceFamily || definition.SchemaVersion != 1 {
		t.Fatalf("unexpected schema: %+v", definition)
	}

	// Schema versions belong to configuration, not to the sandbox binary.
	definition.SchemaVersion = 7
	data, err := json.Marshal(definition)
	if err != nil {
		t.Fatal(err)
	}
	custom := filepath.Join(t.TempDir(), "workspace.json")
	if err := os.WriteFile(custom, data, 0o400); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadWorkspaceDefinition(custom)
	if err != nil || loaded.SchemaVersion != 7 {
		t.Fatalf("loaded=%+v err=%v", loaded, err)
	}
}

func TestWorkspaceSchemaRejectsInvalidAdapterContract(t *testing.T) {
	for name, schema := range map[string]string{
		"invalid JSON":           `{`,
		"multiple objects":       `{} {}`,
		"unknown property":       `{"unexpected":true}`,
		"wrong family":           `{"family":"other","schemaVersion":1,"fields":{"content":{"kind":"trigram"},"fingerprint":{"kind":"keyword","stored":true}}}`,
		"missing fingerprint":    `{"family":"workspace.candidates","schemaVersion":1,"fields":{"content":{"kind":"trigram"}}}`,
		"wrong content analyzer": `{"family":"workspace.candidates","schemaVersion":1,"fields":{"content":{"kind":"text"},"fingerprint":{"kind":"keyword","stored":true}}}`,
		"unstored fingerprint":   `{"family":"workspace.candidates","schemaVersion":1,"fields":{"content":{"kind":"trigram"},"fingerprint":{"kind":"keyword"}}}`,
		"invalid version":        `{"family":"workspace.candidates","schemaVersion":0,"fields":{"content":{"kind":"trigram"},"fingerprint":{"kind":"keyword","stored":true}}}`,
		"oversize":               strings.Repeat(" ", 64*1024+1),
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "schema.json")
			if err := os.WriteFile(path, []byte(schema), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadWorkspaceDefinition(path); err == nil {
				t.Fatal("invalid schema accepted")
			}
		})
	}
}

func TestMissingPlatformSchemaUsesBuiltInWithoutWritingPlatformConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "platform", ".cohub", "search", "workspace.candidates.json")
	definition, fallback, err := resolveWorkspaceDefinition(path)
	if err != nil || !fallback || definition.Family != workspaceFamily {
		t.Fatalf("definition=%+v fallback=%v err=%v", definition, fallback, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("platform config was created: %v", err)
	}
	configured, err := loadWorkspaceDefinition(testWorkspaceSchema(t))
	if err != nil {
		t.Fatal(err)
	}
	want, _, _ := schemaFingerprint(configured)
	got, _, _ := schemaFingerprint(definition)
	if got != want {
		t.Fatal("fallback differs from the deployable workspace schema")
	}
}

func TestInvalidPlatformSchemaDoesNotUseFallback(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schema.json")
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, fallback, err := resolveWorkspaceDefinition(path)
	if err == nil || fallback {
		t.Fatalf("fallback=%v err=%v", fallback, err)
	}
}
