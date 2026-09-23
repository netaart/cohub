package protocol

import "encoding/json"

const Version = "1"

type BaseMessage struct {
	Version   string `json:"version"`
	Type      string `json:"type"`
	SpaceID   string `json:"spaceId"`
	SandboxID string `json:"sandboxId"`
	Timestamp int64  `json:"timestamp"`
}

type RequestScopedMessage struct {
	BaseMessage
	RequestID  string  `json:"requestId"`
	SessionID  *string `json:"sessionId,omitempty"`
	ToolCallID *string `json:"toolCallId,omitempty"`
}

type OperationScopedMessage struct {
	BaseMessage
	OpID       string  `json:"opId"`
	RequestID  string  `json:"requestId"`
	Seq        int64   `json:"seq"`
	SessionID  *string `json:"sessionId,omitempty"`
	ToolCallID *string `json:"toolCallId,omitempty"`
}

type SandboxFilesystemRoot struct {
	Path     string `json:"path"`
	Writable bool   `json:"writable"`
	Label    string `json:"label,omitempty"`
}

type SandboxFilesystem struct {
	Roots      []SandboxFilesystemRoot `json:"roots"`
	DefaultCwd string                  `json:"defaultCwd"`
	Mode       string                  `json:"mode,omitempty"`
	Notes      []string                `json:"notes,omitempty"`
}

type SandboxCapabilities struct {
	FSRead             bool `json:"fsRead"`
	FSWrite            bool `json:"fsWrite"`
	FSWriteDisposition bool `json:"fsWriteDisposition,omitempty"`
	FSWriteExpected    bool `json:"fsWriteExpected,omitempty"`
	FSWriteSource      bool `json:"fsWriteSource,omitempty"`
	FSEdit             bool `json:"fsEdit,omitempty"`
	FSMkdir            bool `json:"fsMkdir,omitempty"`
	FSStat             bool `json:"fsStat"`
	FSLs               bool `json:"fsLs"`
	FSTree             bool `json:"fsTree,omitempty"`
	FSFind             bool `json:"fsFind"`
	FSGrep             bool `json:"fsGrep"`
	FSSearch           bool `json:"fsSearch,omitempty"`
	FSPathSearch       bool `json:"fsPathSearch,omitempty"`
	ProcessStart       bool `json:"processStart"`
	ProcessStartArgv   bool `json:"processStartArgv,omitempty"`
	ProcessAbort       bool `json:"processAbort"`
}

type SandboxProcessStats struct {
	ActiveProcesses        int   `json:"activeProcesses,omitempty"`
	StartedTotal           int64 `json:"startedTotal,omitempty"`
	CompletedTotal         int64 `json:"completedTotal,omitempty"`
	AbortedTotal           int64 `json:"abortedTotal,omitempty"`
	TimedOutTotal          int64 `json:"timedOutTotal,omitempty"`
	IdentityCleanupTotal   int64 `json:"identityCleanupTotal,omitempty"`
	ForceKilledTotal       int64 `json:"forceKilledTotal,omitempty"`
	TerminateFailuresTotal int64 `json:"terminateFailuresTotal,omitempty"`
}

type SandboxHealthStats struct {
	ZombieProcessCount int `json:"zombieProcessCount,omitempty"`
	AttachedSessions   int `json:"attachedSessions,omitempty"`
}

type SandboxSetupInfo struct {
	Ran      bool   `json:"ran"`
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	Duration string `json:"duration"`
	Error    string `json:"error,omitempty"`
}

type SandboxMetadata struct {
	Hostname     string               `json:"hostname,omitempty"`
	ImageVersion string               `json:"imageVersion,omitempty"`
	StartedAt    string               `json:"startedAt,omitempty"`
	Process      *SandboxProcessStats `json:"process,omitempty"`
	Health       *SandboxHealthStats  `json:"health,omitempty"`
	Setup        *SandboxSetupInfo    `json:"setup,omitempty"`
}

type SandboxHeartbeat struct {
	BaseMessage
	Status       string              `json:"status"`
	Capabilities SandboxCapabilities `json:"capabilities,omitempty"`
	Filesystem   *SandboxFilesystem  `json:"filesystem,omitempty"`
	Metadata     *SandboxMetadata    `json:"metadata,omitempty"`
}

