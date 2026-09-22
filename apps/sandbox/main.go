package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/filewatch"
	"github.com/cohub/apps/sandbox/portwatch"
	"github.com/cohub/apps/sandbox/process"
	"github.com/cohub/apps/sandbox/protocol"
	"github.com/cohub/apps/sandbox/relay"
	"github.com/cohub/apps/sandbox/report"
	"github.com/cohub/apps/sandbox/rpc"
	"github.com/cohub/apps/sandbox/search"
	"github.com/cohub/apps/sandbox/workspace"
	"github.com/cohub/apps/sandbox/ws"
)

type prepareState struct {
	mu     sync.RWMutex
	status string // "preparing" | "ready" | "degraded" | "error"
	err    string
	setup  *protocol.SandboxSetupInfo
}

func (s *prepareState) Set(status string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status = status
	if err != nil {
		s.err = err.Error()
	} else {
		s.err = ""
	}
}

func (s *prepareState) SetSetup(setup *protocol.SandboxSetupInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setup = setup
}

func (s *prepareState) Get() (string, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status, s.err
}

func (s *prepareState) GetSetup() *protocol.SandboxSetupInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.setup
}

func sandboxWSEndpoint(podIP string) string {
	if strings.TrimSpace(podIP) == "" {
		return ""
	}
	return fmt.Sprintf("ws://%s:%d/sandbox", podIP, env.DefaultSandboxWSPort)
}

func toProtocolFSChanges(changes []filewatch.Change) []protocol.FSChange {
	out := make([]protocol.FSChange, 0, len(changes))
	for _, change := range changes {
		out = append(out, protocol.FSChange{
			Path:     change.Path,
			OldPath:  change.OldPath,
			Kind:     change.Kind,
			NodeType: change.NodeType,
			MtimeMs:  change.MtimeMs,
			Size:     change.Size,
		})
	}
	return out
}

func toProtocolPortChanges(changes []portwatch.Change) []protocol.PortChange {
	out := make([]protocol.PortChange, 0, len(changes))
	for _, change := range changes {
		out = append(out, protocol.PortChange{
			Port:       change.Port,
			Protocol:   change.Protocol,
			Status:     protocol.PortStatus(change.Status),
			ObservedAt: change.ObservedAt,
		})
	}
	return out
}

// buildVersion is stamped at build time via -ldflags "-X main.buildVersion=...".
// Containerized sandboxes receive a version env; standalone local binaries use
// this build value as the source of truth.
var buildVersion = "dev"

func main() {
	showVersion := flag.Bool("version", false, "print sandbox version and exit")
	localMode := flag.Bool("local", false, "run in local dial-out mode (connect to the gateway relay)")
	localRoot := flag.String("root", "", "local mode: workspace directory to expose")
	localSpace := flag.String("space", "", "local mode: target space id")
	localRelay := flag.String("relay", "", "local mode: gateway relay control url (wss://…/sandbox/relay)")
	flag.Parse()
	if *showVersion {
		fmt.Println(env.ResolveSandboxVersion(buildVersion))
		return
	}

	var handler slog.Handler = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	if *localMode || strings.EqualFold(strings.TrimSpace(os.Getenv("COHUB_LOG_FORMAT")), "json") {
		handler = slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	}
	logger := slog.New(handler)

	if *localMode {
		runLocal(logger, *localSpace, *localRoot, *localRelay)
		return
	}

	cfg, err := env.Load()
	if err != nil {
		logger.Error("failed to load env", slog.String("error", err.Error()))
		os.Exit(1)
	}
	runCloud(logger, cfg)
}

