package report

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/cohub/apps/sandbox/env"
)

type Client struct {
	cfg        env.Config
	hostname   string
	httpClient *http.Client
}

type Payload struct {
	Status string                 `json:"status"`
	Meta   map[string]interface{} `json:"meta,omitempty"`
}

func NewClient(cfg env.Config, hostname string) *Client {
	return &Client{
		cfg:      cfg,
		hostname: hostname,
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

func (c *Client) Report(payload Payload) error {
	baseURL := strings.TrimRight(c.cfg.InternalAPIBaseURL, "/")
	if baseURL == "" {
		return fmt.Errorf("INTERNAL_API_BASE_URL is required")
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	url := fmt.Sprintf("%s/internal/spaces/%s/sandbox-report", baseURL, c.cfg.SpaceID)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		status, err := c.reportOnce(ctx, url, body)
		if err == nil {
			return nil
		}
		lastErr = err
		// A new Pod can report before its credentials are committed; retry that 403 briefly too.
		if status != 0 && status != http.StatusForbidden && status != http.StatusConflict && status != http.StatusTooManyRequests && status < 500 {
			return err
		}
		if attempt < 2 {
			timer := time.NewTimer(time.Duration(250*(1<<attempt)) * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return fmt.Errorf("sandbox report retry deadline: %w", ctx.Err())
			case <-timer.C:
			}
		}
	}
	return fmt.Errorf("sandbox report failed after 3 attempts: %w", lastErr)
}

func (c *Client) reportOnce(ctx context.Context, url string, body []byte) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(c.cfg.SandboxReportToken) != "" {
		req.Header.Set("x-sandbox-report-token", c.cfg.SandboxReportToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, fmt.Errorf("sandbox report failed with status %d", resp.StatusCode)
	}
	return resp.StatusCode, nil
}
