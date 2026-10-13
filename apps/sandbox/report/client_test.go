package report

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/cohub/apps/sandbox/env"
)

type retryTransport struct {
	attempts int
}

func (r *retryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r.attempts++
	if r.attempts == 1 {
		return nil, errors.New("temporary connection failure")
	}
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(http.NoBody), Header: make(http.Header), Request: req}, nil
}

func TestReportRetriesTransientFailures(t *testing.T) {
	for _, status := range []int{403, 409, 429, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("x-sandbox-report-token") != "test-report-token" {
					t.Error("retry dropped report authentication")
				}
				var body Payload
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Status != "ready" {
					t.Error("retry lost its payload")
				}
				if calls.Add(1) < 3 {
					w.WriteHeader(status)
					return
				}
				w.WriteHeader(http.StatusOK)
			}))
			defer server.Close()
			client := NewClient(env.Config{SpaceID: "test-space", InternalAPIBaseURL: server.URL, SandboxReportToken: "test-report-token"}, "test")
			if err := client.Report(Payload{Status: "ready"}); err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 3 {
				t.Fatal("expected three report attempts")
			}
		})
	}
	transport := &retryTransport{}
	client := NewClient(env.Config{SpaceID: "test-space", InternalAPIBaseURL: "http://test.invalid"}, "test")
	client.httpClient.Transport = transport
	if err := client.Report(Payload{Status: "ready"}); err != nil || transport.attempts != 2 {
		t.Fatalf("transport retry failed: %v", err)
	}
}

func TestReportRetriesAreBounded(t *testing.T) {
	for _, status := range []int{400, 401, 403, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(status)
			}))
			defer server.Close()
			client := NewClient(env.Config{SpaceID: "test-space", InternalAPIBaseURL: server.URL}, "test")
			if err := client.Report(Payload{Status: "ready"}); err == nil {
				t.Fatal("failed report was accepted")
			}
			want := int32(1)
			if status == 403 || status == 503 {
				want = 3
			}
			if calls.Load() != want {
				t.Fatalf("attempts = %d, want %d", calls.Load(), want)
			}
		})
	}
}
