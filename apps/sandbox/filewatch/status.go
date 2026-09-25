package filewatch

// Status describes monitoring only; file RPC availability is independent.
// Reasons are fixed codes so reports never expose local paths or filenames.
type Status struct {
	Backend string `json:"backend"`
	State   string `json:"state"`
	Reason  string `json:"reason,omitempty"`
}

func (w *Watcher) Status() Status {
	w.mu.Lock()
	defer w.mu.Unlock()
	backend := "fsnotify"
	if w.backend != nil {
		backend = w.backend.name()
	}
	state, reason := "running", ""
	if backend == "scan" {
		state, reason = "degraded", "polling"
	}
	if w.failure != "" {
		state, reason = "degraded", w.failure
	}
	if w.unavailable {
		state, reason = "unavailable", w.failure
		if reason == "" {
			reason = "watch_error"
		}
	}
	return Status{Backend: backend, State: state, Reason: reason}
}

// HasPending reports whether a change the watcher knows about has not been
// handed to consumers yet: queued events, a batch still in the handler, or a
// registration walk that has not queued what it found.
func (w *Watcher) HasPending() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.pending) > 0 || w.resync || w.flushing > 0 || w.discovering > 0
}

func (w *Watcher) markFailure(reason string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.unavailable {
		return
	}
	w.failure = reason
}

func (w *Watcher) markHealthy() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.unavailable && w.failure == "watch_error" {
		w.failure = ""
	}
}

func (w *Watcher) markUnavailable(reason string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.failure = reason
	w.unavailable = true
}

func (w *Watcher) failureReason() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.failure
}

func (w *Watcher) markCoverageHealthy() {
	w.mu.Lock()
	defer w.mu.Unlock()
	// A root replacement leaves fsnotify's old watch descriptor attached to
	// the old inode. Never clear root_changed based on the path alone.
	if !w.unavailable && w.failure != "root_changed" {
		w.failure = ""
	}
}
