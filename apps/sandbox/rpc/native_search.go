package rpc

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"unicode"

	ignore "github.com/sabhiram/go-gitignore"
)

// fd and ripgrep are accelerators: without them fs.find / fs.grep walk the tree with the same defaults.
var (
	HasFd      = sync.OnceValue(func() bool { return hasExecutable("fd") })
	HasRipgrep = sync.OnceValue(func() bool { return hasExecutable("rg") })
)

func hasExecutable(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

var errStopWalk = errors.New("stop walk")

type walkOptions struct {
	hidden     bool // include dotfiles
	noVcs      bool
	requireGit bool
	stopAt     string
}

type ignoreScope struct {
	dir string
	gi  *ignore.GitIgnore
}

type walker struct {
	opts   walkOptions
	vcs    bool
	scopes []ignoreScope
}

func walkTree(root string, opts walkOptions, visit func(abs, rel string, entry fs.DirEntry) error) error {
	w := &walker{opts: opts, vcs: !opts.noVcs && (!opts.requireGit || insideGitRepo(root))}
	var ancestors []string
	for dir := filepath.Dir(root); opts.stopAt != "" && withinDir(opts.stopAt, dir); dir = filepath.Dir(dir) {
		ancestors = append(ancestors, dir)
		if dir == filepath.Clean(opts.stopAt) || dir == filepath.Dir(dir) {
			break
		}
	}
	for i := len(ancestors) - 1; i >= 0; i-- {
		w.enter(ancestors[i])
	}
	err := w.walkDir(root, "", visit)
	if errors.Is(err, errStopWalk) {
		return nil
	}
	return err
}

func (w *walker) walkDir(dir, rel string, visit func(abs, rel string, entry fs.DirEntry) error) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if rel == "" {
			return err
		}
		return nil
	}
	depth := len(w.scopes)
	w.enter(dir)
	defer func() { w.scopes = w.scopes[:depth] }()

	for _, entry := range entries {
		name := entry.Name()
		if name == ".git" || (!w.opts.hidden && strings.HasPrefix(name, ".")) {
			continue
		}
		abs := filepath.Join(dir, name)
		childRel := name
		if rel != "" {
			childRel = rel + "/" + name
		}
		if w.ignored(abs, entry.IsDir()) {
			continue
		}
		if err := visit(abs, childRel, entry); err != nil {
			if errors.Is(err, fs.SkipDir) {
				continue
			}
			return err
		}
		if entry.IsDir() {
			if err := w.walkDir(abs, childRel, visit); err != nil {
				return err
			}
		}
	}
	return nil
}

func (w *walker) enter(dir string) {
	files := []string{".ignore"}
	if w.vcs {
		files = append(files, ".gitignore")
	}
	for _, name := range files {
		if gi, err := ignore.CompileIgnoreFile(filepath.Join(dir, name)); err == nil {
			w.scopes = append(w.scopes, ignoreScope{dir: dir, gi: gi})
		}
	}
}

func (w *walker) ignored(abs string, isDir bool) bool {
	for _, scope := range w.scopes {
		rel, err := filepath.Rel(scope.dir, abs)
		if err != nil {
			continue
		}
		if matchesIgnore(scope.gi, filepath.ToSlash(rel), isDir) {
			return true
		}
	}
	return false
}

func matchesIgnore(gi *ignore.GitIgnore, rel string, isDir bool) bool {
	return gi.MatchesPath(rel) || (isDir && gi.MatchesPath(rel+"/"))
}

func insideGitRepo(dir string) bool {
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
}

func withinDir(root, candidate string) bool {
	root, candidate = filepath.Clean(root), filepath.Clean(candidate)
	return candidate == root || strings.HasPrefix(candidate, root+string(filepath.Separator))
}

