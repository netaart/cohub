//go:build darwin

package display

import (
	"fmt"
	"path/filepath"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	cfStringUTF8   = 0x08000100
	cfNumberSInt32 = 3
	cfNumberSInt64 = 4
	cfNumberDouble = 13
)

var cf struct {
	retain          func(uintptr) uintptr
	release         func(uintptr)
	typeID          func(uintptr) uintptr
	stringTypeID    func() uintptr
	booleanTypeID   func() uintptr
	numberTypeID    func() uintptr
	arrayTypeID     func() uintptr
	stringCreate    func(alloc uintptr, text string, encoding uint32) uintptr
	stringLength    func(uintptr) int
	stringMaxSize   func(length int, encoding uint32) int
	stringGetCStr   func(str uintptr, buf *byte, size int, encoding uint32) bool
	numberCreate    func(alloc uintptr, kind int, value unsafe.Pointer) uintptr
	numberGetValue  func(number uintptr, kind int, value unsafe.Pointer) bool
	booleanGetValue func(uintptr) bool
	arrayCount      func(uintptr) int
	arrayAt         func(array uintptr, index int) uintptr
	arrayCreate     func(alloc uintptr, values *uintptr, count int, callbacks uintptr) uintptr
	dictionaryGet   func(dict, key uintptr) uintptr
	dictionaryNew   func(alloc uintptr, keys, values *uintptr, count int, keyCallbacks, valueCallbacks uintptr) uintptr

	lib                                    uintptr
	yes, no                                uintptr
	arrayCallbacks                         uintptr
	dictionaryKeyCalls, dictionaryValCalls uintptr
}

var (
	cfOnce sync.Once
	cfErr  error
)

func openFramework(path string) (uintptr, error) {
	lib, err := purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return 0, fmt.Errorf("load %s: %w", filepath.Base(path), err)
	}
	return lib, nil
}

func symbolAddress(lib uintptr, name string) uintptr {
	address, err := purego.Dlsym(lib, name)
	if err != nil {
		return 0
	}
	return address
}

func global(lib uintptr, name string) uintptr {
	address := symbolAddress(lib, name)
	if address == 0 {
		return 0
	}
	return **(**uintptr)(unsafe.Pointer(&address))
}

func loadCF() error {
	cfOnce.Do(func() {
		lib, err := openFramework("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
		if err != nil {
			cfErr = err
			return
		}
		cf.lib = lib
		for name, fn := range map[string]any{
			"CFRetain": &cf.retain, "CFRelease": &cf.release, "CFGetTypeID": &cf.typeID,
			"CFStringGetTypeID": &cf.stringTypeID, "CFBooleanGetTypeID": &cf.booleanTypeID,
			"CFNumberGetTypeID": &cf.numberTypeID, "CFArrayGetTypeID": &cf.arrayTypeID,
			"CFStringCreateWithCString": &cf.stringCreate, "CFStringGetLength": &cf.stringLength,
			"CFStringGetMaximumSizeForEncoding": &cf.stringMaxSize, "CFStringGetCString": &cf.stringGetCStr,
			"CFNumberCreate": &cf.numberCreate, "CFNumberGetValue": &cf.numberGetValue,
			"CFBooleanGetValue": &cf.booleanGetValue, "CFArrayGetCount": &cf.arrayCount,
			"CFArrayGetValueAtIndex": &cf.arrayAt, "CFArrayCreate": &cf.arrayCreate,
			"CFDictionaryGetValue": &cf.dictionaryGet, "CFDictionaryCreate": &cf.dictionaryNew,
		} {
			purego.RegisterLibFunc(fn, lib, name)
		}
		cf.yes, cf.no = global(lib, "kCFBooleanTrue"), global(lib, "kCFBooleanFalse")
		cf.arrayCallbacks = symbolAddress(lib, "kCFTypeArrayCallBacks")
		cf.dictionaryKeyCalls = symbolAddress(lib, "kCFTypeDictionaryKeyCallBacks")
		cf.dictionaryValCalls = symbolAddress(lib, "kCFTypeDictionaryValueCallBacks")
	})
	return cfErr
}

func cfString(text string) uintptr {
	return cf.stringCreate(0, text, cfStringUTF8)
}

func goString(ref uintptr) string {
	if ref == 0 || cf.typeID(ref) != cf.stringTypeID() {
		return ""
	}
	size := cf.stringMaxSize(cf.stringLength(ref), cfStringUTF8) + 1
	buf := make([]byte, size)
	if !cf.stringGetCStr(ref, &buf[0], size, cfStringUTF8) {
		return ""
	}
	for i, b := range buf {
		if b == 0 {
			return string(buf[:i])
		}
	}
	return string(buf)
}

func cfInt32(value int32) uintptr {
	return cf.numberCreate(0, cfNumberSInt32, unsafe.Pointer(&value))
}

func cfFloat64(value float64) uintptr {
	return cf.numberCreate(0, cfNumberDouble, unsafe.Pointer(&value))
}

func cfInt(ref uintptr) (int64, bool) {
	switch {
	case ref == 0:
		return 0, false
	case cf.typeID(ref) == cf.numberTypeID():
		var value int64
		return value, cf.numberGetValue(ref, cfNumberSInt64, unsafe.Pointer(&value))
	case cf.typeID(ref) == cf.booleanTypeID():
		if cf.booleanGetValue(ref) {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

func cfDictionary(pairs ...uintptr) uintptr {
	keys := make([]uintptr, 0, len(pairs)/2)
	values := make([]uintptr, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		if pairs[i] == 0 || pairs[i+1] == 0 {
			continue
		}
		keys, values = append(keys, pairs[i]), append(values, pairs[i+1])
	}
	if len(keys) == 0 {
		return 0
	}
	return cf.dictionaryNew(0, &keys[0], &values[0], len(keys), cf.dictionaryKeyCalls, cf.dictionaryValCalls)
}

func cfArray(values []uintptr) uintptr {
	if len(values) == 0 {
		return cf.arrayCreate(0, nil, 0, cf.arrayCallbacks)
	}
	return cf.arrayCreate(0, &values[0], len(values), cf.arrayCallbacks)
}
