package search

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

type searchGeneration struct {
	definition  indexDefinition
	fingerprint string
	root        string
	client      *client
	workspace   *workspaceAdapter
	cancel      context.CancelFunc
	done        chan struct{}
	err         error
	queries     sync.WaitGroup
}

func schemaFingerprint(definition indexDefinition) (string, []byte, error) {
	body, err := json.Marshal(definition)
	if err != nil {
		return "", nil, err
	}
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:]), body, nil
}

func atomicFile(path string, body []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".search-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(body); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func (m *Manager) startGeneration(ctx context.Context, definition indexDefinition, root string) (*searchGeneration, error) {
	fingerprint, body, err := schemaFingerprint(definition)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	schema := filepath.Join(root, "schema.json")
	if err := atomicFile(schema, body); err != nil {
		return nil, err
	}
	parent := filepath.Dir(m.cfg.SearchSocketPath)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(parent)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("search socket directory must be private / 搜索 socket 目录必须为私有目录")
	}
	run, err := os.MkdirTemp(parent, "g-")
	if err != nil {
		return nil, err
	}
	socket := filepath.Join(run, "s")
	cfg := m.cfg
	cfg.SearchSchemaPath, cfg.SearchIndexDir, cfg.SearchSocketPath = schema, root, socket
	processCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(processCtx, m.binary, processArgs(cfg)...)
	cmd.Stdout = &logWriter{logger: m.logger, level: slog.LevelInfo, prefix: "search"}
	cmd.Stderr = &logWriter{logger: m.logger, level: slog.LevelWarn, prefix: "search"}
	if err := cmd.Start(); err != nil {
		cancel()
		_ = os.RemoveAll(run)
		return nil, err
	}
	client := newClient(socket)
	generation := &searchGeneration{definition: definition, fingerprint: fingerprint, root: root, client: client, workspace: &workspaceAdapter{cfg: m.cfg, client: client}, cancel: cancel, done: make(chan struct{})}
	go func() { generation.err = cmd.Wait(); close(generation.done) }()
	return generation, nil
}

func (generation *searchGeneration) stop() {
	generation.queries.Wait()
	generation.cancel()
	<-generation.done
	generation.client.http.CloseIdleConnections()
	_ = os.RemoveAll(filepath.Dir(generation.client.socket))
}

func (generation *searchGeneration) waitReady(ctx context.Context) error {
	deadline := time.NewTimer(readyTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := generation.client.status(ctx); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-generation.done:
			return fmt.Errorf("search process exited / 搜索进程已退出: %v", generation.err)
		case <-deadline.C:
			return fmt.Errorf("search process startup timed out / 搜索进程启动超时")
		case <-ticker.C:
		}
	}
}

func (m *Manager) initialDefinition() (indexDefinition, string, error) {
	pointer := filepath.Join(m.cfg.SearchIndexDir, "active.json")
	body, err := os.ReadFile(pointer)
	if err == nil {
		var active struct {
			Directory string `json:"directory"`
		}
		if err := json.Unmarshal(body, &active); err != nil {
			return indexDefinition{}, "", fmt.Errorf("invalid active search pointer / 当前索引指针无效: %w", err)
		}
		if !safeRelative(active.Directory) {
			return indexDefinition{}, "", fmt.Errorf("unsafe search generation path / 索引代次路径无效")
		}
		root := filepath.Join(m.cfg.SearchIndexDir, active.Directory)
		definition, err := loadWorkspaceDefinition(filepath.Join(root, "schema.json"))
		return definition, root, err
	}
	if !errors.Is(err, os.ErrNotExist) {
		return indexDefinition{}, "", err
	}
	definition, fallback, err := resolveWorkspaceDefinition(m.cfg.SearchSchemaPath)
	if fallback {
		m.logger.Info("using built-in workspace schema / 使用内置工作区 schema")
	}
	if err != nil {
		return definition, "", err
	}
	return definition, filepath.Join(m.cfg.SearchIndexDir, "generations", uuid.NewString()), nil
}

func (m *Manager) persistActive(generation *searchGeneration) error {
	relative, err := filepath.Rel(m.cfg.SearchIndexDir, generation.root)
	if err != nil || !safeRelative(relative) {
		return fmt.Errorf("invalid search generation path / 索引代次路径无效")
	}
	body, err := json.Marshal(struct {
		Directory string `json:"directory"`
	}{relative})
	if err != nil {
		return err
	}
	if err := atomicFile(filepath.Join(m.cfg.SearchIndexDir, "active.json"), body); err != nil {
		return err
	}
	return m.publishSocket(generation)
}

func (m *Manager) publishSocket(generation *searchGeneration) error {
	if info, err := os.Lstat(m.cfg.SearchSocketPath); err == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			return fmt.Errorf("refusing to replace non-symlink search socket / 拒绝覆盖非链接 socket 路径")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	link := filepath.Join(filepath.Dir(m.cfg.SearchSocketPath), ".search-"+uuid.NewString())
	if err := os.Symlink(generation.client.socket, link); err != nil {
		return err
	}
	defer os.Remove(link)
	return os.Rename(link, m.cfg.SearchSocketPath)
}

