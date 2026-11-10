package report

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/cohub/apps/sandbox/env"
)

// ErrBootstrapFailed means bootstrap reached its terminal failed state.
var ErrBootstrapFailed = errors.New("workspace bootstrap failed")

type Client struct {
	cfg        env.Config
	hostname   string
	httpClient *http.Client
}

type Payload struct {
	Status string                 `json:"status"`
	Meta   map[string]interface{} `json:"meta,omitempty"`
}

type Response struct {
	Bootstrap *BootstrapGate `json:"bootstrap,omitempty"`
}

type BootstrapGate struct {
	Status string `json:"status"`
}

func NewClient(cfg env.Config, hostname string) *Client {
	return &Client{cfg: cfg, hostname: hostname, httpClient: &http.Client{Timeout: 5 * time.Second}}
}

func (c *Client) Report(payload Payload) error {
	_, err := c.ReportWithBootstrap(context.Background(), payload)
	return err
}

func (c *Client) ReportWithBootstrap(parent context.Context, payload Payload) (Response, error) {
	if c.cfg.IsLocal() {
		return Response{}, fmt.Errorf("setup coordination is disabled for local sandboxes")
	}
	baseURL := strings.TrimRight(c.cfg.InternalAPIBaseURL, "/")
	if baseURL == "" {
		return Response{}, fmt.Errorf("INTERNAL_API_BASE_URL is required")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return Response{}, err
	}
	url := fmt.Sprintf("%s/internal/spaces/%s/sandbox-report", baseURL, c.cfg.SpaceID)
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		response, status, err := c.reportOnce(ctx, url, body)
		if err == nil {
			return response, nil
		}
		lastErr = err
		if status != 0 && status != http.StatusForbidden && status != http.StatusConflict && status != http.StatusTooManyRequests && status < 500 {
			return Response{}, err
		}
		if attempt < 2 {
			if err := wait(ctx, time.Duration(250*(1<<attempt))*time.Millisecond); err != nil {
				return Response{}, err
			}
		}
	}
	return Response{}, fmt.Errorf("sandbox report failed after 3 attempts: %w", lastErr)
}

func (c *Client) reportOnce(ctx context.Context, url string, body []byte) (Response, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return Response{}, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(c.cfg.SandboxReportToken) != "" {
		req.Header.Set("x-sandbox-report-token", c.cfg.SandboxReportToken)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return Response{}, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 16*1024))
		return Response{}, resp.StatusCode, fmt.Errorf("sandbox report failed with status %d", resp.StatusCode)
	}
	var response Response
	err = json.NewDecoder(io.LimitReader(resp.Body, 16*1024)).Decode(&response)
	if errors.Is(err, io.EOF) {
		err = nil
	}
	return response, resp.StatusCode, err
}

func (c *Client) WaitForBootstrap(ctx context.Context, payload func() Payload, onWait func(string, error)) error {
	if c.cfg.IsLocal() {
		return fmt.Errorf("setup is disabled for local sandboxes")
	}
	for {
		response, err := c.ReportWithBootstrap(ctx, payload())
		status := "waiting"
		if err == nil && response.Bootstrap != nil {
			status = response.Bootstrap.Status
			switch status {
			case "ready":
				return nil
			case "failed":
				return ErrBootstrapFailed
			}
		}
		onWait(status, err)
		if err := wait(ctx, 5*time.Second); err != nil {
			return err
		}
	}
}

func wait(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
