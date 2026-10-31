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
	mu       sync.Mutex
	token    string
	output   io.Writer
	handlers map[string]func(json.RawMessage)
}

func NewManagedControl(token string, input io.Reader, output io.Writer, onClose func()) *ManagedControl {
	c := &ManagedControl{token: token, output: output, handlers: map[string]func(json.RawMessage){}}
	c.Notify("hello")
	go func() {
		defer onClose()
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 4096), 64*1024)
		for scanner.Scan() {
			c.receive(scanner.Bytes())
		}
	}()
	return c
}

func (c *ManagedControl) receive(line []byte) {
	var frame struct {
		Type  string `json:"type"`
		Token string `json:"token"`
	}
	if json.Unmarshal(line, &frame) != nil {
		return
	}
	c.mu.Lock()
	if frame.Type == "auth" && frame.Token != "" {
		c.token = frame.Token
	}
	handler := c.handlers[frame.Type]
	c.mu.Unlock()
	if handler != nil {
		handler(json.RawMessage(line))
	}
}

func (c *ManagedControl) Token() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.token
}

func (c *ManagedControl) Offer(handlers map[string]func(json.RawMessage)) {
	features := make([]string, 0, len(handlers))
	c.mu.Lock()
	for name, handler := range handlers {
		c.handlers[name] = handler
		features = append(features, name)
	}
	c.mu.Unlock()
	c.Send(struct {
		Type     string   `json:"type"`
		Features []string `json:"features"`
	}{"features", features})
}

func (c *ManagedControl) Notify(state string) {
	c.Send(struct {
		Type string `json:"type"`
	}{state})
}

func (c *ManagedControl) Send(frame any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = json.NewEncoder(c.output).Encode(frame)
}
