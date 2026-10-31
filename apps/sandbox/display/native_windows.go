//go:build windows

package display

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var nativeFailed atomic.Bool

func (s *windowsScreen) nativeEncoder() *videoEncoder {
	if nativeFailed.Load() {
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return nil
	}
	return &videoEncoder{
		name:   "mediafoundation",
		live:   true,
		failed: func() { nativeFailed.Store(true) },
		command: func(ctx context.Context, fps, bitrate, maxSize int) *exec.Cmd {
			return exec.CommandContext(ctx, executable, EncoderCommand,
				"-fps", strconv.Itoa(fps), "-bitrate", strconv.Itoa(bitrate), "-max-size", strconv.Itoa(maxSize))
		},
	}
}

func RunEncoder(args []string) int {
	flags := flag.NewFlagSet(EncoderCommand, flag.ContinueOnError)
	fps := flags.Int("fps", DefaultFPS, "frames per second")
	bitrate := flags.Int("bitrate", DefaultBitrate, "bits per second")
	maxSize := flags.Int("max-size", DefaultMaxSize, "longest edge in pixels")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	runtime.LockOSThread()
	if err := runNativeEncoder(os.Stdin, os.Stdout, *fps, *bitrate, *maxSize); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

const (
	stillFrameInterval = keyframeSeconds * time.Second
	lockedDesktopRetry = time.Second
	nativeStartup      = 5 * time.Second
)

func runNativeEncoder(control io.Reader, stdout io.Writer, fps, bitrate, maxSize int) error {
	_, _, _ = procSetProcessDpiAwarenessContext.Call(dpiAwarenessPerMonitorV2)
	sourceWidth, sourceHeight := systemMetric(smCXScreen), systemMetric(smCYScreen)
	if sourceWidth <= 0 || sourceHeight <= 0 {
		return errors.New("no screen to capture")
	}
	width, height := fitSize(sourceWidth, sourceHeight, maxSize)
	width, height = width&^1, height&^1

	grabber, err := newScreenGrabber(sourceWidth, sourceHeight, width, height)
	if err != nil {
		return err
	}
	defer grabber.close()
	transform, err := openH264Transform(width, height, max(MinBitrate, min(MaxBitrate, bitrate)))
	if err != nil {
		return err
	}
	defer transform.close()

	var frameRate, nextBitrate atomic.Int64
	var wantKey atomic.Bool
	frameRate.Store(int64(max(1, min(MaxFPS, fps))))
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		scanner := bufio.NewScanner(control)
		for scanner.Scan() {
			command, value, _ := strings.Cut(strings.TrimSpace(scanner.Text()), " ")
			number, _ := strconv.Atoi(value)
			switch {
			case command == "keyframe":
				wantKey.Store(true)
			case command == "bitrate" && number > 0:
				nextBitrate.Store(int64(max(MinBitrate, min(MaxBitrate, number))))
			case command == "fps" && number > 0:
				frameRate.Store(int64(max(1, min(MaxFPS, number))))
			}
		}
	}()

	out := bufio.NewWriterSize(stdout, 256<<10)
	writer := flvWriter{w: out}
	start := time.Now()
	nv12 := make([]byte, width*height*3/2)
	var previous []byte
	var sentAt time.Time
	for {
		select {
		case <-ended:
			return nil
		default:
		}
		frameStart := time.Now()
		if rate := nextBitrate.Swap(0); rate > 0 {
			transform.setBitrate(uint32(rate))
		}
		pixels, err := grabber.grab()
		if err != nil {
			if sentAt.IsZero() && time.Since(start) > nativeStartup {
				return err
			}
			time.Sleep(lockedDesktopRetry)
			continue
		}
		key := wantKey.Swap(false)
		if key || !bytes.Equal(pixels, previous) || time.Since(sentAt) >= stillFrameInterval {
			previous = append(previous[:0], pixels...)
			if key {
				transform.forceKeyFrame()
			}
			bgraToNV12(nv12, pixels, width, height)
			encoded, err := transform.encode(nv12, time.Since(start))
			if err != nil {
				return err
			}
			for _, data := range encoded {
				avcc, sps, pps, isKey := annexBFrame(data)
				if isKey && (sps == nil || pps == nil) {
					sps, pps = transform.sps, transform.pps
				}
				if len(avcc) == 0 {
					continue
				}
				if err := writer.writeFrame(uint32(time.Since(start).Milliseconds()), isKey, sps, pps, avcc); err != nil {
					return nil // sandboxd stopped reading
				}
			}
			if err := out.Flush(); err != nil {
				return nil
			}
			sentAt = time.Now()
		}
		interval := time.Second / time.Duration(frameRate.Load())
		if wait := interval - time.Since(frameStart); wait > 0 {
			time.Sleep(wait)
		}
	}
}

