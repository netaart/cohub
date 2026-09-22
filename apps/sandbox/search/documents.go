package search

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
)

const documentProtocolVersion = 1
const workspaceFamily = "workspace.candidates"

type fieldDefinition struct {
	Kind   string `json:"kind"`
	Stored bool   `json:"stored"`
}

type indexDefinition struct {
	Family        string                     `json:"family"`
	SchemaVersion int                        `json:"schemaVersion"`
	Fields        map[string]fieldDefinition `json:"fields"`
}

func defaultWorkspaceDefinition() indexDefinition {
	return indexDefinition{Family: workspaceFamily, SchemaVersion: 1, Fields: map[string]fieldDefinition{
		"content":     {Kind: "trigram"},
		"fingerprint": {Kind: "keyword", Stored: true},
	}}
}

func resolveWorkspaceDefinition(path string) (indexDefinition, bool, error) {
	definition, err := loadWorkspaceDefinition(path)
	if errors.Is(err, os.ErrNotExist) {
		return defaultWorkspaceDefinition(), true, nil
	}
	return definition, false, err
}

// These checks describe the file adapter's contract. The engine validates the
// full schema; other producers can use their own fields and indexing policies.
func loadWorkspaceDefinition(path string) (indexDefinition, error) {
	var definition indexDefinition
	file, err := os.Open(path)
	if err != nil {
		return definition, fmt.Errorf("read Platform Config search schema %q / 读取平台搜索 schema 失败: %w", path, err)
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, 64*1024+1))
	if err != nil {
		return definition, err
	}
	if len(body) > 64*1024 {
		return definition, fmt.Errorf("search schema exceeds 64 KiB / 搜索 schema 超过 64 KiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&definition); err != nil {
		return definition, fmt.Errorf("invalid search schema %q / 搜索 schema 无效: %w", path, err)
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		return definition, fmt.Errorf("search schema must contain one JSON object / 搜索 schema 必须是单个 JSON 对象")
	}
	content, hasContent := definition.Fields["content"]
	fingerprint, hasFingerprint := definition.Fields["fingerprint"]
	if definition.Family != workspaceFamily || definition.SchemaVersion <= 0 || !hasContent || content.Kind != "trigram" || !hasFingerprint || fingerprint.Kind != "keyword" || !fingerprint.Stored {
		return definition, fmt.Errorf("workspace schema %q requires family workspace.candidates, positive schemaVersion, trigram content and stored keyword fingerprint / 工作区 schema 需满足文件索引字段契约", path)
	}
	return definition, nil
}

type documentRef struct {
	Type    string `json:"type"`
	SpaceID string `json:"spaceId"`
	ID      string `json:"id"`
}

type documentMutation struct {
	Operation string            `json:"operation"`
	Document  documentRef       `json:"document"`
	Fields    map[string]string `json:"fields,omitempty"`
}

type mutationBatch struct {
	ExpectedCursor *string            `json:"expectedCursor"`
	Cursor         string             `json:"cursor"`
	Changes        []documentMutation `json:"changes"`
	Coverage       string             `json:"coverage"`
}

type indexStatus struct {
	ProtocolVersion int     `json:"protocolVersion"`
	Family          string  `json:"family"`
	Generation      string  `json:"generation"`
	SchemaVersion   int     `json:"schemaVersion"`
	State           string  `json:"state"`
	Coverage        string  `json:"coverage"`
	DocumentCount   uint64  `json:"documentCount"`
	SourceCursor    *string `json:"sourceCursor"`
}

type searchTerm struct {
	Field string `json:"field"`
	Value string `json:"value"`
}

type searchFilter struct {
	Field     string `json:"field"`
	Operation string `json:"operation"`
	Value     string `json:"value"`
}

type documentQuery struct {
	Terms    []searchTerm   `json:"terms"`
	Filters  []searchFilter `json:"filters"`
	Limit    int            `json:"limit"`
	Offset   int            `json:"offset,omitempty"`
	Snapshot string         `json:"snapshot,omitempty"`
}

type documentHit struct {
	Document documentRef       `json:"document"`
	Fields   map[string]string `json:"fields"`
	Score    float64           `json:"score"`
}

type documentResult struct {
	indexStatus
	Hits      []documentHit `json:"hits"`
	Truncated bool          `json:"truncated"`
	Snapshot  string        `json:"snapshot"`
}

func (c *client) status(ctx context.Context) (indexStatus, error) {
	var status indexStatus
	err := c.doJSON(ctx, http.MethodGet, "/status", nil, &status)
	if err == nil && (status.ProtocolVersion != documentProtocolVersion || status.Family != workspaceFamily || status.SchemaVersion <= 0) {
		err = fmt.Errorf("search protocol or schema mismatch; check the binary and index configuration / 搜索协议或 schema 不匹配，请检查 binary 和索引配置")
	}
	return status, err
}

func (c *client) apply(ctx context.Context, batch mutationBatch) (indexStatus, error) {
	var status indexStatus
	err := c.doJSON(ctx, http.MethodPost, "/documents/apply", batch, &status)
	return status, err
}

func (c *client) query(ctx context.Context, query documentQuery) (documentResult, error) {
	var result documentResult
	err := c.doJSON(ctx, http.MethodPost, "/query", query, &result)
	return result, err
}