func nativeFind(root string, params fsFindParams, stopAt string, limit int) ([]string, error) {
	match, err := compileFindPattern(params)
	if err != nil {
		return nil, err
	}
	excludes := make([]pathGlob, 0, len(params.Ignore))
	for _, pattern := range params.Ignore {
		if exclude, err := newPathGlob(pattern); err != nil {
			return nil, err
		} else if exclude.re != nil {
			excludes = append(excludes, exclude)
		}
	}
	opts := walkOptions{hidden: params.Hidden, noVcs: params.IgnoreVcs, requireGit: params.RequireGit, stopAt: stopAt}
	matches := make([]string, 0)
	err = walkTree(root, opts, func(abs, rel string, entry fs.DirEntry) error {
		for _, exclude := range excludes {
			if exclude.matches(rel, entry.IsDir()) {
				return fs.SkipDir
			}
		}
		target := entry.Name()
		if params.FullPath {
			target = abs
		}
		if match.MatchString(target) {
			matches = append(matches, rel)
			if len(matches) > limit {
				return errStopWalk
			}
		}
		return nil
	})
	return matches, err
}

func compileFindPattern(params fsFindParams) (*regexp.Regexp, error) {
	var expr string
	switch params.Mode {
	case "glob":
		translated, err := globToRegexp(params.Pattern)
		if err != nil {
			return nil, err
		}
		expr = translated
	case "fixed-strings":
		expr = regexp.QuoteMeta(params.Pattern)
	default:
		expr = params.Pattern
	}
	if !hasUpper(params.Pattern) {
		expr = "(?i)" + expr
	}
	return regexp.Compile(expr)
}

func hasUpper(value string) bool {
	return strings.IndexFunc(value, unicode.IsUpper) >= 0
}

func globToRegexp(pattern string) (string, error) {
	parser := globParser{source: pattern}
	var out strings.Builder
	out.WriteString("^")
	if err := parser.parse(&out, false); err != nil {
		return "", err
	}
	out.WriteString("$")
	return out.String(), nil
}

type globParser struct {
	source string
	pos    int
}

func (g *globParser) parse(out *strings.Builder, inAlternative bool) error {
	for g.pos < len(g.source) {
		c := g.source[g.pos]
		switch {
		case inAlternative && (c == ',' || c == '}'):
			return nil
		case c == '*' && g.isGlobstar(inAlternative):
			g.pos += 2
			if g.pos < len(g.source) && g.source[g.pos] == '/' {
				g.pos++
				out.WriteString("(?:.*/)?")
			} else {
				out.WriteString(".*")
			}
		case c == '*':
			g.pos++
			out.WriteString("[^/]*")
		case c == '?':
			g.pos++
			out.WriteString("[^/]")
		case c == '[':
			g.parseClass(out)
		case c == '{':
			g.pos++
			out.WriteString("(?:")
			for {
				if err := g.parse(out, true); err != nil {
					return err
				}
				if g.pos >= len(g.source) {
					return fmt.Errorf("unclosed alternative in glob %q", g.source)
				}
				g.pos++
				if g.source[g.pos-1] == '}' {
					break
				}
				out.WriteString("|")
			}
			out.WriteString(")")
		case c == '\\' && g.pos+1 < len(g.source):
			out.WriteString(regexp.QuoteMeta(g.source[g.pos+1 : g.pos+2]))
			g.pos += 2
		default:
			out.WriteString(regexp.QuoteMeta(g.source[g.pos : g.pos+1]))
			g.pos++
		}
	}
	if inAlternative {
		return fmt.Errorf("unclosed alternative in glob %q", g.source)
	}
	return nil
}

func (g *globParser) isGlobstar(inAlternative bool) bool {
	if !strings.HasPrefix(g.source[g.pos:], "**") {
		return false
	}
	if g.pos > 0 && g.source[g.pos-1] != '/' {
		return false
	}
	end := g.pos + 2
	if end == len(g.source) {
		return true
	}
	next := g.source[end]
	return next == '/' || (inAlternative && (next == ',' || next == '}'))
}