const (
	halftone      = 4
	cursorShowing = 1
	diNormal      = 3
)

var (
	procStretchBlt        = gdi32.NewProc("StretchBlt")
	procSetStretchBltMode = gdi32.NewProc("SetStretchBltMode")
	procGetCursorInfo     = user32.NewProc("GetCursorInfo")
	procGetIconInfo       = user32.NewProc("GetIconInfo")
	procDrawIconEx        = user32.NewProc("DrawIconEx")
)

type cursorInfo struct {
	Size   uint32
	Flags  uint32
	Cursor uintptr
	X, Y   int32
}

type iconInfo struct {
	Icon        int32
	HotspotX    uint32
	HotspotY    uint32
	MaskBitmap  uintptr
	ColorBitmap uintptr
}

type screenGrabber struct {
	screen, memory, bitmap, previous uintptr
	sourceWidth, sourceHeight        int
	width, height                    int
	pixels                           []byte
}

func newScreenGrabber(sourceWidth, sourceHeight, width, height int) (*screenGrabber, error) {
	g := &screenGrabber{sourceWidth: sourceWidth, sourceHeight: sourceHeight, width: width, height: height}
	g.screen, _, _ = procGetDC.Call(0)
	if g.screen == 0 {
		return nil, errors.New("open the screen device context")
	}
	g.memory, _, _ = procCreateCompatibleDC.Call(g.screen)
	if g.memory == 0 {
		g.close()
		return nil, errors.New("create a memory device context")
	}
	_, _, _ = procSetStretchBltMode.Call(g.memory, halftone)
	info := bitmapInfo{Width: int32(width), Height: -int32(height), Planes: 1, BitCount: 32}
	info.Size = uint32(unsafe.Offsetof(info.Colors))
	var bits unsafe.Pointer
	g.bitmap, _, _ = procCreateDIBSection.Call(g.memory, uintptr(unsafe.Pointer(&info)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if g.bitmap == 0 || bits == nil {
		g.close()
		return nil, fmt.Errorf("create a %dx%d bitmap", width, height)
	}
	g.previous, _, _ = procSelectObject.Call(g.memory, g.bitmap)
	g.pixels = unsafe.Slice((*byte)(bits), width*height*4)
	return g, nil
}

func (g *screenGrabber) grab() ([]byte, error) {
	var ok uintptr
	var err error
	if g.width == g.sourceWidth && g.height == g.sourceHeight {
		ok, _, err = procBitBlt.Call(g.memory, 0, 0, uintptr(g.width), uintptr(g.height), g.screen, 0, 0, srcCopy|captureBlt)
	} else {
		ok, _, err = procStretchBlt.Call(g.memory, 0, 0, uintptr(g.width), uintptr(g.height), g.screen, 0, 0, uintptr(g.sourceWidth), uintptr(g.sourceHeight), srcCopy|captureBlt)
	}
	if ok == 0 {
		return nil, fmt.Errorf("capture the screen: %w", err)
	}
	g.drawCursor()
	return g.pixels, nil
}

func (g *screenGrabber) drawCursor() {
	cursor := cursorInfo{Size: uint32(unsafe.Sizeof(cursorInfo{}))}
	if ok, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&cursor))); ok == 0 || cursor.Flags&cursorShowing == 0 {
		return
	}
	var icon iconInfo
	if ok, _, _ := procGetIconInfo.Call(cursor.Cursor, uintptr(unsafe.Pointer(&icon))); ok == 0 {
		return
	}
	defer procDeleteObject.Call(icon.MaskBitmap)
	if icon.ColorBitmap != 0 {
		defer procDeleteObject.Call(icon.ColorBitmap)
	}
	x := (int(cursor.X) - int(icon.HotspotX)) * g.width / g.sourceWidth
	y := (int(cursor.Y) - int(icon.HotspotY)) * g.height / g.sourceHeight
	_, _, _ = procDrawIconEx.Call(g.memory, uintptr(x), uintptr(y), cursor.Cursor, 0, 0, 0, 0, diNormal)
}

