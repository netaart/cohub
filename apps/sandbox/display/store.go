package display

import (
	"cmp"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

type Store struct {
	root   string
	logger *slog.Logger
	once   sync.Once
	mu     sync.Mutex
	images int
}

const (
	storeDir           = ".cache/cohub/displays"
	turnImagesMaxBytes = 256 << 20
	turnImagesPruneAt  = 50
)

func NewStore(workspace string, logger *slog.Logger) *Store {
	if workspace == "" {
		return nil
	}
	return &Store{root: filepath.Join(workspace, filepath.FromSlash(storeDir)), logger: logger}
}

func (s *Store) prepare() {
	s.once.Do(func() {
		if err := os.MkdirAll(s.root, 0o755); err != nil {
			return
		}
		writeOnce(filepath.Join(filepath.Dir(s.root), ".gitignore"), "*\n")
		writeOnce(filepath.Join(s.root, ".nomedia"), "")
	})
}

func writeOnce(path, content string) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return
	}
	_, _ = file.WriteString(content)
	_ = file.Close()
}

func (s *Store) dir(parts ...string) (string, error) {
	s.prepare()
	dir := filepath.Join(append([]string{s.root}, parts...)...)
	return dir, os.MkdirAll(dir, 0o755)
}

func writeJSON(path string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	if err := os.WriteFile(temp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

func (s *Store) logPlan(entry PlanLog, image *CaptureResult) {
	if s == nil || !actorIDPattern.MatchString(entry.TurnID) {
		return
	}
	dir, err := s.dir("turns")
	if err != nil {
		s.warn("display log unavailable", err)
		return
	}
	if image != nil {
		if data, err := base64.StdEncoding.DecodeString(image.Data); err == nil {
			name := entry.Plan + extensionOf(image.MimeType)
			if images, err := s.dir("turns", entry.TurnID); err == nil && os.WriteFile(filepath.Join(images, name), data, 0o644) == nil {
				entry.Image = name
				s.mu.Lock()
				s.images++
				prune := s.images >= turnImagesPruneAt
				if prune {
					s.images = 0
				}
				s.mu.Unlock()
				if prune {
					pruneTurnImages(dir, entry.TurnID)
				}
			}
		}
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := os.OpenFile(filepath.Join(dir, entry.TurnID+".ndjson"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		s.warn("display log unavailable", err)
		return
	}
	defer file.Close()
	if _, err := file.Write(append(line, '\n')); err != nil {
		s.warn("display log write failed", err)
	}
}

func extensionOf(mimeType string) string {
	if mimeType == "image/png" {
		return ".png"
	}
	return ".jpg"
}

func (s *Store) warn(message string, err error) {
	if s.logger != nil && !errors.Is(err, os.ErrNotExist) {
		s.logger.Warn(message, slog.String("error", err.Error()))
	}
}

func pruneTurnImages(dir, keep string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type turn struct {
		path     string
		bytes    int64
		modified int64
	}
	var turns []turn
	var total int64
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == keep {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		bytes, modified := dirBytes(path)
		turns = append(turns, turn{path, bytes, modified})
		total += bytes
	}
	slices.SortFunc(turns, func(a, b turn) int { return cmp.Compare(a.modified, b.modified) })
	for _, item := range turns {
		if total <= turnImagesMaxBytes {
			return
		}
		if os.RemoveAll(item.path) == nil {
			total -= item.bytes
		}
	}
}