func (g *globParser) parseClass(out *strings.Builder) {
	start := g.pos + 1
	i := start
	if i < len(g.source) && (g.source[i] == '!' || g.source[i] == '^') {
		i++
	}
	if i < len(g.source) && g.source[i] == ']' {
		i++
	}
	end := strings.IndexByte(g.source[i:], ']')
	if end < 0 {
		out.WriteString(`\[`)
		g.pos++
		return
	}
	body := g.source[start : i+end]
	g.pos = i + end + 1
	out.WriteString("[")
	if body != "" && (body[0] == '!' || body[0] == '^') {
		out.WriteString("^")
		body = body[1:]
	}
	for _, r := range body {
		if r == '\\' || r == '[' || r == ']' {
			out.WriteRune('\\')
		}
		out.WriteRune(r)
	}
	out.WriteString("]")
}

const (
	grepBinaryProbeBytes = 64 * 1024
	grepMaxLineBytes     = 1 << 20
)

type rgText struct {
	Text string `json:"text"`
}

type rgSubmatch struct {
	Match rgText `json:"match"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

type rgLineData struct {
	Path           rgText       `json:"path"`
	Lines          rgText       `json:"lines"`
	LineNumber     int          `json:"line_number"`
	AbsoluteOffset int64        `json:"absolute_offset"`
	Submatches     []rgSubmatch `json:"submatches"`
}

type rgEvent struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

func nativeGrep(root, displayRoot string, params fsGrepParams, stopAt string, limit int) ([]string, error) {
	expr := params.Pattern
	if params.Literal {
		expr = regexp.QuoteMeta(expr)
	}
	if params.IgnoreCase {
		expr = "(?i)" + expr
	}
	pattern, err := regexp.Compile(expr)
	if err != nil {
		return nil, fmt.Errorf("regex parse error: %w", err)
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	filter, err := newPathGlob(params.Glob)
	if err != nil {
		return nil, err
	}
	g := &grepRun{params: params, pattern: pattern, limit: limit, withFilename: info.IsDir()}
	if !info.IsDir() {
		err = g.searchFile(root, displayRoot)
		if errors.Is(err, errStopWalk) {
			err = nil
		}
		return g.lines, err
	}
	opts := walkOptions{hidden: params.Hidden, noVcs: params.IgnoreVcs, requireGit: params.RequireGit, stopAt: stopAt}
	err = walkTree(root, opts, func(abs, rel string, entry fs.DirEntry) error {
		if entry.IsDir() {
			if filter.excludes(rel, true) {
				return fs.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() || filter.excludes(rel, false) {
			return nil
		}
		return g.searchFile(abs, joinDisplayPath(displayRoot, rel))
	})
	return g.lines, err
}

func joinDisplayPath(root, rel string) string {
	if root == "/" {
		return "/" + rel
	}
	return strings.TrimSuffix(root, "/") + "/" + rel
}

type pathGlob struct {
	re       *regexp.Regexp
	basename bool
	dirOnly  bool
	negate   bool
}

func newPathGlob(pattern string) (pathGlob, error) {
	pattern = strings.TrimSpace(pattern)
	negate := strings.HasPrefix(pattern, "!")
	pattern = strings.TrimPrefix(pattern, "!")
	dirOnly := strings.HasSuffix(pattern, "/")
	pattern = strings.TrimSuffix(pattern, "/")
	if pattern == "" {
		return pathGlob{}, nil
	}
	basename := !strings.Contains(pattern, "/")
	expr, err := globToRegexp(strings.TrimPrefix(pattern, "/"))
	if err != nil {
		return pathGlob{}, err
	}
	return pathGlob{re: regexp.MustCompile(expr), basename: basename, dirOnly: dirOnly, negate: negate}, nil
}

func (g pathGlob) matches(rel string, isDir bool) bool {
	if g.dirOnly && !isDir {
		return false
	}
	if g.basename {
		rel = rel[strings.LastIndexByte(rel, '/')+1:]
	}
	return g.re.MatchString(rel)
}

func (g pathGlob) excludes(rel string, isDir bool) bool {
	if g.re == nil {
		return false
	}
	matched := g.matches(rel, isDir)
	if g.negate {
		return matched
	}
	return !isDir && !matched
}

type grepRun struct {
	params       fsGrepParams
	pattern      *regexp.Regexp
	limit        int
	withFilename bool
	lines        []string
}

type grepLine struct {
	number int
	offset int64
	text   string
}

func (g *grepRun) emit(line string) error {
	g.lines = append(g.lines, line)
	if len(g.lines) > g.limit {
		return errStopWalk
	}
	return nil
}

func (g *grepRun) emitJSON(kind string, data interface{}) error {
	encoded, err := json.Marshal(rgEvent{Type: kind, Data: data})
	if err != nil {
		return err
	}
	return g.emit(string(encoded))
}

func (g *grepRun) searchFile(abs, display string) error {
	file, err := os.Open(abs)
	if err != nil {
		return nil
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, grepBinaryProbeBytes)
	if probe, _ := reader.Peek(grepBinaryProbeBytes); bytes.IndexByte(probe, 0) >= 0 {
		return nil
	}

	context := max(g.params.Context, 0)
	before := make([]grepLine, 0, context)
	matches, after, lastPrinted := 0, 0, 0
	begun := false
	var offset int64

	printLine := func(kind string, line grepLine) error {
		if !begun {
			begun = true
			if g.params.JSON {
				if err := g.emitJSON("begin", map[string]rgText{"path": {Text: display}}); err != nil {
					return err
				}
			}
		} else if !g.params.JSON && context > 0 && line.number > lastPrinted+1 {
			if err := g.emit("--"); err != nil {
				return err
			}
		}
		lastPrinted = line.number
		text := strings.TrimRight(line.text, "\n")
		if !g.params.JSON {
			separator := "-"
			if kind == "match" {
				separator = ":"
			}
			prefix := ""
			if g.withFilename {
				prefix = display + separator
			}
			return g.emit(fmt.Sprintf("%s%d%s%s", prefix, line.number, separator, strings.TrimRight(text, "\r")))
		}
		submatches := []rgSubmatch{}
		if kind == "match" {
			for _, loc := range g.pattern.FindAllStringIndex(text, -1) {
				submatches = append(submatches, rgSubmatch{Match: rgText{Text: text[loc[0]:loc[1]]}, Start: loc[0], End: loc[1]})
			}
		}
		return g.emitJSON(kind, rgLineData{
			Path: rgText{Text: display}, Lines: rgText{Text: line.text}, LineNumber: line.number,
			AbsoluteOffset: line.offset, Submatches: submatches,
		})
	}

	for number := 1; ; number++ {
		raw, consumed, readErr := readLine(reader)
		if consumed == 0 && readErr != nil {
			break
		}
		if bytes.IndexByte(raw, 0) >= 0 {
			break
		}
		line := grepLine{number: number, offset: offset, text: strings.ToValidUTF8(string(raw), "\uFFFD")}
		offset += consumed
		limitReached := g.params.MaxCount > 0 && matches >= g.params.MaxCount
		if !limitReached && g.pattern.MatchString(strings.TrimRight(line.text, "\r\n")) {
			for _, previous := range before {
				if err := printLine("context", previous); err != nil {
					return err
				}
			}
			before = before[:0]
			if err := printLine("match", line); err != nil {
				return err
			}
			matches++
			after = context
		} else if after > 0 {
			kind := "context"
			if g.pattern.MatchString(strings.TrimRight(line.text, "\r\n")) {
				kind = "match"
			}
			if err := printLine(kind, line); err != nil {
				return err
			}
			after--
		} else if limitReached {
			break
		} else if context > 0 {
			if len(before) == context {
				before = append(before[:0], before[1:]...)
			}
			before = append(before, line)
		}
		if readErr != nil {
			break
		}
	}
	if begun && g.params.JSON {
		return g.emitJSON("end", map[string]interface{}{"path": rgText{Text: display}, "binary_offset": nil})
	}
	return nil
}

func readLine(reader *bufio.Reader) ([]byte, int64, error) {
	var line []byte
	var consumed int64
	truncated := false
	for {
		chunk, err := reader.ReadSlice('\n')
		consumed += int64(len(chunk))
		if !truncated {
			room := grepMaxLineBytes - len(line)
			truncated = len(chunk) > room
			line = append(line, chunk[:min(len(chunk), room)]...)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err == io.EOF && consumed > 0 {
			return line, consumed, nil
		}
		return line, consumed, err
	}
}
