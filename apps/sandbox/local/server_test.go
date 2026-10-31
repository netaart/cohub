package local

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
	"github.com/cohub/apps/sandbox/rpc"
)

const testToken = "0123456789abcdef0123456789abcdef"

type envelope struct {
	Result map[string]interface{} `json:"result"`
	Error  *struct {
		Code string `json:"code"`
	} `json:"error"`
}

func serve(t *testing.T) (string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dispatcher := rpc.NewDispatcher(env.Config{WorkspaceDir: root, Fence: true}, process.NewManager(slog.Default()), slog.Default())
	server, err := Listen(testToken, dispatcher, slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	return "http://127.0.0.1:" + strconv.Itoa(server.Port()), root
}

func call(t *testing.T, method, url string, body io.Reader, header map[string]string) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+testToken)
	for key, value := range header {
		if key == "Host" {
			request.Host = value
		} else {
			request.Header.Set(key, value)
		}
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response, data
}

func decode(t *testing.T, data []byte) envelope {
	t.Helper()
	var value envelope
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatalf("decode %s: %v", data, err)
	}
	return value
}

func TestRejectsMissingTokenAndForeignHost(t *testing.T) {
	base, _ := serve(t)
	response, err := http.Post(base+"/rpc", "application/json", strings.NewReader(`{"method":"fs.stat","params":{"path":"."}}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.StatusCode)
	}
	response, _ = call(t, http.MethodPost, base+"/rpc", strings.NewReader(`{}`), map[string]string{"Host": "attacker.example:80"})
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("rebound host status = %d, want 403", response.StatusCode)
	}
}

func TestRefusesProcessesAndViewerSessions(t *testing.T) {
	base, _ := serve(t)
	for _, method := range []string{"process.start", "process.abort", "rtc.open"} {
		response, data := call(t, http.MethodPost, base+"/rpc", strings.NewReader(`{"method":"`+method+`","params":{"command":"true"}}`), nil)
		if response.StatusCode != http.StatusUnprocessableEntity || decode(t, data).Error.Code != "UNSUPPORTED_METHOD" {
			t.Fatalf("%s: %d %s", method, response.StatusCode, data)
		}
	}
}

func TestServesFilesInert(t *testing.T) {
	base, root := serve(t)
	if err := os.WriteFile(filepath.Join(root, "page.html"), []byte("<script></script>"), 0o644); err != nil {
		t.Fatal(err)
	}
	response, _ := call(t, http.MethodGet, base+"/files?path=page.html", nil, nil)
	if response.Header.Get("Content-Security-Policy") != "sandbox" || response.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("headers = %v", response.Header)
	}
}

func TestWritesInstallAtomicallyAndHonourVersions(t *testing.T) {
	base, root := serve(t)
	_, data := call(t, http.MethodPut, base+"/files?path=docs/new.txt", strings.NewReader("first"), nil)
	result := decode(t, data).Result
	if result["created"] != true || result["bytesWritten"] != float64(5) {
		t.Fatalf("create = %s", data)
	}
	if dirs, _ := result["createdDirs"].([]interface{}); len(dirs) != 1 || dirs[0] != "docs" {
		t.Fatalf("createdDirs = %v", result["createdDirs"])
	}
	_, data = call(t, http.MethodPut, base+"/files?path=docs/new.txt&exclusive=true", strings.NewReader("again"), nil)
	if code := decode(t, data).Error.Code; code != "ALREADY_EXISTS" {
		t.Fatalf("exclusive code = %s", code)
	}
	_, data = call(t, http.MethodPut, base+"/files?path=docs/new.txt&expectedSize=1&expectedMtimeMs=1", strings.NewReader("stale"), nil)
	if code := decode(t, data).Error.Code; code != "CONFLICT" {
		t.Fatalf("stale code = %s", code)
	}
	info, err := os.Stat(filepath.Join(root, "docs", "new.txt"))
	if err != nil {
		t.Fatal(err)
	}
	version := "&expectedSize=" + strconv.FormatInt(info.Size(), 10) + "&expectedMtimeMs=" + strconv.FormatInt(info.ModTime().UnixMilli(), 10)
	_, data = call(t, http.MethodPut, base+"/files?path=docs/new.txt"+version, strings.NewReader("second"), nil)
	if result := decode(t, data).Result; result["created"] != false {
		t.Fatalf("replace = %s", data)
	}
	content, _ := os.ReadFile(filepath.Join(root, "docs", "new.txt"))
	entries, _ := os.ReadDir(filepath.Join(root, "docs"))
	if string(content) != "second" || len(entries) != 1 {
		t.Fatalf("content = %q, entries = %d (staging must not remain)", content, len(entries))
	}
}

func TestReplacingAFileKeepsItsPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no POSIX modes")
	}
	base, root := serve(t)
	script := filepath.Join(root, "run.sh")
	if err := os.WriteFile(script, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	call(t, http.MethodPut, base+"/files?path=run.sh", strings.NewReader("new"), nil)
	info, err := os.Stat(script)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("mode = %v, want 0755", info.Mode().Perm())
	}
	private := filepath.Join(root, "private")
	if err := os.Mkdir(private, 0o700); err != nil {
		t.Fatal(err)
	}
	call(t, http.MethodPut, base+"/files?path=private/new.txt", strings.NewReader("new"), nil)
	if info, err = os.Stat(filepath.Join(private, "new.txt")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("new file in a private directory: %v, %v", info, err)
	}
}
