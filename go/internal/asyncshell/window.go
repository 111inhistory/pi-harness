package asyncshell

import (
	"bytes"
	"encoding/binary"
	"os"
	"strings"
)

// window.go owns the bounded readers of the filtered transcript (output.log) and the
// sparse checkpoints (output.index) that give every result global 1-based line
// numbers. A result's Output is a head piece followed by a tail piece; HeadBytes is
// the exact byte split, so callers never count lines to separate them. Byte and line
// budgets are both enforced because they catch different shapes: few huge lines
// versus thousands of short ones.
//
// The monitor appends one checkpoint per IndexLineStride lines or IndexByteStride
// bytes. A reader binary searches the nearest one and scans forward at most one
// stride (or one long line), so a notification never rescans the transcript nor
// parses the whole index. Fixed-width records buy that at the cost of a
// non-human-readable file; a torn final record is ignored because only complete
// records are counted.

const (
	// IndexLineStride and IndexByteStride bound the forward scan after the nearest
	// checkpoint.
	IndexLineStride = 1000
	IndexByteStride = 64 * 1024

	// WindowHeadBytes and WindowHeadLines bound the head of a clipped unread range.
	// The tail takes the remaining budget: the end of a failed command carries the
	// diagnosis, while the head keeps the first visible cause.
	WindowHeadBytes = MaxResultBytes / 2
	WindowHeadLines = MaxResultLines / 2

	// indexRecordBytes is one checkpoint: <bytes><newlines> as little-endian uint64s.
	indexRecordBytes = 16
)

var newlineByte = []byte{'\n'}

// lineCheckpoint is one recorded position: `newlines` newlines precede byte `bytes`.
// Positions may fall inside a line; only newline counts matter.
type lineCheckpoint struct {
	bytes    int64
	newlines int64
}

// lineIndex is a seekable checkpoint list; nil means the task has none yet.
type lineIndex struct {
	file    *os.File
	records int64
}

func openLineIndex(path string) *lineIndex {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	info, statErr := file.Stat()
	if statErr != nil {
		file.Close()
		return nil
	}
	return &lineIndex{file: file, records: info.Size() / indexRecordBytes}
}

func (index *lineIndex) Close() {
	if index != nil {
		index.file.Close()
	}
}

func (index *lineIndex) record(number int64) (lineCheckpoint, bool) {
	var raw [indexRecordBytes]byte
	if number < 0 || number >= index.records {
		return lineCheckpoint{}, false
	}
	if _, err := index.file.ReadAt(raw[:], number*indexRecordBytes); err != nil {
		return lineCheckpoint{}, false
	}
	checkpoint := lineCheckpoint{
		bytes:    int64(binary.LittleEndian.Uint64(raw[0:8])),
		newlines: int64(binary.LittleEndian.Uint64(raw[8:16])),
	}
	// Every newline is a byte, so a larger count is a torn or foreign record.
	if checkpoint.newlines > checkpoint.bytes {
		return lineCheckpoint{}, false
	}
	return checkpoint, true
}

// at is the last checkpoint at or before offset.
func (index *lineIndex) at(offset int64) lineCheckpoint {
	if index == nil || index.records == 0 {
		return lineCheckpoint{}
	}
	low, high := int64(0), index.records-1
	found := lineCheckpoint{}
	for low <= high {
		middle := (low + high) / 2
		checkpoint, ok := index.record(middle)
		if !ok {
			return found
		}
		if checkpoint.bytes > offset {
			high = middle - 1
			continue
		}
		found = checkpoint
		low = middle + 1
	}
	return found
}

// outputLog is one open view of a task's filtered transcript.
type outputLog struct {
	file  *os.File
	size  int64
	index *lineIndex
}

// openOutputLog opens the transcript for reading. A task that never wrote a byte
// yields an empty view; other open or stat failures panic like the engine.
func openOutputLog(paths TaskPaths) *outputLog {
	file, err := os.Open(paths.Filtered)
	if err != nil {
		if os.IsNotExist(err) {
			return &outputLog{}
		}
		panic(err)
	}
	info, statErr := file.Stat()
	if statErr != nil {
		file.Close()
		panic(statErr)
	}
	return &outputLog{file: file, size: info.Size(), index: openLineIndex(paths.Index)}
}