func (g *screenGrabber) close() {
	if g.previous != 0 {
		_, _, _ = procSelectObject.Call(g.memory, g.previous)
	}
	if g.bitmap != 0 {
		_, _, _ = procDeleteObject.Call(g.bitmap)
	}
	if g.memory != 0 {
		_, _, _ = procDeleteDC.Call(g.memory)
	}
	if g.screen != 0 {
		_, _, _ = procReleaseDC.Call(0, g.screen)
	}
}

type comObject struct {
	methods *[64]uintptr
}

//go:uintptrescapes
func (o *comObject) call(method int, args ...uintptr) uint32 {
	result, _, _ := syscall.SyscallN(o.methods[method], append([]uintptr{uintptr(unsafe.Pointer(o))}, args...)...)
	return uint32(result)
}

func (o *comObject) release() {
	if o != nil {
		o.call(unknownRelease)
	}
}

const (
	unknownQueryInterface = 0
	unknownRelease        = 2

	attributesGetBlobSize = 14
	attributesGetBlob     = 15
	attributesSetUINT32   = 21
	attributesSetUINT64   = 22
	attributesSetGUID     = 24

	sampleSetSampleTime          = 36
	sampleSetSampleDuration      = 38
	sampleAddBuffer              = 42
	bufferLock                   = 3
	bufferUnlock                 = 4
	bufferSetCurrentLength       = 6
	transformGetOutputStreamInfo = 7
	transformSetInputType        = 15
	transformSetOutputType       = 16
	transformGetOutputType       = 18
	transformProcessMessage      = 23
	transformProcessInput        = 24
	transformProcessOutput       = 25
	codecSetValue                = 9
)

const (
	mfVersion              = 0x00020070
	mfNotifyBeginStreaming = 0x10000000
	mfNotifyStartOfStream  = 0x10000003
	mfNeedMoreInput        = 0xC00D6D72
	progressive            = 2
	profileBaseline        = 66
	rateControlCBR         = 0
	lowLatencyGOPSeconds   = 10
	clsctxInproc           = 1
	vtUI4                  = 19
	vtBool                 = 11
)

func guid(data1 uint32, data2, data3 uint16, data4 ...byte) *windows.GUID {
	id := &windows.GUID{Data1: data1, Data2: data2, Data3: data3}
	copy(id.Data4[:], data4)
	return id
}

