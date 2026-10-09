//go:build darwin

package display

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// The native encoder runs as a child process of sandboxd, so a fault in
// ScreenCaptureKit or VideoToolbox costs one stream, never the Runtime;
// ffmpeg then takes over. It captures the main display, encodes H.264 in
// hardware, writes FLV to stdout and takes control lines on stdin. Unlike
// ffmpeg it changes bitrate and frame rate in place and makes a key frame
// whenever one is asked for, even of a still screen.

type cmTime struct {
	Value     int64
	Timescale int32
	Flags     uint32
	Epoch     int64
}

const (
	cmTimeValid      = 1
	codecH264        = 0x61766331 // 'avc1'
	pixelFormat420v  = 0x34323076 // '420v'
	nativeKeySeconds = 10
	nativeStartup    = 5 * time.Second
)

var native struct {
	vtCreate        func(alloc uintptr, width, height int32, codec uint32, spec, attrs, dataAlloc, callback, refcon uintptr, session *uintptr) int32
	vtSetProperty   func(session, key, value uintptr) int32
	vtPrepare       func(session uintptr) int32
	vtEncode        func(session, image uintptr, pts, duration cmTime, props, refcon uintptr, flags *uint32) int32
	vtInvalidate    func(session uintptr)
	imageBuffer     func(sample uintptr) uintptr
	attachments     func(sample uintptr, create bool) uintptr
	dataBuffer      func(sample uintptr) uintptr
	blockLength     func(block uintptr) uintptr
	blockCopy       func(block, offset, length uintptr, dest unsafe.Pointer) int32
	formatOf        func(sample uintptr) uintptr
	parameterSet    func(format, index uintptr, data **byte, size, count *uintptr, nalLength *int32) int32
	displayMode     func(display uint32) uintptr
	modePixelWidth  func(mode uintptr) uintptr
	modePixelHeight func(mode uintptr) uintptr
	modeRelease     func(mode uintptr)
	queueCreate     func(label string, attr uintptr) uintptr
	setFrameRate    func(config objc.ID, sel objc.SEL, interval cmTime)

	keys struct {
		realTime, profile, constrained, baseline, reordering, bitrate, keyInterval, frameRate uintptr
		lowLatency, forceKey, notSync, frameStatus                                            uintptr
	}
}

var (
	nativeOnce   sync.Once
	nativeErr    error
	nativeFailed atomic.Bool
)