func (log *outputLog) Close() {
	log.index.Close()
	if log.file != nil {
		log.file.Close()
	}
}

func (log *outputLog) hasMore(cursor int64) bool {
	return cursor < log.size
}

// byteAt reads one byte, or 0 outside the log.
func (log *outputLog) byteAt(offset int64) byte {
	if log.file == nil || offset < 0 || offset >= log.size {
		return 0
	}
	var one [1]byte
	if _, err := log.file.ReadAt(one[:], offset); err != nil {
		return 0
	}
	return one[0]
}

// atLineStart reports whether offset begins a line, so a byte budget landing on a
// boundary keeps that whole line.
func (log *outputLog) atLineStart(offset int64) bool {
	return offset <= 0 || log.byteAt(offset-1) == '\n'
}

func (log *outputLog) endsWithNewline() bool {
	return log.size > 0 && log.byteAt(log.size-1) == '\n'
}

// span reads [start,end). Callers keep both ends inside one result budget (or one
// long line), so this never materializes the whole log.
func (log *outputLog) span(start, end int64) []byte {
	if log.file == nil || start >= end {
		return nil
	}
	buffer := make([]byte, int(end-start))
	read, err := log.file.ReadAt(buffer, start)
	if read <= 0 && err != nil {
		panic(err)
	}
	return buffer[:read]
}

func (log *outputLog) newlinesBetween(start, end int64) int64 {
	if log.file == nil || start >= end {
		return 0
	}
	var total int64
	buffer := make([]byte, IndexByteStride)
	for offset := start; offset < end; {
		want := minInt64(int64(len(buffer)), end-offset)
		read, _ := log.file.ReadAt(buffer[:want], offset)
		if read <= 0 {
			break
		}
		total += countNewlines(buffer[:read])
		offset += int64(read)
	}
	return total
}

// newlinesBefore counts every newline in [0,offset).
func (log *outputLog) newlinesBefore(offset int64) int64 {
	if log.file == nil || offset <= 0 {
		return 0
	}
	offset = minInt64(offset, log.size)
	checkpoint := log.index.at(offset)
	return checkpoint.newlines + log.newlinesBetween(checkpoint.bytes, offset)
}

// lineAt is the 1-based global line containing byte offset. At EOF it is the
// unterminated last line, or the next line to be written after a final newline.
func (log *outputLog) lineAt(offset int64) int64 {
	if offset <= 0 {
		return 1
	}
	return log.newlinesBefore(minInt64(offset, log.size)) + 1
}

func (log *outputLog) totalLines() int64 {
	if log.size == 0 {
		return 0
	}
	lines := log.newlinesBefore(log.size)
	if log.endsWithNewline() {
		return lines
	}
	return lines + 1
}

// lineCount is how many lines [start,end) occupies: newline-terminated lines plus
// one trailing partial line.
func (log *outputLog) lineCount(start, end int64) int64 {
	if start >= end {
		return 0
	}
	lines := log.newlinesBetween(start, end)
	if log.byteAt(end-1) != '\n' {
		lines++
	}
	return lines
}

// selection is one bounded read of the filtered transcript.
type selection struct {
	text      string
	next      int64
	truncated bool
	window    OutputWindow
}

// emptyAt builds a result with no text: the window still names the line the cursor
// sits on, so a caller can point at where output will appear.
func (log *outputLog) emptyAt(offset int64, truncated bool) selection {
	line := log.lineAt(offset)
	return selection{next: offset, truncated: truncated, window: OutputWindow{
		FirstLine: line, TailFirstLine: line, TotalLines: log.totalLines(),
	}}
}

// chunkAt is the sequential increment for the standalone CLI: at most MaxResultBytes
// and MaxResultLines, never skipping bytes, so consecutive calls concatenate to the
// transcript.
func (log *outputLog) chunkAt(cursor int64) selection {
	start := clampCursor(cursor, log.size)
	if start >= log.size {
		return log.emptyAt(start, false)
	}
	data := log.span(start, minInt64(start+MaxResultBytes, log.size))
	if countLines(data) > MaxResultLines {
		data = data[:offsetAfterNthNewline(data, MaxResultLines)]
	}
	data = data[:utf8Boundary(data, len(data))]
	next := start + int64(len(data))
	line := log.lineAt(start)
	return selection{text: string(data), next: next, truncated: next < log.size, window: OutputWindow{
		FirstLine: line, TailFirstLine: line, TotalLines: log.totalLines(),
	}}
}