// buildRuntime wires the shared sandbox runtime (process manager, dispatcher, ws
// server) and starts the file/port watchers. The returned cleanup closes the
// watchers. It is used by both cloud (listen) and local (dial-out) modes.
//
// fsSink/portsSink override where watcher batches are delivered. Cloud mode
// leaves them nil and broadcasts to attached data sessions; local mode routes
// them over the relay control channel so the web file tree stays live without
// an attached agent (and avoids double-publishing on data sessions).
func buildRuntime(
	logger *slog.Logger,
	cfg env.Config,
	state *prepareState,
	reporter *report.Client,
	hostname string,
	fsSink func(protocol.FSChangedPayload),
	portsSink func(protocol.PortsChangedPayload),
) (*ws.Server, func(), func(), *search.Manager, func() filewatch.Status) {
	processManager := process.NewManager(logger)
	searchManager := search.NewManager(cfg, logger)
	searchManager.Start()
	dispatcher := rpc.NewDispatcher(cfg, processManager, logger)
	dispatcher.SetSearchManager(searchManager)
	server := ws.NewServer(cfg, dispatcher, processManager, reporter, state, hostname, logger)
	server.SetSearchEnabled(searchManager.Enabled())

	if fsSink == nil {
		fsSink = server.BroadcastFSChanged
	}
	if portsSink == nil {
		portsSink = server.BroadcastPortsChanged
	}

	var closers []func()
	requestFSResync := func() {}
	watchStatus := func() filewatch.Status {
		return filewatch.Status{Backend: "none", State: "unavailable", Reason: "start_failed"}
	}
	if watcher, err := filewatch.Start(cfg.WorkspaceDir, logger, func(batch filewatch.Batch) {
		searchManager.Apply(batch)
		fsSink(protocol.FSChangedPayload{
			Seq:     batch.Seq,
			Resync:  batch.Resync,
			Changes: toProtocolFSChanges(batch.Changes),
		})
	}); err != nil {
		logger.Warn("file watcher disabled", slog.String("error", err.Error()))
	} else {
		requestFSResync = watcher.RequestResync
		watchStatus = watcher.Status
		closers = append(closers, func() { watcher.Close() })
		logger.Info("file watcher started", slog.String("workspaceDir", cfg.WorkspaceDir))
	}

	if watcher, err := portwatch.Start(cfg.PublicPorts, logger, func(batch portwatch.Batch) {
		portsSink(protocol.PortsChangedPayload{
			Seq:    batch.Seq,
			Resync: batch.Resync,
			Ports:  toProtocolPortChanges(batch.Changes),
		})
	}); err != nil {
		logger.Warn("port watcher disabled", slog.String("error", err.Error()))
	} else {
		closers = append(closers, func() { watcher.Close() })
		logger.Info("port watcher started", slog.Any("ports", cfg.PublicPorts))
	}

	closers = append(closers, searchManager.Close)
	return server, func() {
		for _, close := range closers {
			close()
		}
	}, requestFSResync, searchManager, watchStatus
}

func runCloud(logger *slog.Logger, cfg env.Config) {
	state := &prepareState{status: "preparing"}
	startedAt := time.Now().UTC().Format(time.RFC3339)
	hostname, _ := os.Hostname()
	reporter := report.NewClient(cfg, hostname)

	server, closeWatchers, _, searchManager, _ := buildRuntime(logger, cfg, state, reporter, hostname, nil, nil)
	defer closeWatchers()
	server.SetFSResyncOnAttach(true)

	initialMeta := map[string]interface{}{
		"hostname":     hostname,
		"imageVersion": cfg.ImageVersion,
		"startedAt":    startedAt,
		"podIp":        cfg.PodIP,
		"wsEndpoint":   sandboxWSEndpoint(cfg.PodIP),
	}
	if err := reporter.Report(report.Payload{
		Status: "provisioning",
		Meta:   initialMeta,
	}); err != nil {
		logger.Warn("failed to report sandbox provisioning", slog.String("error", err.Error()))
	}

	// Ensure workspace mount exists in background while WS server starts.
	go func() {
		summary, err := workspace.Prepare(cfg, logger)
		if err != nil {
			logger.Error("workspace prepare failed", slog.String("error", err.Error()))
			state.Set("error", err)
			if reportErr := reporter.Report(report.Payload{
				Status: "error",
				Meta: map[string]interface{}{
					"hostname":     hostname,
					"imageVersion": cfg.ImageVersion,
					"lastError":    err.Error(),
					"podIp":        cfg.PodIP,
					"wsEndpoint":   sandboxWSEndpoint(cfg.PodIP),
				},
			}); reportErr != nil {
				logger.Warn("failed to report sandbox error", slog.String("error", reportErr.Error()))
			}
		} else {
			// Persist setup result into state for heartbeat visibility.
			// Both SetSetup and Set are called sequentially in the same goroutine;
			// heartbeat reads use GetSetup/Get with RLock, so race risk is negligible.
			if summary.Setup != nil {
				si := &protocol.SandboxSetupInfo{
					Ran:      summary.Setup.Ran,
					ExitCode: summary.Setup.ExitCode,
					Stdout:   summary.Setup.Stdout,
					Stderr:   summary.Setup.Stderr,
					Duration: summary.Setup.Duration,
					Error:    summary.Setup.Error,
				}
				state.SetSetup(si)
				if summary.Setup.ExitCode != 0 || summary.Setup.Error != "" {
					state.Set("degraded", nil)
				}
			}

			searchManager.Activate()
			logger.Info("workspace mount ready",
				slog.String("workspaceDir", summary.WorkspaceDir),
				slog.String("platformAgentsDir", summary.PlatformAgentsDir),
				slog.String("userAgentsDir", cfg.UserAgentsDir),
			)
			currentStatus, _ := state.Get()
			if currentStatus == "preparing" {
				state.Set("ready", nil)
			}
			if reportErr := reporter.Report(report.Payload{
				Status: state.status,
				Meta: map[string]interface{}{
					"hostname":          hostname,
					"imageVersion":      cfg.ImageVersion,
					"workspaceDir":      summary.WorkspaceDir,
					"platformAgentsDir": summary.PlatformAgentsDir,
					"userAgentsDir":     cfg.UserAgentsDir,
					"podIp":             cfg.PodIP,
					"wsEndpoint":        sandboxWSEndpoint(cfg.PodIP),
				},
			}); reportErr != nil {
				logger.Warn("failed to report sandbox ready", slog.String("error", reportErr.Error()))
			}
		}
	}()

	if err := server.Run(); err != nil {
		logger.Error("sandbox exited", slog.String("error", err.Error()))
		os.Exit(1)
	}
}