func loadNative() error {
	nativeOnce.Do(func() {
		if nativeErr = loadQuartz(); nativeErr != nil {
			return
		}
		libs := map[string]uintptr{}
		for name, path := range map[string]string{
			"sck":      "/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit",
			"vt":       "/System/Library/Frameworks/VideoToolbox.framework/VideoToolbox",
			"cm":       "/System/Library/Frameworks/CoreMedia.framework/CoreMedia",
			"system":   "/usr/lib/libSystem.B.dylib",
			"objc":     "/usr/lib/libobjc.A.dylib",
			"graphics": "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
		} {
			lib, err := openFramework(path)
			if err != nil {
				nativeErr = err
				return
			}
			libs[name] = lib
		}
		if objc.GetClass("SCStream") == 0 {
			nativeErr = errors.New("ScreenCaptureKit needs macOS 12.3")
			return
		}
		for lib, fns := range map[string]map[string]any{
			"vt": {
				"VTCompressionSessionCreate": &native.vtCreate, "VTSessionSetProperty": &native.vtSetProperty,
				"VTCompressionSessionPrepareToEncodeFrames": &native.vtPrepare, "VTCompressionSessionEncodeFrame": &native.vtEncode,
				"VTCompressionSessionInvalidate": &native.vtInvalidate,
			},
			"cm": {
				"CMSampleBufferGetImageBuffer": &native.imageBuffer, "CMSampleBufferGetSampleAttachmentsArray": &native.attachments,
				"CMSampleBufferGetDataBuffer": &native.dataBuffer, "CMBlockBufferGetDataLength": &native.blockLength,
				"CMBlockBufferCopyDataBytes": &native.blockCopy, "CMSampleBufferGetFormatDescription": &native.formatOf,
				"CMVideoFormatDescriptionGetH264ParameterSetAtIndex": &native.parameterSet,
			},
			"graphics": {
				"CGDisplayCopyDisplayMode": &native.displayMode, "CGDisplayModeGetPixelWidth": &native.modePixelWidth,
				"CGDisplayModeGetPixelHeight": &native.modePixelHeight, "CGDisplayModeRelease": &native.modeRelease,
			},
			"system": {"dispatch_queue_create": &native.queueCreate},
		} {
			for name, fn := range fns {
				purego.RegisterLibFunc(fn, libs[lib], name)
			}
		}
		// A CMTime argument goes by value, which the variadic objc.Send cannot.
		purego.RegisterFunc(&native.setFrameRate, symbolAddress(libs["objc"], "objc_msgSend"))
		k := &native.keys
		vt, cm, sck := libs["vt"], libs["cm"], libs["sck"]
		k.realTime = global(vt, "kVTCompressionPropertyKey_RealTime")
		k.profile = global(vt, "kVTCompressionPropertyKey_ProfileLevel")
		k.constrained = global(vt, "kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel")
		k.baseline = global(vt, "kVTProfileLevel_H264_Baseline_AutoLevel")
		k.reordering = global(vt, "kVTCompressionPropertyKey_AllowFrameReordering")
		k.bitrate = global(vt, "kVTCompressionPropertyKey_AverageBitRate")
		k.keyInterval = global(vt, "kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration")
		k.frameRate = global(vt, "kVTCompressionPropertyKey_ExpectedFrameRate")
		k.lowLatency = global(vt, "kVTVideoEncoderSpecification_EnableLowLatencyRateControl")
		k.forceKey = global(vt, "kVTEncodeFrameOptionKey_ForceKeyFrame")
		k.notSync = global(cm, "kCMSampleAttachmentKey_NotSync")
		k.frameStatus = global(sck, "SCStreamFrameInfoStatus")
		if k.bitrate == 0 || k.forceKey == 0 || k.notSync == 0 || k.frameStatus == 0 {
			nativeErr = errors.New("VideoToolbox or ScreenCaptureKit lacks a key this encoder needs")
		}
	})
	return nativeErr
}

