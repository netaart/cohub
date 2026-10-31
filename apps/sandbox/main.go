package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/cohub/apps/sandbox/display"
	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/filewatch"
	"github.com/cohub/apps/sandbox/local"
	"github.com/cohub/apps/sandbox/portwatch"
	"github.com/cohub/apps/sandbox/power"
	"github.com/cohub/apps/sandbox/process"
	"github.com/cohub/apps/sandbox/protocol"
	"github.com/cohub/apps/sandbox/relay"
	"github.com/cohub/apps/sandbox/report"
	"github.com/cohub/apps/sandbox/rpc"
	"github.com/cohub/apps/sandbox/rtc"
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
	s.err = setup.Error
	switch setup.Status {
	case "waiting", "running":
		s.status = "preparing"
	case "succeeded":
		s.status = "ready"
	case "failed":
		s.status = "degraded"
	}
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

type displaysPayload struct {
	Displays []display.Info `json:"displays"`
}

// buildVersion is stamped at build time via -ldflags "-X main.buildVersion=...".
// Containerized sandboxes receive a version env; standalone local binaries use
// this build value as the source of truth.
var buildVersion = "dev"

func main() {
	if len(os.Args) > 1 && os.Args[1] == display.EncoderCommand {
		os.Exit(display.RunEncoder(os.Args[2:]))
	}
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

type sandboxRuntime struct {
	dispatcher      *rpc.Dispatcher
	processes       *process.Manager
	server          *ws.Server
	search          *search.Manager
	displays        *display.Hub
	displaySpec     *atomic.Pointer[string]
	setDisplay      func(spec string) error
	keeper          *power.Keeper
	requestFSResync func()
	watchStatus     func() filewatch.Status
	close           func()
}

// buildRuntime wires the shared sandbox runtime (process manager, dispatcher, ws
// server, displays) and starts the file/port watchers and the display provider
// connection. close stops them.
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
) sandboxRuntime {
	processManager := process.NewManager(logger)
	searchManager := search.NewManager(cfg, logger)
	searchManager.Start()
	dispatcher := rpc.NewDispatcher(cfg, processManager, logger)
	keeper := power.NewKeeper(logger)
	dispatcher.SetActivity(keeper.Touch)
	dispatcher.SetSearchManager(searchManager)
	server := ws.NewServer(cfg, dispatcher, processManager, reporter, state, hostname, logger)
	server.SetSearchEnabled(searchManager.Enabled())

	displaySpec := os.Getenv("COHUB_DISPLAY")
	_ = os.Unsetenv("COHUB_DISPLAY")
	dial, err := display.DialerFor(displaySpec, logger)
	if err != nil {
		logger.Warn("display provider disabled", slog.String("error", err.Error()))
	}
	displays := display.NewHub(dial, logger)
	viewers := rtc.NewManager(displays, logger)
	var virtual *display.Virtual
	if dial == nil {
		virtual = display.NewVirtual(displays, logger)
	} else {
		logger.Info("display provider enabled", slog.String("display", displaySpec))
	}
	dispatcher.SetDisplays(displays, viewers, virtual)
	currentDisplay := &atomic.Pointer[string]{}
	currentDisplay.Store(&displaySpec)
	setDisplay := func(spec string) error {
		next, err := display.DialerFor(spec, logger)
		if err != nil {
			return err
		}
		displays.SetDialer(next)
		currentDisplay.Store(&spec)
		return nil
	}
	displayCtx, stopDisplays := context.WithCancel(context.Background())
	go displays.Run(displayCtx)

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

	closers = append(closers, searchManager.Close, keeper.Close, func() {
		viewers.CloseAll(rtc.ReasonShutdown)
		stopDisplays()
		if virtual != nil {
			virtual.Stop()
		}
	})
	return sandboxRuntime{
		dispatcher:      dispatcher,
		processes:       processManager,
		server:          server,
		search:          searchManager,
		displays:        displays,
		displaySpec:     currentDisplay,
		setDisplay:      setDisplay,
		keeper:          keeper,
		requestFSResync: requestFSResync,
		watchStatus:     watchStatus,
		close: func() {
			for _, close := range closers {
				close()
			}
		},
	}
}

