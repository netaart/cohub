package relay

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
)

// ManagedControl is the private inherited pipe to the Runtime supervisor.
// Credentials never appear in diagnostics or the filesystem. Older standalone
// callers continue to use Options.Token without this control surface.
type ManagedControl struct {
	mu     sync.Mutex
	token  string
	output io.Writer
}

func NewManagedControl(token string, input io.Reader, output io.Writer, onClose func()) *ManagedControl {
	c := &ManagedControl{token: token, output: output}
	c.Notify("hello")
	go func() {
		defer onClose()
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 4096), 64*1024)
		for scanner.Scan() {
			var frame struct {
				Type  string `json:"type"`
				Token string `json:"token"`
			}
			if json.Unmarshal(scanner.Bytes(), &frame) == nil && frame.Type == "auth" && frame.Token != "" {
				c.mu.Lock()
				c.token = frame.Token
				c.mu.Unlock()
			}
		}
	}()
	return c
}

func (c *ManagedControl) Token() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.token
}

func (c *ManagedControl) Notify(state string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = json.NewEncoder(c.output).Encode(struct {
		Type string `json:"type"`
	}{state})
}
