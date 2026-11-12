// seams.go: explicit, unimplemented boundaries for runtime capabilities the
// TypeScript sources get from Node/JS that have no direct Go-stdlib equivalent
// (or whose exact semantics must be reproduced deliberately). This is the
// TRANSLATION stage: translated modules reference these names so their call sites
// stay traceable to the .ts source; every body here is a TODO to be implemented
// in the LANGUAGE-ADAPTATION stage. Nothing here is a behavioral default or a
// fallback — an unimplemented seam panics, it does not silently succeed.
package asyncshell

// ---- node:string_decoder ----

// StringDecoder is the seam for Node's new StringDecoder("utf8").
type StringDecoder struct {
	encoding string
}

// NewStringDecoder is TODO(language-adaptation): construct a UTF-8 StringDecoder.
func NewStringDecoder(encoding string) *StringDecoder {
	panic("TODO(language-adaptation): node:string_decoder StringDecoder")
}

// Write is TODO(language-adaptation): Node StringDecoder.write(Buffer) -> string,
// holding back an incomplete trailing multibyte sequence across calls.
func (d *StringDecoder) Write(chunk []byte) string {
	panic("TODO(language-adaptation): StringDecoder.write")
}

// ---- Buffer / process / fs / path / os / crypto / child_process seams ----
// (Declared as used by the translated modules; implemented during adaptation.)

// BufferByteLength is TS Buffer.byteLength(value, encoding).
func BufferByteLength(value string, encoding string) int {
	panic("TODO(language-adaptation): Buffer.byteLength")
}

// ProcessArgv is process.argv.
func ProcessArgv() []string { panic("TODO(language-adaptation): process.argv") }

// ProcessExecPath is process.execPath.
func ProcessExecPath() string { panic("TODO(language-adaptation): process.execPath") }

// ProcessExecArgv is process.execArgv.
func ProcessExecArgv() []string { panic("TODO(language-adaptation): process.execArgv") }

// ProcessEnv is process.env.
func ProcessEnv() map[string]string { panic("TODO(language-adaptation): process.env") }

// ProcessPlatform is process.platform.
func ProcessPlatform() string { panic("TODO(language-adaptation): process.platform") }

// ProcessGetuid is process.getuid?.().
func ProcessGetuid() int { panic("TODO(language-adaptation): process.getuid") }

// ProcessPid is process.pid.
func ProcessPid() int { panic("TODO(language-adaptation): process.pid") }

// ProcessCwd is process.cwd().
func ProcessCwd() string { panic("TODO(language-adaptation): process.cwd") }

// ProcessStdoutWrite is process.stdout.write(text).
func ProcessStdoutWrite(text string) { panic("TODO(language-adaptation): process.stdout.write") }

// ProcessStderrWrite is process.stderr.write(text).
func ProcessStderrWrite(text string) { panic("TODO(language-adaptation): process.stderr.write") }

// ProcessExit is process.exit(code).
func ProcessExit(code int) { panic("TODO(language-adaptation): process.exit") }

// OsTmpdir is os.tmpdir().
func OsTmpdir() string { panic("TODO(language-adaptation): os.tmpdir") }

// RandomBytes is crypto.randomBytes(size).
func RandomBytes(size int) []byte { panic("TODO(language-adaptation): crypto.randomBytes") }

// FileOptions is the subset of fs write/append options used (mode).
type FileOptions struct {
	Mode *uint32
}

// MkdirOptions is fs mkdir options (recursive, mode).
type MkdirOptions struct {
	Recursive bool
	Mode      *uint32
}

// Stat is the fs stat subset the sources read.
type Stat struct {
	Size    int64
	IsDir   bool
	IsFile  bool
	IsLink  bool
	Mode    uint32
	Uid     int
	Dev     uint64
	Ino     uint64
}

// FsReadFileSync is fs.readFileSync(path, "utf8") decoded as a string.
func FsReadFileSync(path string) string { panic("TODO(language-adaptation): fs.readFileSync") }

// FsReadFileBytesSync is fs.readFileSync(path) returning raw bytes.
func FsReadFileBytesSync(path string) []byte { panic("TODO(language-adaptation): fs.readFileSync(bytes)") }

// FsWriteFileSync is fs.writeFileSync(path, data, options).
func FsWriteFileSync(path string, data []byte, options *FileOptions) {
	panic("TODO(language-adaptation): fs.writeFileSync")
}

// FsAppendFileSync is fs.appendFileSync(path, data, options).
func FsAppendFileSync(path string, data []byte, options *FileOptions) {
	panic("TODO(language-adaptation): fs.appendFileSync")
}

// FsExistsSync is fs.existsSync(path).
func FsExistsSync(path string) bool { panic("TODO(language-adaptation): fs.existsSync") }

