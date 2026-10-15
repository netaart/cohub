//go:build windows

package filewatch

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// readDirectoryChangesBackend watches the whole tree through one handle on the
// root. Per-directory handles (fsnotify) keep every watched folder open, and
// Windows refuses to rename or delete a folder while a descendant is open.
type readDirectoryChangesBackend struct {
	root     string
	rootInfo windows.ByHandleFileInformation
	handle   windows.Handle
	stop     windows.Handle
	overlap  windows.Overlapped
	buffer   []byte
	eventCh  chan backendEvent
	errorCh  chan error
	done     chan struct{}
	stopped  chan struct{}
	once     sync.Once
}

const (
	readDirectoryChangesBufferSize = 64 << 10
	watchRootCheckInterval         = time.Second
	readDirectoryChangesFilter     = windows.FILE_NOTIFY_CHANGE_FILE_NAME | windows.FILE_NOTIFY_CHANGE_DIR_NAME |
		windows.FILE_NOTIFY_CHANGE_SIZE | windows.FILE_NOTIFY_CHANGE_LAST_WRITE | windows.FILE_NOTIFY_CHANGE_CREATION
)

func newReadDirectoryChangesBackend(root string, _ *slog.Logger) (eventBackend, bool, error) {
	path, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return nil, true, err
	}
	handle, err := windows.CreateFile(path, windows.FILE_LIST_DIRECTORY,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		return nil, true, fmt.Errorf("open watch root: %w", err)
	}
	b := &readDirectoryChangesBackend{
		root: root, handle: handle, buffer: make([]byte, readDirectoryChangesBufferSize),
		eventCh: make(chan backendEvent, 256), errorCh: make(chan error, 8), done: make(chan struct{}), stopped: make(chan struct{}),
	}
	if err = windows.GetFileInformationByHandle(handle, &b.rootInfo); err == nil {
		if b.overlap.HEvent, err = windows.CreateEvent(nil, 1, 0, nil); err == nil {
			if b.stop, err = windows.CreateEvent(nil, 1, 0, nil); err == nil {
				// Arm the watch before returning so the caller's initial resync covers everything before it.
				if err = b.read(); err == nil {
					go b.run()
					return b, true, nil
				}
			}
		}
	}
	b.release()
	return nil, true, fmt.Errorf("watch root: %w", err)
}

func (b *readDirectoryChangesBackend) events() <-chan backendEvent { return b.eventCh }
func (b *readDirectoryChangesBackend) errors() <-chan error        { return b.errorCh }
func (b *readDirectoryChangesBackend) name() string                { return "readdcw" }

// close owns the handles: run only stops using them, so a run that already
// exited on an error never leaves close signalling a closed (reusable) handle.
func (b *readDirectoryChangesBackend) close() error {
	b.once.Do(func() {
		close(b.done)
		_ = windows.SetEvent(b.stop)
		<-b.stopped
		b.release()
	})
	return nil
}

func (b *readDirectoryChangesBackend) release() {
	for _, handle := range []windows.Handle{b.overlap.HEvent, b.stop, b.handle} {
		if handle != 0 {
			_ = windows.CloseHandle(handle)
		}
	}
}

func (b *readDirectoryChangesBackend) read() error {
	return windows.ReadDirectoryChanges(b.handle, &b.buffer[0], uint32(len(b.buffer)), true, readDirectoryChangesFilter, nil, &b.overlap, 0)
}