// unread is the model-visible background delivery: the whole unread range when it
// fits, otherwise its head and tail with the omitted middle left on disk. The cursor
// advances to EOF because the unread range was handed over.
func (log *outputLog) unread(cursor int64) selection {
	start := clampCursor(cursor, log.size)
	if start >= log.size {
		return log.emptyAt(start, false)
	}
	if log.size-start <= MaxResultBytes && log.lineCount(start, log.size) <= MaxResultLines {
		data := log.span(start, log.size)
		line := log.lineAt(start)
		return selection{text: string(data[:utf8Boundary(data, len(data))]), next: log.size, window: OutputWindow{
			FirstLine: line, TailFirstLine: line, TotalLines: log.totalLines(),
		}}
	}
	head, headLines := log.headPiece(start, log.size)
	headEnd := start + int64(len(head))
	tail, tailStart := log.tailPiece(headEnd, log.size,
		int64(MaxResultBytes-len(head)), int64(MaxResultLines-headLines))
	return selection{text: head + tail, next: log.size, truncated: tailStart > headEnd, window: OutputWindow{
		FirstLine:     log.lineAt(start),
		HeadLines:     headLines,
		HeadBytes:     int64(len(head)),
		TailFirstLine: log.lineAt(tailStart),
		TotalLines:    log.totalLines(),
	}}
}

// syncTail keeps the last lines of the whole transcript for a managed foreground
// result, matching the native shell tail. FirstLine is the first line still held.
func (log *outputLog) syncTail() selection {
	if log.size == 0 {
		return log.emptyAt(0, false)
	}
	text, start := log.tailPiece(0, log.size, MaxSyncTailBytes, MaxSyncTailLines)
	first := log.lineAt(start)
	return selection{text: text, next: log.size, truncated: start > 0, window: OutputWindow{
		FirstLine: first, TailFirstLine: first, TotalLines: log.totalLines(),
	}}
}

// headPiece selects complete lines from the start of a clipped range, bounded by
// WindowHeadBytes and WindowHeadLines. Only a line longer than the byte budget leaves
// the head mid-line, where it ends at a UTF-8 boundary instead.
func (log *outputLog) headPiece(start, end int64) (string, int64) {
	budget := minInt64(end-start, WindowHeadBytes)
	if budget <= 0 {
		return "", 0
	}
	data := log.span(start, start+budget)
	cut := len(data)
	seen := int64(0)
	for index, b := range data {
		if b != '\n' {
			continue
		}
		seen++
		if seen == WindowHeadLines {
			cut = index + 1
			break
		}
	}
	if seen < WindowHeadLines {
		if last := bytes.LastIndexByte(data, '\n'); last >= 0 {
			cut = last + 1
		} else {
			cut = utf8Boundary(data, cut)
		}
	}
	return string(data[:cut]), countLines(data[:cut])
}

// tailPiece selects the last lines before end within budgetBytes and budgetLines. A
// rune-aligned tail is kept when the byte budget starts mid-line, except for a single
// line longer than the budget: that line's bytes are the diagnosis, as in Pi.
func (log *outputLog) tailPiece(headEnd, end, budgetBytes, budgetLines int64) (string, int64) {
	if end <= headEnd || budgetBytes <= 0 || budgetLines <= 0 {
		return "", end
	}
	from := end - minInt64(end-headEnd, budgetBytes)
	data := log.span(from, end)
	cut := 0
	if from > headEnd && !log.atLineStart(from) {
		// Drop the partial leading line only when a complete line follows it; a
		// boundary at EOF would otherwise drop the whole last line.
		if index := bytes.IndexByte(data, '\n'); index >= 0 && index+1 < len(data) {
			cut = index + 1
		}
	}
	if lines := countLines(data[cut:]); lines > budgetLines {
		cut += offsetAfterNthNewline(data[cut:], lines-budgetLines)
	}
	if cut == 0 && from > 0 {
		for cut < len(data) && cut < 4 && data[cut]&0xc0 == 0x80 {
			cut++
		}
	}
	return string(data[cut:]), from + int64(cut)
}

func clampCursor(cursor, size int64) int64 {
	if cursor < 0 {
		return 0
	}
	return minInt64(cursor, size)
}

