package asyncshell

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

// window_test.go covers the bounded transcript readers: the global line numbers a
// result reports, the head+tail window of an oversized unread range, the managed
// sync tail, and the incremental checkpoints that make all of it cheap.

func windowTestPaths(t *testing.T) TaskPaths {
	t.Helper()
	paths := taskPaths(filepath.Join(t.TempDir(), "job_00c0ffee"))
	if err := os.MkdirAll(paths.Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return paths
}

func writeFilteredLog(t *testing.T, paths TaskPaths, text string) {
	t.Helper()
	if err := os.WriteFile(paths.Filtered, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

// appendTranscript writes through the monitor's own writer so the checkpoints are
// produced exactly as in production.
func appendTranscript(t *testing.T, paths TaskPaths, chunks ...string) {
	t.Helper()
	written, err := openTranscript(paths)
	if err != nil {
		t.Fatal(err)
	}
	defer written.Close()
	for _, chunk := range chunks {
		if err := written.Append(chunk); err != nil {
			t.Fatal(err)
		}
	}
}

func numberedLines(count int) (string, []string) {
	lines := make([]string, count)
	var builder strings.Builder
	for index := range lines {
		lines[index] = fmt.Sprintf("line %05d\n", index+1)
		builder.WriteString(lines[index])
	}
	return builder.String(), lines
}

// lineStarts maps each 1-based line to its byte offset.
func lineStarts(lines []string) []int64 {
	starts := make([]int64, len(lines)+1)
	for index, line := range lines {
		starts[index+1] = starts[index] + int64(len(line))
	}
	return starts
}

// naiveLineAt is an independent count of the 1-based line holding offset.
func naiveLineAt(text string, offset int64) int64 {
	if offset <= 0 {
		return 1
	}
	offset = minInt64(offset, int64(len(text)))
	return int64(strings.Count(text[:offset], "\n")) + 1
}

func TestShellResultJSONCarriesEveryWindowField(t *testing.T) {
	encoded, err := json.Marshal(ShellResult{ID: "job_00c0ffee"})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	window, ok := decoded["window"].(map[string]interface{})
	if !ok {
		t.Fatalf("result has no window object: %s", encoded)
	}
	for _, field := range []string{"firstLine", "headLines", "headBytes", "tailFirstLine", "totalLines"} {
		if _, present := window[field]; !present {
			t.Errorf("window.%s is missing: %s", field, encoded)
		}
	}
	if len(window) != 5 {
		t.Errorf("window carries unexpected fields: %s", encoded)
	}
	if truncated, ok := decoded["truncated"].(bool); !ok || truncated {
		t.Errorf("truncated must always be encoded: %s", encoded)
	}
}

func TestLineIndexResolvesGlobalLinesWithoutRescanning(t *testing.T) {
	paths := windowTestPaths(t)
	text, lines := numberedLines(4000)
	for start := 0; start < len(lines); start += 250 {
		end := start + 250
		if end > len(lines) {
			end = len(lines)
		}
		appendTranscript(t, paths, strings.Join(lines[start:end], ""))
	}
	starts := lineStarts(lines)
	offsets := []int64{0, 1, int64(len(text)) - 1, int64(len(text))}
	for index := 1; index <= len(lines); index += 137 {
		offsets = append(offsets, starts[index], starts[index]+1, starts[index]-1)
	}

	t.Run("indexed", func(t *testing.T) {
		log := openOutputLog(paths)
		defer log.Close()
		if got := log.totalLines(); got != int64(len(lines)) {
			t.Fatalf("totalLines = %d, want %d", got, len(lines))
		}
		for _, offset := range offsets {
			if got, want := log.lineAt(offset), naiveLineAt(text, offset); got != want {
				t.Errorf("lineAt(%d) = %d, want %d", offset, got, want)
			}
		}
	})
	index := openLineIndex(paths.Index)
	if index == nil {
		t.Fatal("the monitor wrote no checkpoint index")
	}
	if index.records < 3 {
		index.Close()
		t.Fatalf("monitor wrote %d checkpoints for %d lines", index.records, len(lines))
	}
	if index.records > int64(len(lines)) {
		index.Close()
		t.Fatalf("checkpoints are not sparse: %d records", index.records)
	}
	index.Close()

	// Losing the index may only widen the forward scan; line numbers must not move.
	if err := os.Remove(paths.Index); err != nil {
		t.Fatal(err)
	}
	recovered := openOutputLog(paths)
	defer recovered.Close()
	for _, offset := range offsets {
		if got, want := recovered.lineAt(offset), naiveLineAt(text, offset); got != want {
			t.Errorf("without index lineAt(%d) = %d, want %d", offset, got, want)
		}
	}
}

func TestChunkAtCapsLinesAndBytesWithoutLosingBytes(t *testing.T) {
	t.Run("line cap", func(t *testing.T) {
		paths := windowTestPaths(t)
		text, _ := numberedLines(5000)
		writeFilteredLog(t, paths, text)
		log := openOutputLog(paths)
		defer log.Close()

		var assembled strings.Builder
		cursor := int64(0)
		chunks := 0
		for {
			chosen := log.chunkAt(cursor)
			if chosen.text == "" {
				if chosen.truncated {
					t.Fatal("an empty chunk cannot be truncated")
				}
				break
			}
			if lines := countLines([]byte(chosen.text)); lines > MaxResultLines {
				t.Fatalf("chunk carries %d lines", lines)
			}
			if len(chosen.text) > MaxResultBytes {
				t.Fatalf("chunk carries %d bytes", len(chosen.text))
			}
			if chosen.window.HeadBytes != 0 || chosen.window.HeadLines != 0 {
				t.Fatalf("an increment must not split head and tail: %#v", chosen.window)
			}
			if chosen.window.FirstLine != naiveLineAt(text, cursor) {
				t.Fatalf("chunk start line = %d, want %d", chosen.window.FirstLine, naiveLineAt(text, cursor))
			}
			assembled.WriteString(chosen.text)
			cursor = chosen.next
			chunks++
		}
		if assembled.String() != text {
			t.Fatal("sequential chunks did not concatenate to the transcript")
		}
		if chunks != 3 {
			t.Fatalf("5000 lines took %d chunks, want 3", chunks)
		}
	})

	t.Run("byte cap", func(t *testing.T) {
		paths := windowTestPaths(t)
		var builder strings.Builder
		for index := 0; index < 500; index++ {
			builder.WriteString(strings.Repeat("x", 199) + "\n")
		}
		text := builder.String()
		writeFilteredLog(t, paths, text)
		log := openOutputLog(paths)
		defer log.Close()

		var assembled strings.Builder
		cursor := int64(0)
		for {
			chosen := log.chunkAt(cursor)
			if chosen.text == "" {
				break
			}
			if len(chosen.text) > MaxResultBytes {
				t.Fatalf("chunk carries %d bytes", len(chosen.text))
			}
			assembled.WriteString(chosen.text)
			cursor = chosen.next
		}
		if assembled.String() != text {
			t.Fatal("byte-capped chunks lost or repeated bytes")
		}
	})
}

func TestTrailingPartialLineKeepsLineNumbers(t *testing.T) {
	paths := windowTestPaths(t)
	writeFilteredLog(t, paths, "one\ntwo")
	log := openOutputLog(paths)
	if got := log.totalLines(); got != 2 {
		t.Fatalf("totalLines = %d, want 2", got)
	}
	if got := log.lineAt(int64(len("one\ntwo"))); got != 2 {
		t.Fatalf("line at EOF = %d, want the unterminated last line", got)
	}
	chosen := log.chunkAt(0)
	log.Close()
	if chosen.text != "one\ntwo" || chosen.truncated || chosen.next != int64(len("one\ntwo")) {
		t.Fatalf("chunk = %#v", chosen)
	}
	if chosen.window.FirstLine != 1 || chosen.window.TailFirstLine != 1 || chosen.window.TotalLines != 2 {
		t.Fatalf("window = %#v", chosen.window)
	}

	writeFilteredLog(t, paths, "one\ntwo\n")
	completed := openOutputLog(paths)
	defer completed.Close()
	if got := completed.totalLines(); got != 2 {
		t.Fatalf("trailing newline totalLines = %d, want 2", got)
	}
	if got := completed.lineAt(int64(len("one\ntwo\n"))); got != 3 {
		t.Fatalf("line after trailing newline = %d, want the next line", got)
	}
}

func TestUnreadWindowKeepsHeadAndTailOfNewlyUnreadRange(t *testing.T) {
	paths := windowTestPaths(t)
	_, lines := numberedLines(5000)
	for start := 0; start < len(lines); start += 500 {
		end := start + 500
		if end > len(lines) {
			end = len(lines)
		}
		appendTranscript(t, paths, strings.Join(lines[start:end], ""))
	}
	starts := lineStarts(lines)
	log := openOutputLog(paths)
	defer log.Close()

	const consumed = 1234 // bytes before the cursor are already delivered
	chosen := log.unread(starts[consumed])
	window := chosen.window
	if !chosen.truncated {
		t.Fatal("an oversized unread range must report truncation")
	}
	if chosen.next != log.size {
		t.Fatalf("cursor = %d, want EOF %d", chosen.next, log.size)
	}
	if window.FirstLine != int64(consumed)+1 {
		t.Fatalf("firstLine = %d, want %d", window.FirstLine, consumed+1)
	}
	if window.HeadLines != WindowHeadLines {
		t.Fatalf("headLines = %d, want %d", window.HeadLines, WindowHeadLines)
	}
	head := strings.Join(lines[consumed:consumed+int(WindowHeadLines)], "")
	if int(window.HeadBytes) != len(head) || chosen.text[:window.HeadBytes] != head {
		t.Fatalf("head bytes do not match the first %d lines", WindowHeadLines)
	}
	tail := chosen.text[window.HeadBytes:]
	if window.TailFirstLine != int64(len(lines))-int64(countLines([]byte(tail)))+1 {
		t.Fatalf("tailFirstLine = %d does not name the tail's first line", window.TailFirstLine)
	}
	if window.TailFirstLine <= window.FirstLine+window.HeadLines {
		t.Fatalf("no omitted range: %#v", window)
	}
	if window.TotalLines != int64(len(lines)) {
		t.Fatalf("totalLines = %d, want %d", window.TotalLines, len(lines))
	}
	if len(chosen.text) > MaxResultBytes {
		t.Fatalf("window carries %d bytes", len(chosen.text))
	}

	// Resuming at the reported line must recover the tail, and resuming at the
	// first omitted line must recover the middle.
	resumed := log.chunkAt(starts[window.TailFirstLine-1])
	if resumed.text != tail {
		t.Fatal("reading from tailFirstLine did not recover the tail")
	}
	middle := log.chunkAt(starts[window.FirstLine-1+window.HeadLines])
	if !strings.HasPrefix(middle.text, lines[consumed+int(WindowHeadLines)]) {
		t.Fatal("reading from the omitted range did not recover the middle")
	}
}

func TestUnreadWindowSplitsByBytesAtLineBoundaries(t *testing.T) {
	paths := windowTestPaths(t)
	lines := make([]string, 200)
	var builder strings.Builder
	for index := range lines {
		lines[index] = strings.Repeat("y", 499) + "\n"
		builder.WriteString(lines[index])
	}
	text := builder.String()
	writeFilteredLog(t, paths, text)
	log := openOutputLog(paths)
	defer log.Close()

	chosen := log.unread(0)
	window := chosen.window
	if !chosen.truncated {
		t.Fatal("an oversized unread range must report truncation")
	}
	if len(chosen.text) > MaxResultBytes {
		t.Fatalf("window carries %d bytes", len(chosen.text))
	}
	// Byte budget dominates here: the head ends after the last complete line that
	// still fits in WindowHeadBytes.
	if want := int64(WindowHeadBytes / len(lines[0])); window.HeadLines != want {
		t.Fatalf("headLines = %d, want %d", window.HeadLines, want)
	}
	head := strings.Join(lines[:window.HeadLines], "")
	if chosen.text[:window.HeadBytes] != head {
		t.Fatal("head is not the first complete lines")
	}
	tail := chosen.text[window.HeadBytes:]
	if !strings.HasSuffix(text, tail) || !strings.HasSuffix(tail, lines[len(lines)-1]) {
		t.Fatal("tail is not the transcript suffix")
	}
	if got, want := window.TailFirstLine+int64(countLines([]byte(tail)))-1, int64(len(lines)); got != want {
		t.Fatalf("tail ends at line %d, want %d", got, want)
	}
	if window.TailFirstLine <= window.FirstLine+window.HeadLines {
		t.Fatalf("no omitted range: %#v", window)
	}
	if window.TotalLines != int64(len(lines)) {
		t.Fatalf("totalLines = %d, want %d", window.TotalLines, len(lines))
	}
}

func TestUnreadWindowHandlesOneOverlongLine(t *testing.T) {
	paths := windowTestPaths(t)
	text := strings.Repeat("诊断", 9000) // 54000 bytes without any newline
	writeFilteredLog(t, paths, text)
	log := openOutputLog(paths)
	defer log.Close()

	chosen := log.unread(0)
	window := chosen.window
	if !chosen.truncated {
		t.Fatal("a 54 KiB single line must report truncation")
	}
	if len(chosen.text) > MaxResultBytes {
		t.Fatalf("window carries %d bytes", len(chosen.text))
	}
	if !utf8.ValidString(chosen.text) {
		t.Fatal("the split line is not valid UTF-8")
	}
	if window.TotalLines != 1 || window.FirstLine != 1 {
		t.Fatalf("window = %#v, want the single line", window)
	}
	if window.HeadBytes <= 0 || window.HeadBytes > WindowHeadBytes || window.HeadLines != 1 {
		t.Fatalf("head = %#v", window)
	}
	head := chosen.text[:window.HeadBytes]
	if head != text[:window.HeadBytes] {
		t.Fatal("head is not the transcript prefix")
	}
	tail := chosen.text[window.HeadBytes:]
	if !strings.HasSuffix(text, tail) {
		t.Fatal("tail is not the transcript suffix")
	}
	if window.TailFirstLine != 1 {
		t.Fatalf("tailFirstLine = %d, want the same line", window.TailFirstLine)
	}
}

func TestSyncTailKeepsTheNativeTailWindow(t *testing.T) {
	t.Run("line bounded", func(t *testing.T) {
		paths := windowTestPaths(t)
		text, lines := numberedLines(5000)
		writeFilteredLog(t, paths, text)
		log := openOutputLog(paths)
		defer log.Close()

		chosen := log.syncTail()
		window := chosen.window
		if !chosen.truncated || chosen.next != log.size {
			t.Fatalf("sync tail = %#v", chosen)
		}
		if window.HeadBytes != 0 || window.HeadLines != 0 || window.TailFirstLine != window.FirstLine {
			t.Fatalf("sync tail window = %#v", window)
		}
		if window.FirstLine != int64(len(lines))-MaxSyncTailLines+1 || window.TotalLines != int64(len(lines)) {
			t.Fatalf("sync tail window = %#v", window)
		}
		if chosen.text != strings.Join(lines[len(lines)-MaxSyncTailLines:], "") {
			t.Fatal("sync tail is not the last lines of the transcript")
		}
	})

	t.Run("whole log fits", func(t *testing.T) {
		paths := windowTestPaths(t)
		text, _ := numberedLines(20)
		writeFilteredLog(t, paths, text)
		log := openOutputLog(paths)
		defer log.Close()

		chosen := log.syncTail()
		if chosen.truncated || chosen.window.FirstLine != 1 || chosen.text != text {
			t.Fatalf("sync tail = %#v", chosen)
		}
	})

	t.Run("exactly aligned byte budget keeps the whole first line", func(t *testing.T) {
		paths := windowTestPaths(t)
		lines := make([]string, 2000)
		var builder strings.Builder
		for index := range lines {
			lines[index] = strings.Repeat("z", 199) + "\n"
			builder.WriteString(lines[index])
		}
		writeFilteredLog(t, paths, builder.String())
		log := openOutputLog(paths)
		defer log.Close()

		chosen := log.syncTail()
		if len(chosen.text) > MaxSyncTailBytes {
			t.Fatalf("sync tail carries %d bytes", len(chosen.text))
		}
		kept := countLines([]byte(chosen.text))
		if want := int64(MaxSyncTailBytes / len(lines[0])); kept != want {
			t.Fatalf("sync tail carries %d lines, want the %d that fill the byte budget", kept, want)
		}
		if !strings.HasSuffix(chosen.text, lines[len(lines)-1]) {
			t.Fatal("sync tail lost the final diagnostic line")
		}
		if got, want := chosen.window.FirstLine+kept-1, int64(len(lines)); got != want {
			t.Fatalf("sync tail ends at line %d, want %d", got, want)
		}
	})

	t.Run("overlong final line keeps its bytes", func(t *testing.T) {
		paths := windowTestPaths(t)
		text := "header\n" + strings.Repeat("诊", 20000) + "\n"
		writeFilteredLog(t, paths, text)
		log := openOutputLog(paths)
		defer log.Close()

		chosen := log.syncTail()
		if chosen.text == "" {
			t.Fatal("a final line longer than the byte budget must still be delivered")
		}
		if len(chosen.text) > MaxSyncTailBytes {
			t.Fatalf("sync tail carries %d bytes", len(chosen.text))
		}
		if len(chosen.text) < MaxSyncTailBytes-utf8.UTFMax {
			t.Fatalf("sync tail kept only %d of %d bytes", len(chosen.text), MaxSyncTailBytes)
		}
		if !utf8.ValidString(chosen.text) || !strings.HasSuffix(text, chosen.text) {
			t.Fatal("sync tail is not the rune-aligned transcript suffix")
		}
		if chosen.window.TotalLines != 2 || chosen.window.FirstLine != 2 || chosen.window.TailFirstLine != 2 {
			t.Fatalf("window = %#v, want the overlong second line", chosen.window)
		}
	})
}

func TestTranscriptCountsExternalAppends(t *testing.T) {
	paths := windowTestPaths(t)
	written, err := openTranscript(paths)
	if err != nil {
		t.Fatal(err)
	}
	defer written.Close()

	// A create failure path appends without holding the transcript; the monitor's
	// next checkpoint must still carry the true line count.
	if err := written.Append(strings.Repeat("a\n", IndexLineStride)); err != nil {
		t.Fatal(err)
	}
	appendPrivateFile(paths.Filtered, []byte("external\n"))
	if err := written.Append("after\n"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(paths.Filtered)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != strings.Repeat("a\n", IndexLineStride)+"external\nafter\n" {
		t.Fatalf("transcript = %q", data)
	}
	index := openLineIndex(paths.Index)
	if index == nil || index.records == 0 {
		t.Fatal("no checkpoint was written for the stride")
	}
	last, ok := index.record(index.records - 1)
	index.Close()
	if !ok {
		t.Fatal("the last checkpoint record is unreadable")
	}
	if last.bytes != int64(len(strings.Repeat("a\n", IndexLineStride)))+int64(len("external\n")) {
		t.Fatalf("checkpoint at byte %d does not include the external append", last.bytes)
	}
	if last.newlines != int64(IndexLineStride)+1 {
		t.Fatalf("checkpoint counts %d newlines, want %d", last.newlines, IndexLineStride+1)
	}
	log := openOutputLog(paths)
	defer log.Close()
	if got := log.lineAt(last.bytes); got != last.newlines+1 {
		t.Fatalf("lineAt(checkpoint) = %d, want %d", got, last.newlines+1)
	}
}

func TestDeliveriesConsumeOnceAndStatusNeverMovesTheCursor(t *testing.T) {
	paths := windowTestPaths(t)
	text, _ := numberedLines(300)
	writeFilteredLog(t, paths, text)
	state := taskState{ID: "job_00c0ffee", Status: StatusCompleted, CreatedAt: 1}

	first := unreadResult(paths, state)
	if first.Cursor != int64(len(text)) || first.Output != text || first.Truncated {
		t.Fatalf("unread delivery = %#v", first)
	}
	if readCursor(paths) != int64(len(text)) {
		t.Fatal("a delivery did not advance the shared cursor to EOF")
	}
	if second := unreadResult(paths, state); second.Output != "" || second.Truncated || second.Cursor != first.Cursor {
		t.Fatalf("second delivery repeated output: %#v", second)
	}
	if status := statusResult(paths, state); status.Output != "" || status.Cursor != first.Cursor || status.Truncated {
		t.Fatalf("status result = %#v", status)
	}
	if replay := resultOf(paths, state, 0); replay.Output != text || readCursor(paths) != first.Cursor {
		t.Fatal("a replay changed the shared cursor")
	}
}