var (
	clsidH264Encoder = guid(0x6CA50344, 0x051A, 0x4DED, 0x97, 0x79, 0xA4, 0x33, 0x05, 0x16, 0x5E, 0x35)
	iidTransform     = guid(0xBF94C121, 0x5B05, 0x4E6F, 0x80, 0x00, 0xBA, 0x59, 0x89, 0x61, 0x41, 0x4D)
	iidCodecAPI      = guid(0x901DB4C7, 0x31CE, 0x41A2, 0x85, 0xDC, 0x8F, 0xA0, 0xBF, 0x41, 0xB8, 0xDA)

	mtMajorType      = guid(0x48EBA18E, 0xF8C9, 0x4687, 0xBF, 0x11, 0x0A, 0x74, 0xC9, 0xF9, 0x6A, 0x8F)
	mtSubtype        = guid(0xF7E34C9A, 0x42E8, 0x4714, 0xB7, 0x4B, 0xCB, 0x29, 0xD7, 0x2C, 0x35, 0xE5)
	mtAvgBitrate     = guid(0x20332624, 0xFB0D, 0x4D9E, 0xBD, 0x0D, 0xCB, 0xF6, 0x78, 0x6C, 0x10, 0x2E)
	mtInterlace      = guid(0xE2724BB8, 0xE676, 0x4806, 0xB4, 0xB2, 0xA8, 0xD6, 0xEF, 0xB4, 0x4C, 0xCD)
	mtFrameSize      = guid(0x1652C33D, 0xD6B2, 0x4012, 0xB8, 0x34, 0x72, 0x03, 0x08, 0x49, 0xA3, 0x7D)
	mtFrameRate      = guid(0xC459A2E8, 0x3D2C, 0x4E44, 0xB1, 0x32, 0xFE, 0xE5, 0x15, 0x6C, 0x7B, 0xB0)
	mtAspectRatio    = guid(0xC6376A1E, 0x8D0A, 0x4027, 0xBE, 0x45, 0x6D, 0x9A, 0x0A, 0xD3, 0x9B, 0xB6)
	mtProfile        = guid(0xAD76A80B, 0x2D5C, 0x4E0B, 0xB3, 0x75, 0x64, 0xE5, 0x20, 0x13, 0x70, 0x36)
	mtSequenceHeader = guid(0x3C036DE7, 0x3AD0, 0x4C9E, 0x92, 0x16, 0xEE, 0x6D, 0x6A, 0xC2, 0x1C, 0xB3)
	mediaTypeVideo   = guid(0x73646976, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71)
	videoFormatH264  = guid(0x34363248, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71)
	videoFormatNV12  = guid(0x3231564E, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71)
	codecMeanBitrate = guid(0xF7222374, 0x2144, 0x4815, 0xB5, 0x50, 0xA3, 0x7F, 0x8E, 0x12, 0xEE, 0x52)
	codecForceKey    = guid(0x398C1B98, 0x8353, 0x475A, 0x9E, 0xF2, 0x8F, 0x26, 0x5D, 0x26, 0x03, 0x45)
	codecLowLatency  = guid(0x9C27891A, 0xED7A, 0x40E1, 0x88, 0xE8, 0xB2, 0x27, 0x27, 0xA0, 0x24, 0xEE)
	codecGOPSize     = guid(0x95F31B26, 0x95A4, 0x41AA, 0x93, 0x03, 0x24, 0x6A, 0x7F, 0xC6, 0xEE, 0xF1)
	codecRateControl = guid(0x1C0608E9, 0x370C, 0x4710, 0x8A, 0x58, 0xCB, 0x61, 0x81, 0xC4, 0x24, 0x23)
)

var (
	mfplat                = windows.NewLazySystemDLL("mfplat.dll")
	ole32                 = windows.NewLazySystemDLL("ole32.dll")
	procMFStartup         = mfplat.NewProc("MFStartup")
	procMFShutdown        = mfplat.NewProc("MFShutdown")
	procMFCreateMediaType = mfplat.NewProc("MFCreateMediaType")
	procMFCreateSample    = mfplat.NewProc("MFCreateSample")
	procMFCreateMemoryBuf = mfplat.NewProc("MFCreateMemoryBuffer")
	procCoInitializeEx    = ole32.NewProc("CoInitializeEx")
	procCoCreateInstance  = ole32.NewProc("CoCreateInstance")
	procCoUninitialize    = ole32.NewProc("CoUninitialize")
)

type variant struct {
	Type uint16
	_    [6]byte
	Low  uint32
	_    [12]byte
}

type outputStreamInfo struct {
	Flags, Size, Alignment uint32
}

type outputDataBuffer struct {
	StreamID uint32
	Sample   *comObject
	Status   uint32
	Events   uintptr
}

type h264Transform struct {
	transform, codec, output, outputBuffer *comObject
	sps, pps                               []byte
	frameTime                              time.Duration
}

func hresult(what string, code uint32) error {
	if int32(code) >= 0 {
		return nil
	}
	return fmt.Errorf("%s: 0x%08X", what, code)
}