func (b *readDirectoryChangesBackend) run() {
	defer close(b.stopped)
	defer close(b.errorCh)
	defer close(b.eventCh)
	pending := true // armed by the constructor
	cancelRead := func() {
		// The kernel writes into buffer until a pending read is cancelled and settled.
		if pending {
			var n uint32
			_ = windows.CancelIoEx(b.handle, &b.overlap)
			_ = windows.GetOverlappedResult(b.handle, &b.overlap, &n, true)
			pending = false
		}
	}
	defer cancelRead()
	for {
		// ReadDirectoryChangesW reports descendants, not a rename of the root itself.
		which, err := windows.WaitForMultipleObjects([]windows.Handle{b.overlap.HEvent, b.stop}, false, uint32(watchRootCheckInterval/time.Millisecond))
		if err != nil {
			b.errorCh <- fmt.Errorf("wait for directory changes: %w", err)
			return
		}
		if which != windows.WAIT_OBJECT_0 && which != uint32(windows.WAIT_TIMEOUT) {
			return
		}
		if !b.sameRoot() {
			cancelRead()
			// Stay open without watching: closing the streams would replace root_changed with watch_error.
			if b.send(backendEvent{resync: true, failed: true, reason: "root_changed"}) {
				<-b.done
			}
			return
		}
		if which == uint32(windows.WAIT_TIMEOUT) {
			continue
		}
		var n uint32
		err = windows.GetOverlappedResult(b.handle, &b.overlap, &n, false)
		pending = false
		// The change buffer overflowed; only a rescan is authoritative.
		overflow := errors.Is(err, windows.ERROR_NOTIFY_ENUM_DIR) || err == nil && n == 0
		if err != nil && !overflow {
			b.errorCh <- fmt.Errorf("read directory changes: %w", err)
			return
		}
		changes := append([]byte(nil), b.buffer[:n]...)
		// Re-arm before dispatching, so changes made meanwhile queue in the kernel.
		_ = windows.ResetEvent(b.overlap.HEvent)
		rearmErr := b.read()
		pending = rearmErr == nil
		if overflow && !b.send(backendEvent{resync: true}) || !overflow && !b.dispatch(changes) {
			return
		}
		if rearmErr != nil {
			b.errorCh <- fmt.Errorf("read directory changes: %w", rearmErr)
			return
		}
	}
}

func (b *readDirectoryChangesBackend) dispatch(changes []byte) bool {
	for offset := uint32(0); offset < uint32(len(changes)); {
		info := (*windows.FileNotifyInformation)(unsafe.Pointer(&changes[offset]))
		name := windows.UTF16ToString(unsafe.Slice(&info.FileName, info.FileNameLength/2))
		if !b.send(mapReadDirectoryChange(filepath.Join(b.root, name), info.Action)) {
			return false
		}
		if info.NextEntryOffset == 0 {
			break
		}
		offset += info.NextEntryOffset
	}
	return true
}

func (b *readDirectoryChangesBackend) send(event backendEvent) bool {
	select {
	case b.eventCh <- event:
		return true
	case <-b.done:
		return false
	}
}

// A directory that arrives by move or rename brings children Windows never
// reports, so it asks for a rescan; a removed one is reported like fsnotify's.
func mapReadDirectoryChange(path string, action uint32) backendEvent {
	switch action {
	case windows.FILE_ACTION_ADDED, windows.FILE_ACTION_RENAMED_NEW_NAME:
		if info, err := os.Lstat(path); err == nil && info.IsDir() {
			return backendEvent{path: path, resync: true}
		}
		return backendEvent{path: path, kind: "create"}
	case windows.FILE_ACTION_REMOVED, windows.FILE_ACTION_RENAMED_OLD_NAME:
		return backendEvent{path: path, kind: "delete"}
	default:
		return backendEvent{path: path, kind: "modify"}
	}
}

// Check the selected path's identity, not just the old handle's current name:
// deleting and recreating a root can leave its old handle reporting the same name.
func (b *readDirectoryChangesBackend) sameRoot() bool {
	path, err := windows.UTF16PtrFromString(b.root)
	if err != nil {
		return false
	}
	handle, err := windows.CreateFile(path, 0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	return windows.GetFileInformationByHandle(handle, &info) == nil &&
		info.VolumeSerialNumber == b.rootInfo.VolumeSerialNumber &&
		info.FileIndexHigh == b.rootInfo.FileIndexHigh && info.FileIndexLow == b.rootInfo.FileIndexLow
}
