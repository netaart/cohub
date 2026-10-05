package process

import (
	"os/exec"
	"sync"
)

var commandShell = sync.OnceValue(func() string {
	if _, err := exec.LookPath("bash"); err == nil {
		return "bash"
	}
	return "sh"
})