func openH264Transform(width, height, bitrate int) (t *h264Transform, err error) {
	if err := procMFStartup.Find(); err != nil {
		return nil, err
	}
	if code, _, _ := procCoInitializeEx.Call(0, 0); int32(code) < 0 {
		return nil, hresult("CoInitializeEx", uint32(code))
	}
	if code, _, _ := procMFStartup.Call(mfVersion, 0); int32(code) < 0 {
		return nil, hresult("MFStartup", uint32(code))
	}
	t = &h264Transform{}
	defer func() {
		if err != nil {
			t.close()
			t = nil
		}
	}()
	if code, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(clsidH264Encoder)), 0, clsctxInproc, uintptr(unsafe.Pointer(iidTransform)), uintptr(unsafe.Pointer(&t.transform))); int32(code) < 0 {
		return t, hresult("create the H.264 encoder", uint32(code))
	}
	t.transform.call(unknownQueryInterface, uintptr(unsafe.Pointer(iidCodecAPI)), uintptr(unsafe.Pointer(&t.codec)))
	t.setCodec(codecLowLatency, variant{Type: vtBool, Low: 0xFFFF})
	t.setCodec(codecRateControl, variant{Type: vtUI4, Low: rateControlCBR})
	t.setCodec(codecGOPSize, variant{Type: vtUI4, Low: uint32(DefaultFPS * lowLatencyGOPSeconds)})
	t.setBitrate(uint32(bitrate))

	size := uint64(width)<<32 | uint64(height)
	rate := uint64(MaxFPS)<<32 | 1
	if err := t.setType(transformSetOutputType, func(media *comObject) {
		setGUID(media, mtMajorType, mediaTypeVideo)
		setGUID(media, mtSubtype, videoFormatH264)
		setUINT32(media, mtAvgBitrate, uint32(bitrate))
		setUINT32(media, mtInterlace, progressive)
		setUINT32(media, mtProfile, profileBaseline)
		setUINT64(media, mtFrameSize, size)
		setUINT64(media, mtFrameRate, rate)
		setUINT64(media, mtAspectRatio, 1<<32|1)
	}); err != nil {
		return t, err
	}
	if err := t.setType(transformSetInputType, func(media *comObject) {
		setGUID(media, mtMajorType, mediaTypeVideo)
		setGUID(media, mtSubtype, videoFormatNV12)
		setUINT32(media, mtInterlace, progressive)
		setUINT64(media, mtFrameSize, size)
		setUINT64(media, mtFrameRate, rate)
		setUINT64(media, mtAspectRatio, 1<<32|1)
	}); err != nil {
		return t, err
	}
	t.readSequenceHeader()

	var info outputStreamInfo
	if err := hresult("read the output stream", t.transform.call(transformGetOutputStreamInfo, 0, uintptr(unsafe.Pointer(&info)))); err != nil {
		return t, err
	}
	capacity := max(info.Size, uint32(width*height*2))
	if code, _, _ := procMFCreateSample.Call(uintptr(unsafe.Pointer(&t.output))); int32(code) < 0 {
		return t, hresult("create an output sample", uint32(code))
	}
	if code, _, _ := procMFCreateMemoryBuf.Call(uintptr(capacity), uintptr(unsafe.Pointer(&t.outputBuffer))); int32(code) < 0 {
		return t, hresult("create an output buffer", uint32(code))
	}
	if err := hresult("attach the output buffer", t.output.call(sampleAddBuffer, uintptr(unsafe.Pointer(t.outputBuffer)))); err != nil {
		return t, err
	}
	for _, message := range []uintptr{mfNotifyBeginStreaming, mfNotifyStartOfStream} {
		if err := hresult("start the encoder", t.transform.call(transformProcessMessage, message, 0)); err != nil {
			return t, err
		}
	}
	return t, nil
}

func setGUID(media *comObject, key, value *windows.GUID) {
	media.call(attributesSetGUID, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(value)))
}

func setUINT32(media *comObject, key *windows.GUID, value uint32) {
	media.call(attributesSetUINT32, uintptr(unsafe.Pointer(key)), uintptr(value))
}

func setUINT64(media *comObject, key *windows.GUID, value uint64) {
	media.call(attributesSetUINT64, uintptr(unsafe.Pointer(key)), uintptr(value))
}

func (t *h264Transform) setType(method int, describe func(*comObject)) error {
	var media *comObject
	if code, _, _ := procMFCreateMediaType.Call(uintptr(unsafe.Pointer(&media))); int32(code) < 0 {
		return hresult("create a media type", uint32(code))
	}
	defer media.release()
	describe(media)
	return hresult("set the encoder's media type", t.transform.call(method, 0, uintptr(unsafe.Pointer(media)), 0))
}