func runCloud(logger *slog.Logger, cfg env.Config) {
	state := &prepareState{status: "preparing", setup: &protocol.SandboxSetupInfo{Status: "waiting"}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	startedAt := time.Now().UTC().Format(time.RFC3339)
	hostname, _ := os.Hostname()
	reporter := report.NewClient(cfg, hostname)

	sandbox := buildRuntime(logger, cfg, state, reporter, hostname, nil, nil)
	defer sandbox.close()
	server, searchManager := sandbox.server, sandbox.search
	server.SetFSResyncOnAttach(true)

	initialMeta := map[string]interface{}{
		"workspaceDir": cfg.WorkspaceDir,
		"hostname":     hostname,
		"imageVersion": cfg.ImageVersion,
		"startedAt":    startedAt,
		"podIp":        cfg.PodIP,
		"wsEndpoint":   sandboxWSEndpoint(cfg.PodIP),
	}
	payload := func() report.Payload {
		status, lastError := state.Get()
		meta := make(map[string]interface{}, len(initialMeta)+2)
		for key, value := range initialMeta {
			meta[key] = value
		}
		meta["setup"], meta["lastError"] = state.GetSetup(), lastError
		return report.Payload{Status: status, Meta: meta}
	}
	go func() {
		err := reporter.WaitForBootstrap(ctx, payload, func(status string, err error) {
			setup := &protocol.SandboxSetupInfo{Status: "waiting"}
			if status == "failed" {
				setup.Error = "Workspace bootstrap failed; setup has not run"
			}
			state.SetSetup(setup)
			if err != nil {
				logger.Warn("waiting for workspace bootstrap", slog.String("error", err.Error()))
			}
		})
		if err != nil {
			return
		}
		runner := workspace.NewSetupRunner(cfg, sandbox.processes, logger, func(setup *protocol.SandboxSetupInfo) {
			state.SetSetup(setup)
			if setup.Status == "running" {
				if _, err := reporter.ReportWithBootstrap(ctx, payload()); err != nil {
					logger.Warn("failed to report setup progress", slog.String("error", err.Error()))
				}
			}
		})
		runner.Run(ctx)
		searchManager.Activate()
		for ctx.Err() == nil {
			if _, err := reporter.ReportWithBootstrap(ctx, payload()); err == nil {
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
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
type displayFrame struct {
	Type  string   `json:"type"`
	Spec  string   `json:"spec"`
	Needs []string `json:"needs"`
	Error string   `json:"error,omitempty"`
}

func displayNeeds(displays []display.Info) []string {
	needs := []string{}
	for _, info := range displays {
		for _, need := range info.Needs {
			if !slices.Contains(needs, need) {
				needs = append(needs, need)
			}
		}
	}
	return needs
}

func runLocal(logger *slog.Logger, spaceID, root, relayURL string) {
	relayToken := strings.TrimSpace(os.Getenv("COHUB_RELAY_TOKEN"))
	localToken := strings.TrimSpace(os.Getenv("COHUB_LOCAL_TOKEN"))
	// Remove the tokens from the environment immediately so they can never be
	// inherited by agent-started processes via os.Environ().
	_ = os.Unsetenv("COHUB_RELAY_TOKEN")
	_ = os.Unsetenv("COHUB_LOCAL_TOKEN")
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
		control, err := openRuntimeControl()
		if err != nil {
			logger.Error("failed to open runtime control channel", slog.String("error", err.Error()))
			os.Exit(1)
		}
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

	sandbox := buildRuntime(logger, cfg, state, nil, hostname, fsSink, portsSink)
	defer sandbox.close()
	requestFSResync = sandbox.requestFSResync
	client.SetServer(sandbox.server)
	client.SetWatcherStatus(sandbox.watchStatus)
	displayStatus := func() interface{} { return displaysPayload{Displays: sandbox.displays.Displays()} }
	client.SetStatus("displays", displayStatus)
	// Changes coalesce: a slow relay never stalls the hub, and the latest snapshot wins.
	var publishDisplay func(failure error)
	if managed != nil {
		publishDisplay = func(failure error) {
			frame := displayFrame{Type: "display", Spec: *sandbox.displaySpec.Load(), Needs: displayNeeds(sandbox.displays.Displays())}
			if failure != nil {
				frame.Error = failure.Error()
			}
			managed.Send(frame)
		}
		managed.Offer(map[string]func(json.RawMessage){
			"display": func(raw json.RawMessage) {
				var request struct {
					Spec string `json:"spec"`
				}
				err := json.Unmarshal(raw, &request)
				if err == nil {
					err = sandbox.setDisplay(request.Spec)
				}
				publishDisplay(err)
			},
			"keepAwake": func(raw json.RawMessage) {
				var request struct {
					Enabled bool `json:"enabled"`
				}
				if json.Unmarshal(raw, &request) == nil {
					sandbox.keeper.SetEnabled(request.Enabled)
				}
			},
			"activity": func(json.RawMessage) { sandbox.keeper.Touch() },
		})
		go func() {
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					if sandbox.processes.Stats().ActiveProcesses > 0 {
						sandbox.keeper.Touch()
					}
				}
			}
		}()
	}
	if managed != nil && localToken != "" {
		if api, err := local.Listen(localToken, sandbox.dispatcher, logger); err != nil {
			logger.Warn("local API disabled", slog.String("error", err.Error()))
		} else {
			defer api.Close()
			managed.Send(struct {
				Type string `json:"type"`
				Port int    `json:"port"`
			}{"local", api.Port()})
		}
	}
	displaysChanged := make(chan struct{}, 1)
	sandbox.displays.OnChange(func([]display.Info) {
		select {
		case displaysChanged <- struct{}{}:
		default:
		}
	})
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-displaysChanged:
				client.PublishEvent("displays", displayStatus())
				if publishDisplay != nil {
					publishDisplay(nil)
				}
			}
		}
	}()

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