// FsLstatSync is fs.lstatSync(path) (follows no symlink).
func FsLstatSync(path string) Stat { panic("TODO(language-adaptation): fs.lstatSync") }

// FsStatSync is fs.statSync(path).
func FsStatSync(path string) Stat { panic("TODO(language-adaptation): fs.statSync") }

// FsMkdirSync is fs.mkdirSync(path, options).
func FsMkdirSync(path string, options *MkdirOptions) { panic("TODO(language-adaptation): fs.mkdirSync") }

// FsRenameSync is fs.renameSync(from, to).
func FsRenameSync(from string, to string) { panic("TODO(language-adaptation): fs.renameSync") }

// FsRealpathSync is fs.realpathSync(path).
func FsRealpathSync(path string) string { panic("TODO(language-adaptation): fs.realpathSync") }

// FsOpenSync is fs.openSync(path, flags); returns a handle.
func FsOpenSync(path string, flags string) int { panic("TODO(language-adaptation): fs.openSync") }

// FsFstatSync is fs.fstatSync(handle).
func FsFstatSync(handle int) Stat { panic("TODO(language-adaptation): fs.fstatSync") }

// FsReadSync is fs.readSync(handle, buffer, offset, length, position).
func FsReadSync(handle int, buffer []byte, offset int, length int, position int64) int {
	panic("TODO(language-adaptation): fs.readSync")
}

// FsCloseSync is fs.closeSync(handle).
func FsCloseSync(handle int) { panic("TODO(language-adaptation): fs.closeSync") }

// PathResolve is path.resolve(...parts).
func PathResolve(parts ...string) string { panic("TODO(language-adaptation): path.resolve") }

// PathJoin is path.join(...parts).
func PathJoin(parts ...string) string { panic("TODO(language-adaptation): path.join") }

// PathDirname is path.dirname(value).
func PathDirname(value string) string { panic("TODO(language-adaptation): path.dirname") }

// PathBasename is path.basename(value).
func PathBasename(value string) string { panic("TODO(language-adaptation): path.basename") }

// PathExtname is path.extname(value).
func PathExtname(value string) string { panic("TODO(language-adaptation): path.extname") }

// Win32PathResolve is path.win32.resolve(...parts).
func Win32PathResolve(parts ...string) string { panic("TODO(language-adaptation): path.win32.resolve") }

// Win32PathJoin is path.win32.join(...parts).
func Win32PathJoin(parts ...string) string { panic("TODO(language-adaptation): path.win32.join") }

// Win32PathDirname is path.win32.dirname(value).
func Win32PathDirname(value string) string { panic("TODO(language-adaptation): path.win32.dirname") }

// Win32PathBasename is path.win32.basename(value).
func Win32PathBasename(value string) string { panic("TODO(language-adaptation): path.win32.basename") }

// Win32PathExtname is path.win32.extname(value).
func Win32PathExtname(value string) string { panic("TODO(language-adaptation): path.win32.extname") }

// SpawnOptions is the spawnSync options subset used.
type SpawnOptions struct {
	Encoding             *string
	TimeoutMs            *int
	Input                *string
	WindowsHide          bool
	Env                  map[string]string
	WindowsVerbatimArgs  bool
}

// SpawnResult is the spawnSync result subset used.
type SpawnResult struct {
	Status *int
	Stdout string
	Stderr string
	Error  error
	Pid    int
}

// SpawnSync is child_process.spawnSync(command, args, options).
func SpawnSync(command string, args []string, options *SpawnOptions) SpawnResult {
	panic("TODO(language-adaptation): child_process.spawnSync")
}

// ProcessStdinRead is reading all of process.stdin up to maxBytes (TS readStdin).
// It returns a sentinel error (code input_too_large) when the bound is exceeded.
func ProcessStdinRead(maxBytes int) (string, error) {
	panic("TODO(language-adaptation): process.stdin bounded read")
}

// WriteSocket is src/ipc/socket.ts writeSocket(socketPath, payload): one NDJSON
// frame plus its acknowledgement. Seam because it lives in the TS IPC module.
func WriteSocket(socketPath string, payload interface{}) error {
	panic("TODO(language-adaptation): ipc writeSocket")
}

// EnsurePrivateDirectory is src/ipc/endpoint.ts ensurePrivateDirectory(directory).
func EnsurePrivateDirectory(directory string) error {
	panic("TODO(language-adaptation): ipc ensurePrivateDirectory")
}

// SamePath is src/fs-path.ts samePath(left, right, platform = process.platform).
func SamePath(left string, right string) bool {
	panic("TODO(language-adaptation): fs-path samePath")
}