func countNewlines(data []byte) int64 {
	return int64(bytes.Count(data, newlineByte))
}

// countLines counts newline-terminated lines plus one trailing partial line.
func countLines(data []byte) int64 {
	if len(data) == 0 {
		return 0
	}
	lines := countNewlines(data)
	if data[len(data)-1] != '\n' {
		lines++
	}
	return lines
}

// offsetAfterNthNewline is the byte position just past the nth newline, or the end of
// the span when it holds fewer.
func offsetAfterNthNewline(data []byte, nth int64) int {
	if nth <= 0 {
		return 0
	}
	found := int64(0)
	for offset, b := range data {
		if b != '\n' {
			continue
		}
		found++
		if found == nth {
			return offset + 1
		}
	}
	return len(data)
}

// transcript owns the append-only filtered log and its checkpoints. The monitor is the
// only writer while it runs, but create's failure paths may append before it exists or
// concurrently, so every append re-reads the size and counts bytes it did not write.
type transcript struct {
	log             *os.File
	index           *os.File
	bytes           int64
	lines           int64
	checkpointBytes int64
	checkpointLines int64
}

func openTranscript(paths TaskPaths) (*transcript, error) {
	logFile, err := os.OpenFile(paths.Filtered, os.O_RDWR|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	indexFile, err := os.OpenFile(paths.Index, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		logFile.Close()
		return nil, err
	}
	written := &transcript{log: logFile, index: indexFile}
	if err := written.resync(); err != nil {
		written.Close()
		return nil, err
	}
	return written, nil
}

// openTranscriptOrPanic reports an unopenable transcript through the monitor panic
// path, which turns it into internal_error instead of dropping delivered output.
func openTranscriptOrPanic(paths TaskPaths) *transcript {
	written, err := openTranscript(paths)
	if err != nil {
		panic(err)
	}
	return written
}

// mustAppend routes a transcript write failure into the monitor's panic path.
func mustAppend(written *transcript, text string) {
	if err := written.Append(text); err != nil {
		panic(err)
	}
}

func (written *transcript) Close() {
	if written.index != nil {
		written.index.Close()
	}
	if written.log != nil {
		written.log.Close()
	}
}

// resync accounts for bytes this transcript did not write: create's failure paths
// append to output.log without holding it. Existing checkpoints stay valid because
// the log is append-only.
func (written *transcript) resync() error {
	info, err := written.log.Stat()
	if err != nil {
		return err
	}
	size := info.Size()
	if size == written.bytes {
		return nil
	}
	if size < written.bytes {
		// The transcript shrank, so its checkpoints describe different content.
		if err := written.index.Truncate(0); err != nil {
			return err
		}
		written.bytes, written.lines, written.checkpointBytes, written.checkpointLines = 0, 0, 0, 0
	}
	buffer := make([]byte, IndexByteStride)
	for written.bytes < size {
		want := minInt64(int64(len(buffer)), size-written.bytes)
		read, readErr := written.log.ReadAt(buffer[:want], written.bytes)
		if read <= 0 {
			return readErr
		}
		written.lines += countNewlines(buffer[:read])
		written.bytes += int64(read)
	}
	return nil
}

// Append writes filtered text and records a checkpoint when one is due. A write failure
// is reported to the caller, which turns it into internal_error instead of dropping
// delivered output silently.
func (written *transcript) Append(text string) error {
	if text == "" {
		return nil
	}
	if err := written.resync(); err != nil {
		return err
	}
	if err := written.checkpoint(); err != nil {
		return err
	}
	if _, err := written.log.WriteString(text); err != nil {
		return err
	}
	written.bytes += int64(len(text))
	written.lines += int64(strings.Count(text, "\n"))
	return nil
}

func (written *transcript) checkpoint() error {
	if written.bytes-written.checkpointBytes < IndexByteStride && written.lines-written.checkpointLines < IndexLineStride {
		return nil
	}
	var raw [indexRecordBytes]byte
	binary.LittleEndian.PutUint64(raw[0:8], uint64(written.bytes))
	binary.LittleEndian.PutUint64(raw[8:16], uint64(written.lines))
	if _, err := written.index.Write(raw[:]); err != nil {
		return err
	}
	written.checkpointBytes, written.checkpointLines = written.bytes, written.lines
	return nil
}
