package rpc

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTree(t *testing.T, root string, dirs []string, files map[string]string) {
	t.Helper()
	for _, dir := range dirs {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(dir)), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	for name, content := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", filepath.Dir(name), err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
}

func treeNames(t *testing.T, d *Dispatcher, params fsTreeParams) map[string]bool {
	t.Helper()
	names := map[string]bool{}
	for _, entry := range treeEntries(t, runTree(t, d, params)) {
		names[entry.Path] = true
	}
	return names
}

// Rules in the workspace .gitignore are anchored at the workspace root. A tree
// requested from a directory inside the workspace must apply them the same way
// it does from the root.
func TestFSTreeAppliesRootGitignoreFromSubdirectory(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	writeTree(t, root, []string{"docs/build", "docs/keep", "src/dist", "dist"}, map[string]string{
		".gitignore": "docs/build/\n/dist/\n",
	})
	d := newTreeDispatcher(t, root)

	for _, pagination := range []bool{false, true} {
		t.Run(map[bool]string{false: "tree", true: "page"}[pagination], func(t *testing.T) {
			names := treeNames(t, d, fsTreeParams{Path: "docs", Depth: 1, Pagination: pagination})
			if names["build"] {
				t.Fatalf("listed docs/build, which the workspace .gitignore excludes: %v", names)
			}
			if !names["keep"] {
				t.Fatalf("hid docs/keep, which no rule excludes: %v", names)
			}
		})
	}

	// A rule anchored at the root must not reach a same-named directory deeper in
	// the workspace, which a path relative to the requested directory would do.
	if names := treeNames(t, d, fsTreeParams{Path: "src", Depth: 1}); !names["dist"] {
		t.Fatalf("hid src/dist, but /dist/ only excludes the root one: %v", names)
	}
}

// A clone or submodule carries its own .git below the workspace root, and it
// stays hidden wherever the tree is requested from.
func TestFSTreeHidesNestedGitDirectory(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	writeTree(t, root, []string{"repo/.git/objects", "repo/src"}, nil)
	d := newTreeDispatcher(t, root)

	for _, pagination := range []bool{false, true} {
		names := treeNames(t, d, fsTreeParams{Path: "repo", Depth: 1, Pagination: pagination})
		if names[".git"] {
			t.Fatalf("pagination=%v listed repo/.git: %v", pagination, names)
		}
		if !names["src"] {
			t.Fatalf("pagination=%v hid repo/src: %v", pagination, names)
		}
	}
	// A recursive walk from the root must not descend into it either.
	if names := treeNames(t, d, fsTreeParams{Path: ".", Depth: 3}); names["repo/.git"] {
		t.Fatalf("recursive tree listed repo/.git: %v", names)
	}
}

// Asking for a directory that a rule ignores lists what the directory holds,
// the way a shell would, instead of returning nothing.
func TestFSTreeListsExplicitlyRequestedIgnoredDirectory(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	writeTree(t, root, []string{"node_modules/react/cjs"}, map[string]string{
		".gitignore":                      "node_modules/\n",
		"node_modules/react/index.js":     "x",
		"node_modules/react/cjs/logic.js": "y",
	})
	d := newTreeDispatcher(t, root)

	for _, pagination := range []bool{false, true} {
		names := treeNames(t, d, fsTreeParams{Path: "node_modules/react", Depth: 1, Pagination: pagination})
		if !names["index.js"] || !names["cjs"] {
			t.Fatalf("pagination=%v returned %v for an explicitly requested directory", pagination, names)
		}
	}
	// The rule still hides the directory itself from its parent listing.
	if names := treeNames(t, d, fsTreeParams{Path: ".", Depth: 1}); names["node_modules"] {
		t.Fatalf("listed node_modules at the root: %v", names)
	}
}