func (t *h264Transform) setCodec(key *windows.GUID, value variant) {
	if t.codec != nil {
		t.codec.call(codecSetValue, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(&value)))
	}
}

func (t *h264Transform) setBitrate(bitrate uint32) {
	t.setCodec(codecMeanBitrate, variant{Type: vtUI4, Low: bitrate})
}

func (t *h264Transform) forceKeyFrame() {
	t.setCodec(codecForceKey, variant{Type: vtUI4, Low: 1})
}

func (t *h264Transform) readSequenceHeader() {
	var media *comObject
	if int32(t.transform.call(transformGetOutputType, 0, uintptr(unsafe.Pointer(&media)))) < 0 || media == nil {
		return
	}
	defer media.release()
	var size uint32
	if int32(media.call(attributesGetBlobSize, uintptr(unsafe.Pointer(mtSequenceHeader)), uintptr(unsafe.Pointer(&size)))) < 0 || size == 0 {
		return
	}
	header := make([]byte, size)
	if int32(media.call(attributesGetBlob, uintptr(unsafe.Pointer(mtSequenceHeader)), uintptr(unsafe.Pointer(&header[0])), uintptr(size), 0)) < 0 {
		return
	}
	_, t.sps, t.pps, _ = annexBFrame(header)
}

func (t *h264Transform) encode(nv12 []byte, at time.Duration) ([][]byte, error) {
	var sample, buffer *comObject
	if code, _, _ := procMFCreateSample.Call(uintptr(unsafe.Pointer(&sample))); int32(code) < 0 {
		return nil, hresult("create a sample", uint32(code))
	}
	defer sample.release()
	if code, _, _ := procMFCreateMemoryBuf.Call(uintptr(len(nv12)), uintptr(unsafe.Pointer(&buffer))); int32(code) < 0 {
		return nil, hresult("create a buffer", uint32(code))
	}
	defer buffer.release()
	var data *byte
	if err := hresult("lock a buffer", buffer.call(bufferLock, uintptr(unsafe.Pointer(&data)), 0, 0)); err != nil {
		return nil, err
	}
	copy(unsafe.Slice(data, len(nv12)), nv12)
	buffer.call(bufferUnlock)
	buffer.call(bufferSetCurrentLength, uintptr(len(nv12)))
	sample.call(sampleAddBuffer, uintptr(unsafe.Pointer(buffer)))
	sample.call(sampleSetSampleTime, uintptr(at/100))
	sample.call(sampleSetSampleDuration, uintptr((at-t.frameTime)/100))
	t.frameTime = at
	if err := hresult("encode a frame", t.transform.call(transformProcessInput, 0, uintptr(unsafe.Pointer(sample)), 0)); err != nil {
		return nil, err
	}
	var frames [][]byte
	for {
		t.outputBuffer.call(bufferSetCurrentLength, 0)
		output := outputDataBuffer{Sample: t.output}
		var status uint32
		code := t.transform.call(transformProcessOutput, 0, 1, uintptr(unsafe.Pointer(&output)), uintptr(unsafe.Pointer(&status)))
		if code == mfNeedMoreInput {
			return frames, nil
		}
		if err := hresult("read an encoded frame", code); err != nil {
			return frames, err
		}
		frame, err := t.readOutput()
		if err != nil {
			return frames, err
		}
		frames = append(frames, frame)
	}
}

func (t *h264Transform) readOutput() ([]byte, error) {
	var data *byte
	var length uint32
	if err := hresult("lock the output", t.outputBuffer.call(bufferLock, uintptr(unsafe.Pointer(&data)), 0, uintptr(unsafe.Pointer(&length)))); err != nil {
		return nil, err
	}
	defer t.outputBuffer.call(bufferUnlock)
	return bytes.Clone(unsafe.Slice(data, length)), nil
}

func (t *h264Transform) close() {
	t.outputBuffer.release()
	t.output.release()
	t.codec.release()
	t.transform.release()
	_, _, _ = procMFShutdown.Call()
	_, _, _ = procCoUninitialize.Call()
}