func (s *macScreen) nativeEncoder() *videoEncoder {
	if nativeFailed.Load() || !cg.preflightCapture() || loadNative() != nil {
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return nil
	}
	return &videoEncoder{
		name:   "screencapturekit",
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
	encoder := &screenEncoder{out: bufio.NewWriterSize(os.Stdout, 256<<10), start: time.Now(), done: make(chan error, 1)}
	encoder.flv.w = encoder.out
	encoder.fps.Store(int64(max(1, min(MaxFPS, *fps))))
	if err := encoder.open(max(MinBitrate, min(MaxBitrate, *bitrate)), *maxSize); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := encoder.run(os.Stdin); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

var current *screenEncoder

type screenEncoder struct {
	out     *bufio.Writer
	outMu   sync.Mutex
	flv     flvWriter
	start   time.Time
	done    chan error
	frames  atomic.Int64
	fps     atomic.Int64
	session uintptr
	stream  objc.ID
	keyNow  uintptr // {ForceKeyFrame: true}

	encodeMu sync.Mutex
	latest   uintptr // the newest complete frame, retained
	captured uint64  // frames captured; buffers are pooled, so addresses repeat
	encoded  uint64  // the capture last sent to the encoder
	sentAt   time.Time
	pending  *time.Timer
	forceKey bool
}

func sel(name string) objc.SEL { return objc.RegisterName(name) }

func (e *screenEncoder) open(bitrate, maxSize int) error {
	if err := loadNative(); err != nil {
		return err
	}
	current = e
	main := cg.mainDisplay() // also connects to the window server
	width, height := int(cg.pixelsWide(main)), int(cg.pixelsHigh(main))
	if mode := native.displayMode(main); mode != 0 {
		width, height = int(native.modePixelWidth(mode)), int(native.modePixelHeight(mode))
		native.modeRelease(mode)
	}
	width, height = fitSize(width, height, maxSize)
	if err := e.openSession(width, height, bitrate); err != nil {
		return err
	}
	display, err := shareableDisplay(main)
	if err != nil {
		return err
	}
	return e.openStream(display, width, height)
}

func (e *screenEncoder) openSession(width, height, bitrate int) error {
	callback := purego.NewCallback(func(_, _ uintptr, status int32, _ uint32, sample uintptr) {
		current.onEncoded(status, sample)
	})
	spec := cfDictionary(native.keys.lowLatency, cf.yes)
	status := native.vtCreate(0, int32(width), int32(height), codecH264, spec, 0, 0, callback, 0, &e.session)
	if status != 0 && spec != 0 {
		status = native.vtCreate(0, int32(width), int32(height), codecH264, 0, 0, 0, callback, 0, &e.session)
	}
	if spec != 0 {
		cf.release(spec)
	}
	if status != 0 {
		return fmt.Errorf("VideoToolbox refused an H.264 session (%d)", status)
	}
	native.vtSetProperty(e.session, native.keys.realTime, cf.yes)
	native.vtSetProperty(e.session, native.keys.reordering, cf.no)
	if native.vtSetProperty(e.session, native.keys.profile, native.keys.constrained) != 0 {
		native.vtSetProperty(e.session, native.keys.profile, native.keys.baseline)
	}
	e.setNumber(native.keys.keyInterval, cfFloat64(nativeKeySeconds))
	e.setBitrate(bitrate)
	e.setFPS(int(e.fps.Load()))
	e.keyNow = cfDictionary(native.keys.forceKey, cf.yes)
	if status := native.vtPrepare(e.session); status != 0 {
		return fmt.Errorf("VideoToolbox could not prepare (%d)", status)
	}
	return nil
}

func (e *screenEncoder) setNumber(key, number uintptr) {
	if number == 0 {
		return
	}
	native.vtSetProperty(e.session, key, number)
	cf.release(number)
}

func (e *screenEncoder) setBitrate(bps int) {
	e.setNumber(native.keys.bitrate, cfInt32(int32(max(MinBitrate, min(MaxBitrate, bps)))))
}

func (e *screenEncoder) setFPS(fps int) {
	fps = max(1, min(MaxFPS, fps))
	e.fps.Store(int64(fps))
	e.setNumber(native.keys.frameRate, cfInt32(int32(fps)))
}

func shareableDisplay(id uint32) (objc.ID, error) {
	type answer struct {
		content objc.ID
		err     string
	}
	got := make(chan answer, 1)
	block := objc.NewBlock(func(_ objc.Block, content, failure objc.ID) {
		if content != 0 {
			content.Send(sel("retain"))
		}
		got <- answer{content, describe(failure)}
	})
	defer block.Release()
	objc.ID(objc.GetClass("SCShareableContent")).Send(sel("getShareableContentWithCompletionHandler:"), block)
	var result answer
	select {
	case result = <-got:
	case <-time.After(nativeStartup):
		return 0, errors.New("ScreenCaptureKit did not list the displays")
	}
	if result.content == 0 {
		return 0, fmt.Errorf("ScreenCaptureKit: %s", result.err)
	}
	displays := result.content.Send(sel("displays"))
	for i := range objc.Send[uint](displays, sel("count")) {
		display := displays.Send(sel("objectAtIndex:"), i)
		if objc.Send[uint32](display, sel("displayID")) == id {
			return display, nil
		}
	}
	return 0, errors.New("ScreenCaptureKit does not list the main display")
}

func describe(failure objc.ID) string {
	if failure == 0 {
		return "unknown error"
	}
	return objc.Send[string](failure.Send(sel("localizedDescription")), sel("UTF8String"))
}

var outputClass objc.Class

func (e *screenEncoder) openStream(display objc.ID, width, height int) error {
	if outputClass == 0 {
		var protocols []*objc.Protocol
		for _, name := range []string{"SCStreamOutput", "SCStreamDelegate"} {
			if protocol := objc.GetProtocol(name); protocol != nil {
				protocols = append(protocols, protocol)
			}
		}
		class, err := objc.RegisterClass("CohubDisplayOutput", objc.GetClass("NSObject"), protocols, nil, []objc.MethodDef{
			{Cmd: sel("stream:didOutputSampleBuffer:ofType:"), Fn: func(_ objc.ID, _ objc.SEL, _ objc.ID, sample uintptr, kind int) {
				current.onFrame(sample, kind)
			}},
			{Cmd: sel("stream:didStopWithError:"), Fn: func(_ objc.ID, _ objc.SEL, _ objc.ID, failure objc.ID) {
				current.finish(fmt.Errorf("ScreenCaptureKit stopped: %s", describe(failure)))
			}},
		})
		if err != nil {
			return err
		}
		outputClass = class
	}
	output := objc.ID(outputClass).Send(sel("new"))
	filter := objc.ID(objc.GetClass("SCContentFilter")).Send(sel("alloc")).
		Send(sel("initWithDisplay:excludingWindows:"), display, objc.ID(objc.GetClass("NSArray")).Send(sel("array")))
	config := objc.ID(objc.GetClass("SCStreamConfiguration")).Send(sel("new"))
	config.Send(sel("setWidth:"), uint(width))
	config.Send(sel("setHeight:"), uint(height))
	config.Send(sel("setPixelFormat:"), uint32(pixelFormat420v))
	config.Send(sel("setShowsCursor:"), true)
	config.Send(sel("setQueueDepth:"), 5)
	native.setFrameRate(config, sel("setMinimumFrameInterval:"), cmTime{Value: 1, Timescale: MaxFPS, Flags: cmTimeValid})
	e.stream = objc.ID(objc.GetClass("SCStream")).Send(sel("alloc")).
		Send(sel("initWithFilter:configuration:delegate:"), filter, config, output)
	if e.stream == 0 {
		return errors.New("ScreenCaptureKit refused the stream")
	}
	queue := native.queueCreate("live.cohub.display", 0)
	var failure objc.ID
	if !objc.Send[bool](e.stream, sel("addStreamOutput:type:sampleHandlerQueue:error:"), output, 0, queue, unsafe.Pointer(&failure)) {
		return fmt.Errorf("ScreenCaptureKit: %s", describe(failure))
	}
	started := make(chan string, 1)
	block := objc.NewBlock(func(_ objc.Block, failure objc.ID) {
		if failure != 0 {
			started <- describe(failure)
			return
		}
		started <- ""
	})
	defer block.Release()
	e.stream.Send(sel("startCaptureWithCompletionHandler:"), block)
	select {
	case message := <-started:
		if message != "" {
			return fmt.Errorf("ScreenCaptureKit: %s", message)
		}
	case <-time.After(nativeStartup):
		return errors.New("ScreenCaptureKit did not start")
	}
	return nil
}

func complete(sample uintptr) bool {
	attachments := native.attachments(sample, false)
	if attachments == 0 || cf.arrayCount(attachments) == 0 {
		return false
	}
	status, ok := cfInt(cf.dictionaryGet(cf.arrayAt(attachments, 0), native.keys.frameStatus))
	return ok && status == 0
}

func (e *screenEncoder) onFrame(sample uintptr, kind int) {
	if kind != 0 || !complete(sample) {
		return
	}
	image := native.imageBuffer(sample)
	if image == 0 {
		return
	}
	e.encodeMu.Lock()
	defer e.encodeMu.Unlock()
	cf.retain(image)
	if e.latest != 0 {
		cf.release(e.latest)
	}
	e.latest = image
	e.captured++
	e.encodeLatestLocked()
}

func (e *screenEncoder) encodeLatestLocked() {
	interval := time.Second / time.Duration(e.fps.Load())
	if wait := interval - time.Since(e.sentAt); wait > 0 && !e.forceKey {
		if e.pending == nil {
			e.pending = time.AfterFunc(wait, func() {
				e.encodeMu.Lock()
				defer e.encodeMu.Unlock()
				e.pending = nil
				if e.captured != e.encoded {
					e.encodeLatestLocked()
				}
			})
		}
		return
	}
	var props uintptr
	if e.forceKey {
		props, e.forceKey = e.keyNow, false
	}
	pts := cmTime{Value: time.Since(e.start).Microseconds(), Timescale: 1_000_000, Flags: cmTimeValid}
	var flags uint32
	if status := native.vtEncode(e.session, e.latest, pts, cmTime{}, props, 0, &flags); status != 0 {
		e.finish(fmt.Errorf("VideoToolbox could not encode (%d)", status))
		return
	}
	e.encoded, e.sentAt = e.captured, time.Now()
}

func (e *screenEncoder) requestKeyframe() {
	e.encodeMu.Lock()
	defer e.encodeMu.Unlock()
	e.forceKey = true
	if e.latest != 0 {
		e.encodeLatestLocked()
	}
}

func (e *screenEncoder) onEncoded(status int32, sample uintptr) {
	if status != 0 || sample == 0 {
		return
	}
	key := true
	if attachments := native.attachments(sample, false); attachments != 0 && cf.arrayCount(attachments) > 0 {
		if notSync := cf.dictionaryGet(cf.arrayAt(attachments, 0), native.keys.notSync); notSync != 0 && cf.booleanGetValue(notSync) {
			key = false
		}
	}
	block := native.dataBuffer(sample)
	size := native.blockLength(block)
	if size == 0 {
		return
	}
	data := make([]byte, size)
	if native.blockCopy(block, 0, size, unsafe.Pointer(&data[0])) != 0 {
		return
	}
	var sps, pps []byte
	nalLength := int32(4)
	if key {
		sps, nalLength = parameterSet(sample, 0)
		pps, _ = parameterSet(sample, 1)
	}
	if nalLength != 4 {
		data = reprefix(data, int(nalLength))
	}
	e.outMu.Lock()
	err := e.flv.writeFrame(uint32(time.Since(e.start).Milliseconds()), key, sps, pps, data)
	if err == nil {
		err = e.out.Flush()
	}
	e.outMu.Unlock()
	if err != nil {
		e.finish(nil) // sandboxd stopped reading
		return
	}
	e.frames.Add(1)
}

func parameterSet(sample uintptr, index uintptr) ([]byte, int32) {
	var data *byte
	var size, count uintptr
	var nalLength int32
	if native.parameterSet(native.formatOf(sample), index, &data, &size, &count, &nalLength) != 0 || data == nil {
		return nil, 4
	}
	return append([]byte(nil), unsafe.Slice(data, size)...), nalLength
}

func reprefix(data []byte, length int) []byte {
	var out []byte
	for len(data) >= length {
		n := 0
		for _, b := range data[:length] {
			n = n<<8 | int(b)
		}
		data = data[length:]
		if n > len(data) {
			break
		}
		out = append(out, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
		out = append(out, data[:n]...)
		data = data[n:]
	}
	return out
}

func (e *screenEncoder) finish(err error) {
	select {
	case e.done <- err:
	default:
	}
}

func (e *screenEncoder) run(control io.Reader) error {
	go func() {
		scanner := bufio.NewScanner(control)
		for scanner.Scan() {
			command, value, _ := strings.Cut(strings.TrimSpace(scanner.Text()), " ")
			number, _ := strconv.Atoi(value)
			switch {
			case command == "keyframe":
				e.requestKeyframe()
			case command == "bitrate" && number > 0:
				e.setBitrate(number)
			case command == "fps" && number > 0:
				e.setFPS(number)
			}
		}
		e.finish(nil)
	}()
	time.AfterFunc(nativeStartup, func() {
		if e.frames.Load() == 0 {
			e.finish(errors.New("ScreenCaptureKit sent no frames"))
		}
	})
	err := <-e.done
	if e.stream != 0 {
		stopped := objc.NewBlock(func(objc.Block, objc.ID) {})
		e.stream.Send(sel("stopCaptureWithCompletionHandler:"), stopped)
	}
	if e.session != 0 {
		native.vtInvalidate(e.session)
	}
	return err
}