func (m *Manager) superviseGenerations(ctx context.Context) error {
	definition, root, err := m.initialDefinition()
	if err != nil {
		return err
	}
	generation, err := m.startGeneration(ctx, definition, root)
	if err != nil {
		return err
	}
	if err := generation.waitReady(ctx); err != nil {
		generation.stop()
		return err
	}
	if err := m.persistActive(generation); err != nil {
		generation.stop()
		return err
	}
	m.generationMu.Lock()
	m.active = generation
	m.generationMu.Unlock()
	defer func() {
		// The command loop owns schema rebuilds. Wait before collecting its processes.
		if ctx.Err() != nil {
			<-m.commandDone
		}
		m.generationMu.Lock()
		active, retired := m.active, m.retired
		m.active, m.retired = nil, nil
		m.generationMu.Unlock()
		if active != nil {
			active.stop()
		}
		for _, old := range retired {
			old.stop()
		}
	}()
	m.enqueueControl(command{reconcile: true})
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			m.generationMu.Lock()
			current := m.active
			select {
			case <-current.done:
				m.processReady.Store(false)
				// Restart the published generation, not a possibly invalid new config.
				restarted, startErr := m.startGeneration(ctx, current.definition, current.root)
				if startErr == nil {
					startErr = restarted.waitReady(ctx)
					if startErr == nil {
						startErr = m.publishSocket(restarted)
					}
					if startErr != nil {
						restarted.stop()
					}
				}
				if startErr == nil {
					m.active = restarted
					m.retired = append(m.retired, current)
				}
				m.generationMu.Unlock()
				if startErr != nil {
					m.logger.Warn("search restart failed / 搜索重启失败", slog.String("error", startErr.Error()))
					continue
				}
				m.stopRetired(current)
				m.enqueueControl(command{reconcile: true})
			default:
				m.generationMu.Unlock()
			}
		}
	}
}

func (m *Manager) stopRetired(generation *searchGeneration) {
	generation.stop()
	m.generationMu.Lock()
	defer m.generationMu.Unlock()
	for index, old := range m.retired {
		if old == generation {
			m.retired = append(m.retired[:index], m.retired[index+1:]...)
			break
		}
	}
}

func (m *Manager) watchSchema(ctx context.Context) {
	defer close(m.reloadDone)
	ticker := time.NewTicker(m.schemaPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if m.activated.Load() && m.schemaPending.CompareAndSwap(false, true) {
				select {
				case m.control <- command{schema: true}:
				default:
					m.schemaPending.Store(false)
				}
			}
		}
	}
}

func (m *Manager) reloadSchema(ctx context.Context) error {
	definition, _, err := resolveWorkspaceDefinition(m.cfg.SearchSchemaPath)
	if err != nil {
		return err
	}
	fingerprint, _, err := schemaFingerprint(definition)
	if err != nil {
		return err
	}
	m.generationMu.RLock()
	current := m.active
	m.generationMu.RUnlock()
	if current == nil || current.fingerprint == fingerprint {
		return nil
	}
	root := filepath.Join(m.cfg.SearchIndexDir, "generations", uuid.NewString())
	candidate, err := m.startGeneration(ctx, definition, root)
	if err != nil {
		_ = os.RemoveAll(root)
		return err
	}
	published := false
	publicationAttempted := false
	defer func() {
		if !published {
			candidate.stop()
			if !publicationAttempted {
				_ = os.RemoveAll(root)
			}
		}
	}()
	if err := candidate.waitReady(ctx); err != nil {
		return err
	}
	// Commands remain queued while building. Queries continue using the old
	// generation, and an overflow is repaired by the queued reconcile command.
	needsReconcile := false
	for pass := 0; pass < 2; pass++ {
		sequence := m.changeSeq.Load()
		if err := candidate.workspace.reconcile(ctx); err != nil {
			return err
		}
		needsReconcile = sequence != m.changeSeq.Load()
		if !needsReconcile {
			break
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	if needsReconcile {
		status, err := candidate.client.status(ctx)
		if err != nil {
			return err
		}
		cursor := status.SourceCursor
		if err := candidate.workspace.write(ctx, &cursor, nil, "partial"); err != nil {
			return err
		}
	}
	latest, _, err := resolveWorkspaceDefinition(m.cfg.SearchSchemaPath)
	if err != nil {
		return err
	}
	latestFingerprint, _, err := schemaFingerprint(latest)
	if err != nil {
		return err
	}
	if latestFingerprint != fingerprint {
		return fmt.Errorf("schema changed during rebuild; retrying / 重建期间 schema 已变化，将重新尝试")
	}
	m.generationMu.Lock()
	publicationAttempted = true
	if err := m.persistActive(candidate); err != nil {
		m.generationMu.Unlock()
		return err
	}
	old := m.active
	m.active = candidate
	m.retired = append(m.retired, old)
	m.processReady.Store(true)
	published = true
	m.generationMu.Unlock()
	// Queries that already captured the old generation finish before it stops.
	m.stopRetired(old)
	if needsReconcile {
		m.enqueueControl(command{reconcile: true})
	}
	m.logger.Info("search schema rebuilt and activated / 搜索 schema 已重建并切换", slog.Int("schemaVersion", definition.SchemaVersion), slog.String("generation", candidate.root))
	return nil
}