// runLocal connects the sandbox to the gateway relay in dial-out mode. There is
// no reporter (the gateway owns status reporting for local sandboxes) and no
// workspace bootstrap — the user's directory is already the workspace.
func runLocal(logger *slog.Logger, spaceID, root, relayURL string) {
	relayToken := strings.TrimSpace(os.Getenv("COHUB_RELAY_TOKEN"))
	// Remove the user token from the environment immediately so it can never be
	// inherited by agent-started processes via os.Environ().
	_ = os.Unsetenv("COHUB_RELAY_TOKEN")
	// The standalone binary's build version is the authoritative local runtime version.
	_ = os.Setenv("COHUB_SANDBOX_VERSION", buildVersion)
	cfg, err := env.LoadLocal(env.LocalOptions{
		SpaceID:    spaceID,
		RootDir:    root,
		RelayURL:   relayURL,
		RelayToken: relayToken,
	})
	if err != nil {
		logger.Error("failed to load local config", slog.String("error", err.Error()))
		os.Exit(1)
	}

	runtimeID := strings.TrimSpace(os.Getenv("COHUB_RUNTIME_ID"))
	if runtimeID != "" {
		logger = logger.With(
			slog.String("component", "sandboxd"),
			slog.String("runtimeId", runtimeID),
			slog.String("spaceId", cfg.SpaceID),
		)
	}

	state := &prepareState{status: "ready"}
	hostname, _ := os.Hostname()

	// Create the relay client first so the runtime's watchers can publish
	// fs.changed / ports.changed over the control channel (kept off data
	// sessions to avoid double-publishing; the gateway republishes them).
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	var managed *relay.ManagedControl
	if os.Getenv("COHUB_RUNTIME_MANAGED") == "1" {
		control := os.NewFile(3, "runtime-control")
		defer control.Close()
		managed = relay.NewManagedControl(cfg.RelayToken, os.Stdin, control, stop)
	}
	requestFSResync := func() {}
	opts := relay.Options{
		RelayURL:  cfg.RelayURL,
		Token:     cfg.RelayToken,
		SpaceID:   cfg.SpaceID,
		RuntimeID: runtimeID,
		OnRegistered: func() {
			requestFSResync()
			if managed != nil {
				managed.Notify("connected")
			}
		},
		Logger: logger,
	}
	if managed != nil {
		opts.CurrentToken = managed.Token
		opts.OnDisconnected = func() { managed.Notify("disconnected") }
	}
	client := relay.NewClient(opts)

	fsSink := func(payload protocol.FSChangedPayload) {
		client.PublishEvent("fs.changed", payload)
	}
	portsSink := func(payload protocol.PortsChangedPayload) {
		client.PublishEvent("ports.changed", payload)
	}

	server, closeWatchers, watcherResync, _, watchStatus := buildRuntime(logger, cfg, state, nil, hostname, fsSink, portsSink)
	defer closeWatchers()
	requestFSResync = watcherResync
	client.SetServer(server)
	client.SetWatcherStatus(watchStatus)

	logger.Info("local sandbox starting",
		slog.String("spaceId", cfg.SpaceID),
		slog.String("workspaceDir", cfg.WorkspaceDir),
		slog.String("relay", cfg.RelayURL),
	)

	if err := client.Run(ctx); err != nil {
		logger.Error("local sandbox stopped", slog.String("error", err.Error()))
		os.Exit(1)
	}
	logger.Info("local sandbox stopped")
}
