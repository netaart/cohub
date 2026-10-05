package rpc

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func setupSearchTree(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		".gitignore":                "build/\n*.log\n/top-only.txt\n",
		".hidden/notes.md":          "needle in hidden\n",
		".env":                      "needle=secret\n",
		".git/config":               "needle in git\n",
		"top-only.txt":              "needle top\n",
		"build/out.js":              "needle built\n",
		"debug.log":                 "needle log\n",
		"README.md":                 "intro\nneedle one\nmiddle\nmiddle\nmiddle\nNeedle two\nend\n",
		"src/main.go":               "package main\n// needle\nfunc main() {}\n",
		"src/top-only.txt":          "needle nested top-only\n",
		"src/.ignore":               "generated/\n",
		"src/generated/gen.go":      "needle generated\n",
		"src/deep/a/b/IMG_0001.JPG": "binary",
		"src/deep/a/b/img_0002.jpg": "binary",
		"src/deep/a/b/clip.mp4":     "binary",
		"src/lib/.gitignore":        "local.txt\n",
		"src/lib/local.txt":         "needle local\n",
		"src/lib/util.ts":           "export const needle = 1;\nexport const other = needle + needle;\n",
		"相册/照片.txt":                 "needle 中文\n",
		"crlf.txt":                  "first\r\nneedle crlf\r\n",
	}
	for rel, content := range files {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "blob.bin"), []byte("needle\x00binary"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "escape.txt"), []byte("needle outside\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	return root
}

type grepEvent struct {
	Kind string
	Path string
	Line int
	Text string
}

func decodeGrepEvents(t *testing.T, lines []string) []grepEvent {
	t.Helper()
	events := make([]grepEvent, 0)
	for _, line := range lines {
		var event struct {
			Type string `json:"type"`
			Data struct {
				Path       rgText `json:"path"`
				Lines      rgText `json:"lines"`
				LineNumber int    `json:"line_number"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("invalid json line %q: %v", line, err)
		}
		if event.Type == "match" || event.Type == "context" {
			events = append(events, grepEvent{event.Type, event.Data.Path.Text, event.Data.LineNumber, event.Data.Lines.Text})
		}
	}
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].Path != events[j].Path {
			return events[i].Path < events[j].Path
		}
		return events[i].Line < events[j].Line
	})
	return events
}

func TestNativeFindMatchesFd(t *testing.T) {
	if !HasFd() {
		t.Skip("fd is not installed")
	}
	root := setupSearchTree(t)
	queries := []fsFindParams{
		{Pattern: "*.txt", Mode: "glob", Hidden: true},
		{Pattern: "*.jpg", Mode: "glob", Hidden: true},
		{Pattern: "**/a/**/*.mp4", Mode: "glob", Hidden: true, FullPath: true},
		{Pattern: "*", Mode: "glob", Hidden: true, Ignore: []string{"src"}},
		{Pattern: "*", Mode: "glob", Ignore: []string{"*.{md,txt}", "src/deep/"}},
		{Pattern: "*.log", Mode: "glob", IgnoreVcs: true},
		{Pattern: "util", Mode: "fixed-strings"},
		{Pattern: `^img_\d+`, Hidden: true},
	}
	for _, query := range queries {
		args := []string{"--color=never", "--no-require-git", "--exclude", ".git"}
		switch query.Mode {
		case "glob":
			args = append(args, "--glob")
		case "fixed-strings":
			args = append(args, "--fixed-strings")
		}
		if query.Hidden {
			args = append(args, "--hidden")
		}
		if query.IgnoreVcs {
			args = append(args, "--no-ignore-vcs")
		}
		if query.FullPath {
			args = append(args, "--full-path")
		}
		for _, pattern := range query.Ignore {
			args = append(args, "--exclude", pattern)
		}
		cmd := exec.Command("fd", append(args, "--", query.Pattern, ".")...)
		cmd.Dir = root
		output, err := cmd.Output()
		if err != nil {
			t.Fatalf("fd %v: %v", args, err)
		}
		want := make([]string, 0)
		for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
			if line = strings.TrimSuffix(strings.TrimPrefix(line, "./"), "/"); line != "" {
				want = append(want, line)
			}
		}
		got, err := nativeFind(root, query, root, 1000)
		if err != nil {
			t.Fatal(err)
		}
		sort.Strings(want)
		sort.Strings(got)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%+v\nnative %q\nfd     %q", query, got, want)
		}
	}
}

func TestNativeGrepMatchesRipgrep(t *testing.T) {
	if !HasRipgrep() {
		t.Skip("rg is not installed")
	}
	root := setupSearchTree(t)
	queries := []fsGrepParams{
		{Pattern: "needle", Hidden: true},
		{Pattern: "needle", IgnoreCase: true, Context: 2},
		{Pattern: "needle", MaxCount: 1, Context: 1},
		{Pattern: "Needle|中文", Hidden: true},
		{Pattern: "needle + needle", Literal: true},
		{Pattern: "needle", Glob: "*.{ts,md}"},
		{Pattern: "needle", Glob: "!src/**", Hidden: true},
		{Pattern: `export \w+`},
	}
	for _, query := range queries {
		query.JSON = true
		args := []string{"--line-number", "--color=never", "--json", "--no-require-git", "--glob", "!.git/**"}
		if query.Hidden {
			args = append(args, "--hidden")
		}
		if query.MaxCount > 0 {
			args = append(args, "--max-count", strconv.Itoa(query.MaxCount))
		}
		if query.Context > 0 {
			args = append(args, "--context", strconv.Itoa(query.Context))
		}
		if query.IgnoreCase {
			args = append(args, "--ignore-case")
		}
		if query.Literal {
			args = append(args, "--fixed-strings")
		}
		if query.Glob != "" {
			args = append(args, "--glob", query.Glob)
		}
		cmd := exec.Command("rg", append(args, "--", query.Pattern, ".")...)
		cmd.Dir = root
		output, _ := cmd.Output()
		want := decodeGrepEvents(t, strings.Split(strings.TrimSpace(string(output)), "\n"))
		lines, err := nativeGrep(root, ".", query, root, 10_000)
		if err != nil {
			t.Fatal(err)
		}
		if got := decodeGrepEvents(t, lines); !reflect.DeepEqual(got, want) {
			t.Errorf("%+v\nnative %v\nrg     %v", query, got, want)
		}
	}
}
