package power

import (
	"log/slog"
	"sync"
	"time"
)

const Linger = 5 * time.Minute

type Assert func() (release func(), err error)

type Keeper struct {
	assert Assert
	logger *slog.Logger

	mu      sync.Mutex
	enabled bool
	timer   *time.Timer
	release func()
}

func NewKeeper(logger *slog.Logger) *Keeper {
	return &Keeper{assert: platformAssert, logger: logger}
}

func (k *Keeper) SetEnabled(enabled bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.enabled = enabled
	if !enabled {
		k.releaseLocked()
	}
}

func (k *Keeper) Touch() {
	k.mu.Lock()
	defer k.mu.Unlock()
	if !k.enabled {
		return
	}
	if k.release == nil {
		release, err := k.assert()
		if err != nil {
			k.logger.Warn("could not keep the machine awake", slog.String("error", err.Error()))
			return
		}
		k.release = release
	}
	if k.timer == nil {
		k.timer = time.AfterFunc(Linger, k.expire)
	} else {
		k.timer.Reset(Linger)
	}
}

func (k *Keeper) expire() {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.releaseLocked()
}

func (k *Keeper) Close() {
	k.SetEnabled(false)
}

func (k *Keeper) releaseLocked() {
	if k.timer != nil {
		k.timer.Stop()
		k.timer = nil
	}
	if k.release != nil {
		k.release()
		k.release = nil
	}
}