type SessionAttach struct {
	BaseMessage
	RequestID string `json:"requestId"`
	Identity  string `json:"identity"`
}

type SessionAttachOK struct {
	BaseMessage
	RequestID    string `json:"requestId"`
	ConnectionID string `json:"connectionId"`
	Identity     string `json:"identity"`
}

type RPCRequest struct {
	RequestScopedMessage
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type RPCAccepted struct {
	RequestScopedMessage
	OpID string `json:"opId"`
}

type RPCCompleted struct {
	OperationScopedMessage
	Result interface{} `json:"result"`
}

type RPCErrorPayload struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type RPCFailed struct {
	OperationScopedMessage
	Error RPCErrorPayload `json:"error"`
}

type ProcessTermination struct {
	Reason          string `json:"reason"`
	ExitCode        *int   `json:"exitCode"`
	TimeoutSecs     int    `json:"timeoutSecs,omitempty"`
	Message         string `json:"message,omitempty"`
	OutputTruncated bool   `json:"outputTruncated,omitempty"`
}

type RPCEventPayload struct {
	Type        string              `json:"type"`
	ProcessID   string              `json:"processId,omitempty"`
	Chunk       string              `json:"chunk,omitempty"`
	ExitCode    *int                `json:"exitCode,omitempty"`
	Termination *ProcessTermination `json:"termination,omitempty"`
}

type RPCEvent struct {
	OperationScopedMessage
	Event RPCEventPayload `json:"event"`
}

type FSChange struct {
	Path     string `json:"path,omitempty"`
	OldPath  string `json:"oldPath,omitempty"`
	Kind     string `json:"kind"`
	NodeType string `json:"nodeType,omitempty"`
	MtimeMs  int64  `json:"mtimeMs,omitempty"`
	Size     int64  `json:"size,omitempty"`
}

type FSChangedPayload struct {
	Seq     int64      `json:"seq"`
	Resync  bool       `json:"resync,omitempty"`
	Changes []FSChange `json:"changes"`
}

type FSSearchParams struct {
	Literals []string `json:"literals"`
	Path     string   `json:"path,omitempty"`
	CWD      string   `json:"cwd,omitempty"`
	Glob     string   `json:"glob,omitempty"`
	Limit    int      `json:"limit,omitempty"`
}

type FSSearchResult struct {
	Path          string   `json:"path"`
	Matches       []string `json:"matches"`
	IndexFamily   string   `json:"indexFamily"`
	SchemaVersion int      `json:"schemaVersion"`
	Coverage      string   `json:"coverage"`
	Truncated     bool     `json:"truncated,omitempty"`
	State         string   `json:"state,omitempty"`
}

type FSPathSearchParams struct {
	Pattern  string   `json:"pattern"`
	Path     string   `json:"path,omitempty"`
	CWD      string   `json:"cwd,omitempty"`
	Limit    int      `json:"limit,omitempty"`
	FullPath bool     `json:"fullPath,omitempty"`
	Ignore   []string `json:"ignore,omitempty"`
}

type FSPathSearchResult struct {
	Path          string   `json:"path"`
	Matches       []string `json:"matches"`
	IndexFamily   string   `json:"indexFamily"`
	SchemaVersion int      `json:"schemaVersion"`
	Coverage      string   `json:"coverage"`
	Truncated     bool     `json:"truncated,omitempty"`
	State         string   `json:"state,omitempty"`
}

type FSChanged struct {
	BaseMessage
	Payload FSChangedPayload `json:"payload"`
}

type PortStatus string

const (
	PortStatusListening PortStatus = "listening"
	PortStatusClosed    PortStatus = "closed"
)

type PortChange struct {
	Port       int        `json:"port"`
	Protocol   string     `json:"protocol"`
	Status     PortStatus `json:"status"`
	ObservedAt int64      `json:"observedAt"`
}

type PortsChangedPayload struct {
	Seq    int64        `json:"seq"`
	Resync bool         `json:"resync,omitempty"`
	Ports  []PortChange `json:"ports"`
}

type PortsChanged struct {
	BaseMessage
	Payload PortsChangedPayload `json:"payload"`
}

type IncomingEnvelope struct {
	Type string `json:"type"`
}
