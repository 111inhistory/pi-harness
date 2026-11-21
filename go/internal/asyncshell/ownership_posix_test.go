//go:build !windows

package asyncshell

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"

	"pijob/internal/asyncshell/aserr"
	shellbackend "pijob/internal/asyncshell/backend"
)

type fakeBackend struct {
	state   shellbackend.ServerState
	pid     int
	owns    bool
	kills   int
	onState func()
	onOwns  func()
}

func (f *fakeBackend) Kind() string     { return "fake" }
func (f *fakeBackend) AssertAvailable() {}
func (f *fakeBackend) Run(string, []string, *string) shellbackend.CommandResult {
	return shellbackend.CommandResult{}
}
func (f *fakeBackend) RunOk(string, []string, string, *string) shellbackend.CommandResult {
	return shellbackend.CommandResult{}
}
func (f *fakeBackend) KillServer(string) error {
	f.kills++
	f.state = shellbackend.ServerSuspect
	return nil
}
func (f *fakeBackend) KillServerWithin(string, int) error {
	f.kills++
	f.state = shellbackend.ServerSuspect
	return nil
}
func (f *fakeBackend) ServerState(string, int) (shellbackend.ServerState, error) {
	if f.onState != nil {
		f.onState()
	}
	return f.state, nil
}
func (f *fakeBackend) ServerPid(string) (int, error)                { return f.pid, nil }
func (f *fakeBackend) Start(string, []string, string, func() error) {}
func (f *fakeBackend) SendInput(string, string)                     {}
func (f *fakeBackend) SendKey(string, string)                       {}
func (f *fakeBackend) PaneGone(string) bool                         { return true }
func (f *fakeBackend) OwnsProcess(int, string, string) bool         { return f.owns }
func (f *fakeBackend) OwnsProcessWithin(int, string, string, int) bool {
	if f.onOwns != nil {
		f.onOwns()
	}
	return f.owns
}

func installFake(t *testing.T, state shellbackend.ServerState) *fakeBackend {
	t.Helper()
	fake := &fakeBackend{state: state, pid: 1 << 30, owns: true}
	previous := backend
	backend = fake
	t.Cleanup(func() { backend = previous })
	return fake
}

// taskRoot creates the private async-shell root for one test. t.TempDir embeds
// the full test and subtest name, which pushed <root>/<id>/tmux.sock past the
// 104-byte macOS sockaddr_un limit and made bind fail with EINVAL. A short
// prefix under the system temp directory keeps the socket path inside the
// limit; RemoveAll still runs deterministically at test cleanup.
func taskRoot(t *testing.T) string {
	t.Helper()
	root, err := os.MkdirTemp("", "pijob-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Errorf("remove test root %s: %v", root, err)
		}
	})
	return root
}

func taskFixture(t *testing.T) (root, dir string, record *ownershipRecord) {
	t.Helper()
	root = taskRoot(t)
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PI_ASYNC_SHELL_ROOT", root)
	id := "job_1234abcd"
	created, identity, err := createOwnedDirectory(root, id)
	if err != nil {
		t.Fatal(err)
	}
	paths := taskPaths(created)
	writeJSONAtomic(paths.Task, taskFile{ID: id, Argv: []string{"true"}, Cwd: root, CreatedAt: 1, WaitMs: 1})
	if err := recordDirectoryOwnership(root, created, identity); err != nil {
		t.Fatal(err)
	}
	// These fixtures represent a task whose startup gate has completed.
	writePrivateFile(paths.Started, nil)
	record, err = readOwnership(root, id)
	if err != nil {
		t.Fatal(err)
	}
	return root, created, record
}

func listenUnix(t *testing.T, path string) *net.UnixListener {
	t.Helper()
	address := &net.UnixAddr{Name: path, Net: "unix"}
	listener, err := net.ListenUnix("unix", address)
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	return listener
}

func bindFixtureSocket(t *testing.T, root, dir string) *net.UnixListener {
	t.Helper()
	listener := listenUnix(t, filepath.Join(dir, taskSocketName))
	record, err := readOwnership(root, filepath.Base(dir))
	if err != nil {
		t.Fatal(err)
	}
	identity, err := socketIdentity(filepath.Join(dir, taskSocketName))
	if err != nil {
		t.Fatal(err)
	}
	record.Socket = &identity
	record.Bind = bindBound
	record.ServerPid = 1 << 30
	if err := writeOwnership(root, *record); err != nil {
		t.Fatal(err)
	}
	return listener
}

func assertCode(t *testing.T, err error, code string) {
	t.Helper()
	if aserr.Code(err) != code {
		t.Fatalf("error = %v (code %q), want %q", err, aserr.Code(err), code)
	}
}

func TestReleaseRemovesOwnedDeadSocket(t *testing.T) {
	root, dir, _ := taskFixture(t)
	listener := bindFixtureSocket(t, root, dir)
	listener.SetUnlinkOnClose(false)
	_ = listener.Close()
	fake := installFake(t, shellbackend.ServerSuspect)
	if err := releaseTaskBackend(dir); err != nil {
		t.Fatal(err)
	}
	if fake.kills != 0 {
		t.Fatalf("kill calls = %d, want 0", fake.kills)
	}
	if _, err := os.Lstat(filepath.Join(dir, taskSocketName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("owned dead socket still exists: %v", err)
	}
	if record, err := readOwnership(root, filepath.Base(dir)); err != nil || !record.Cleaned {
		t.Fatalf("cleaned fact = %#v, %v", record, err)
	}
}

func TestReleaseLeavesLiveSocketAndStopsOwnedServer(t *testing.T) {
	root, dir, _ := taskFixture(t)
	listener := bindFixtureSocket(t, root, dir)
	defer listener.Close()
	fake := installFake(t, shellbackend.ServerRunning)
	if err := releaseTaskBackend(dir); err != nil {
		t.Fatal(err)
	}
	if fake.kills != 1 {
		t.Fatalf("kill calls = %d, want 1", fake.kills)
	}
	if _, err := os.Lstat(filepath.Join(dir, taskSocketName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("recorded socket was not removed: %v", err)
	}
}

func TestReleaseLeavesReplacedLiveSocket(t *testing.T) {
	root, dir, _ := taskFixture(t)
	first := bindFixtureSocket(t, root, dir)
	first.SetUnlinkOnClose(false)
	_ = first.Close()
	if err := os.Remove(filepath.Join(dir, taskSocketName)); err != nil {
		t.Fatal(err)
	}
	foreign := listenUnix(t, filepath.Join(dir, taskSocketName))
	defer foreign.Close()
	fake := installFake(t, shellbackend.ServerRunning)
	err := releaseTaskBackend(dir)
	assertCode(t, err, "socket_unknown")
	if fake.kills != 0 {
		t.Fatalf("foreign live server was killed: %d", fake.kills)
	}
	if _, err := os.Lstat(filepath.Join(dir, taskSocketName)); err != nil {
		t.Fatalf("foreign live socket was removed: %v", err)
	}
}

func TestReleaseLeavesReplacedDeadInode(t *testing.T) {
	root, dir, _ := taskFixture(t)
	first := bindFixtureSocket(t, root, dir)
	first.SetUnlinkOnClose(false)
	_ = first.Close()
	_ = os.Remove(filepath.Join(dir, taskSocketName))
	foreign := listenUnix(t, filepath.Join(dir, taskSocketName))
	foreign.SetUnlinkOnClose(false)
	_ = foreign.Close()
	fake := installFake(t, shellbackend.ServerSuspect)
	err := releaseTaskBackend(dir)
	assertCode(t, err, "socket_unknown")
	if fake.kills != 0 {
		t.Fatalf("kill calls = %d, want 0", fake.kills)
	}
	if _, err := os.Lstat(filepath.Join(dir, taskSocketName)); err != nil {
		t.Fatalf("replacement dead inode was removed: %v", err)
	}
}

func TestReleaseLeavesSwappedDirectory(t *testing.T) {
	root, dir, _ := taskFixture(t)
	old := dir + ".old"
	if err := os.Rename(dir, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	paths := taskPaths(dir)
	writeJSONAtomic(paths.Task, taskFile{ID: filepath.Base(dir), Argv: []string{"true"}, Cwd: root, CreatedAt: 1, WaitMs: 1})
	listener := listenUnix(t, filepath.Join(dir, taskSocketName))
	defer listener.Close()
	fake := installFake(t, shellbackend.ServerRunning)
	err := releaseTaskBackend(dir)
	assertCode(t, err, "ownership_unknown")
	if fake.kills != 0 {
		t.Fatalf("swapped directory server was killed: %d", fake.kills)
	}
	if _, err := os.Lstat(filepath.Join(dir, taskSocketName)); err != nil {
		t.Fatalf("swapped directory socket was removed: %v", err)
	}
}

func TestReleaseUnknownWithoutSidecarOrBind(t *testing.T) {
	root, dir, _ := taskFixture(t)
	listener := bindFixtureSocket(t, root, dir)
	defer listener.Close()
	if err := os.Remove(ownershipPath(root, filepath.Base(dir))); err != nil {
		t.Fatal(err)
	}
	fake := installFake(t, shellbackend.ServerRunning)
	err := releaseTaskBackend(dir)
	assertCode(t, err, "ownership_unknown")
	if fake.kills != 0 {
		t.Fatalf("kill calls = %d, want 0", fake.kills)
	}
}

func TestReleaseDoesNotAdoptObservedSocketOnUnknownBind(t *testing.T) {
	root, dir, record := taskFixture(t)
	listener := listenUnix(t, filepath.Join(dir, taskSocketName))
	defer listener.Close()
	identity, err := socketIdentity(filepath.Join(dir, taskSocketName))
	if err != nil {
		t.Fatal(err)
	}
	record.Socket = &identity
	record.Bind = bindUnknown
	if err := writeOwnership(root, *record); err != nil {
		t.Fatal(err)
	}
	fake := installFake(t, shellbackend.ServerRunning)
	err = releaseTaskBackend(dir)
	assertCode(t, err, "socket_unknown")
	if fake.kills != 0 {
		t.Fatalf("observed socket was adopted: %d", fake.kills)
	}
}

func TestReleaseMissingCapturedSocketResumesAfterUnlink(t *testing.T) {
	root, dir, _ := taskFixture(t)
	listener := bindFixtureSocket(t, root, dir)
	listener.SetUnlinkOnClose(false)
	_ = listener.Close()
	if err := os.Remove(filepath.Join(dir, taskSocketName)); err != nil {
		t.Fatal(err)
	}
	fake := installFake(t, shellbackend.ServerMissing)
	if err := releaseTaskBackend(dir); err != nil {
		t.Fatal(err)
	}
	if fake.kills != 0 {
		t.Fatalf("kill calls = %d, want 0", fake.kills)
	}
	record, err := readOwnership(root, filepath.Base(dir))
	if err != nil || !record.Cleaned {
		t.Fatalf("missing+exited release did not mark cleaned: %#v %v", record, err)
	}
}

func TestReleaseMissingCapturedSocketRequiresProvenExit(t *testing.T) {
	for _, test := range []struct {
		name string
		pid  int
		owns bool
	}{
		{name: "live pid", pid: os.Getpid(), owns: true},
		{name: "uninspectable pid", pid: os.Getpid(), owns: false},
		{name: "no pid", pid: 0, owns: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			root, dir, record := taskFixture(t)
			listener := bindFixtureSocket(t, root, dir)
			listener.SetUnlinkOnClose(false)
			_ = listener.Close()
			if err := os.Remove(filepath.Join(dir, taskSocketName)); err != nil {
				t.Fatal(err)
			}
			record, err := readOwnership(root, filepath.Base(dir))
			if err != nil {
				t.Fatal(err)
			}
			record.ServerPid = test.pid
			if err := writeOwnership(root, *record); err != nil {
				t.Fatal(err)
			}
			fake := installFake(t, shellbackend.ServerMissing)
			fake.owns = test.owns
			err = releaseTaskBackend(dir)
			assertCode(t, err, "socket_unknown")
			if fake.kills != 0 {
				t.Fatalf("missing socket killed: %d", fake.kills)
			}
			if record, readErr := readOwnership(root, filepath.Base(dir)); readErr != nil || record.Cleaned {
				t.Fatalf("missing socket marked cleaned without proven exit: %#v %v", record, readErr)
			}
		})
	}
}

func TestReleaseCleanedIsIdempotentButNeverHidesReplacement(t *testing.T) {
	root, dir, record := taskFixture(t)
	record.Cleaned = true
	if err := writeOwnership(root, *record); err != nil {
		t.Fatal(err)
	}
	fake := installFake(t, shellbackend.ServerRunning)
	if err := releaseTaskBackend(dir); err != nil {
		t.Fatal(err)
	}
	if fake.kills != 0 {
		t.Fatalf("cleaned release killed: %d", fake.kills)
	}
	listener := listenUnix(t, filepath.Join(dir, taskSocketName))
	defer listener.Close()
	err := releaseTaskBackend(dir)
	assertCode(t, err, "socket_unknown")
	if fake.kills != 0 {
		t.Fatalf("cleaned replacement was killed: %d", fake.kills)
	}
	if _, err := os.Lstat(filepath.Join(dir, taskSocketName)); err != nil {
		t.Fatalf("cleaned replacement was removed: %v", err)
	}
}

func TestCancelClosedCleansOwnedDeadSocketIdempotently(t *testing.T) {
	root, dir, _ := taskFixture(t)
	listener := bindFixtureSocket(t, root, dir)
	listener.SetUnlinkOnClose(false)
	_ = listener.Close()
	writePrivateFile(taskPaths(dir).Closed, nil)
	fake := installFake(t, shellbackend.ServerSuspect)
	if err := CancelTask(dir, root); err != nil {
		t.Fatal(err)
	}
	if fake.kills != 0 {
		t.Fatalf("closed cancel killed: %d", fake.kills)
	}
	if _, err := os.Lstat(filepath.Join(dir, taskSocketName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("closed cancel left the socket: %v", err)
	}
	if err := CancelTask(dir, root); err != nil {
		t.Fatalf("second cancel is not idempotent: %v", err)
	}
}

func TestCancelUnknownDoesNotWriteClosed(t *testing.T) {
	root, dir, record := taskFixture(t)
	listener := listenUnix(t, filepath.Join(dir, taskSocketName))
	defer listener.Close()
	record.Bind = bindUnknown
	if err := writeOwnership(root, *record); err != nil {
		t.Fatal(err)
	}
	installFake(t, shellbackend.ServerRunning)
	err := CancelTask(dir, root)
	assertCode(t, err, "cancel_incomplete")
	if _, statErr := os.Lstat(taskPaths(dir).Closed); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("unknown cancel wrote closed: %v", statErr)
	}
	if _, statErr := os.Lstat(filepath.Join(dir, taskSocketName)); statErr != nil {
		t.Fatalf("unknown cancel removed the socket: %v", statErr)
	}
}

func TestReleaseControlUnknownKeepsLease(t *testing.T) {
	root, dir, _ := taskFixture(t)
	listener := bindFixtureSocket(t, root, dir)
	defer listener.Close()
	fake := installFake(t, shellbackend.ServerUnknown)
	err := releaseTaskBackend(dir)
	assertCode(t, err, "socket_unknown")
	if fake.kills != 0 {
		t.Fatalf("unknown control killed: %d", fake.kills)
	}
	if record, readErr := readOwnership(root, filepath.Base(dir)); readErr != nil || record.Cleaned {
		t.Fatalf("unknown control wrote cleaned: %#v %v", record, readErr)
	}
}

func TestReleaseBindNoneCleanMarksCleaned(t *testing.T) {
	root, dir, _ := taskFixture(t)
	installFake(t, shellbackend.ServerRunning)
	if err := releaseTaskBackend(dir); err != nil {
		t.Fatal(err)
	}
	record, err := readOwnership(root, filepath.Base(dir))
	if err != nil || !record.Cleaned {
		t.Fatalf("clean no-bind release = %#v, %v", record, err)
	}
}

func TestPartialStartCapturesBoundIdentity(t *testing.T) {
	root, dir, _ := taskFixture(t)
	listener := listenUnix(t, filepath.Join(dir, taskSocketName))
	defer listener.Close()
	installFake(t, shellbackend.ServerRunning)
	if err := recordBoundOwnership(root, dir); err != nil {
		t.Fatal(err)
	}
	record, err := readOwnership(root, filepath.Base(dir))
	if err != nil {
		t.Fatal(err)
	}
	if record.Bind != bindBound || record.Socket == nil || record.ServerPid == 0 {
		t.Fatalf("bound identity = %#v", record)
	}
	identity, err := socketIdentity(filepath.Join(dir, taskSocketName))
	if err != nil || identity.Dev != record.Socket.Dev || identity.Ino != record.Socket.Ino {
		t.Fatalf("socket identity not captured at bind: %#v %v", identity, err)
	}
}

func TestReleaseLeavesSocketSymlinkAndRegularFile(t *testing.T) {
	for _, replacement := range []string{"symlink", "regular"} {
		t.Run(replacement, func(t *testing.T) {
			root, dir, _ := taskFixture(t)
			listener := bindFixtureSocket(t, root, dir)
			listener.SetUnlinkOnClose(false)
			_ = listener.Close()
			socket := filepath.Join(dir, taskSocketName)
			if err := os.Remove(socket); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(root, "foreign-target")
			if replacement == "symlink" {
				if err := os.WriteFile(target, []byte("foreign"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, socket); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.WriteFile(socket, []byte("foreign"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			fake := installFake(t, shellbackend.ServerRunning)
			err := releaseTaskBackend(dir)
			assertCode(t, err, "socket_unknown")
			if fake.kills != 0 {
				t.Fatalf("foreign replacement was killed: %d", fake.kills)
			}
			if _, statErr := os.Lstat(socket); statErr != nil {
				t.Fatalf("foreign replacement was removed: %v", statErr)
			}
			if replacement == "symlink" {
				if _, statErr := os.Lstat(target); statErr != nil {
					t.Fatalf("symlink target was removed: %v", statErr)
				}
			}
		})
	}
}

func TestReleaseLeavesSymlinkedTaskDirectory(t *testing.T) {
	_, dir, _ := taskFixture(t)
	real := dir + ".real"
	if err := os.Rename(dir, real); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, dir); err != nil {
		t.Fatal(err)
	}
	fake := installFake(t, shellbackend.ServerRunning)
	err := releaseTaskBackend(dir)
	assertCode(t, err, "ownership_unknown")
	if fake.kills != 0 {
		t.Fatalf("symlinked task directory was killed: %d", fake.kills)
	}
}

func TestCancelClosedResumesMissingSocketAfterUnlink(t *testing.T) {
	root, dir, _ := taskFixture(t)
	listener := bindFixtureSocket(t, root, dir)
	listener.SetUnlinkOnClose(false)
	_ = listener.Close()
	if err := os.Remove(filepath.Join(dir, taskSocketName)); err != nil {
		t.Fatal(err)
	}
	fake := installFake(t, shellbackend.ServerMissing)
	if err := CancelTask(dir, root); err != nil {
		t.Fatal(err)
	}
	if fake.kills != 0 {
		t.Fatalf("missing socket cancel killed: %d", fake.kills)
	}
	if _, err := os.Lstat(taskPaths(dir).Closed); err != nil {
		t.Fatalf("missing socket cancel did not close: %v", err)
	}
	record, err := readOwnership(root, filepath.Base(dir))
	if err != nil || !record.Cleaned {
		t.Fatalf("missing socket cancel did not mark cleaned: %#v %v", record, err)
	}
}

func TestReleaseMissingReappearedEntryIsLeft(t *testing.T) {
	root, dir, _ := taskFixture(t)
	listener := bindFixtureSocket(t, root, dir)
	listener.SetUnlinkOnClose(false)
	_ = listener.Close()
	socket := filepath.Join(dir, taskSocketName)
	if err := os.Remove(socket); err != nil {
		t.Fatal(err)
	}
	fake := installFake(t, shellbackend.ServerMissing)
	var once sync.Once
	fake.onState = func() {
		once.Do(func() {
			if err := os.WriteFile(socket, []byte("foreign"), 0o600); err != nil {
				t.Errorf("create replacement: %v", err)
			}
		})
	}
	err := releaseTaskBackend(dir)
	assertCode(t, err, "socket_unknown")
	if fake.kills != 0 {
		t.Fatalf("reappeared entry was killed: %d", fake.kills)
	}
	if _, statErr := os.Lstat(socket); statErr != nil {
		t.Fatalf("reappeared entry was removed: %v", statErr)
	}
	if record, readErr := readOwnership(root, filepath.Base(dir)); readErr != nil || record.Cleaned {
		t.Fatalf("reappeared entry was marked cleaned: %#v %v", record, readErr)
	}
}

func TestCancelRejectsSwappedTaskDirectoryBeforeMonitorSignal(t *testing.T) {
	root, dir, _ := taskFixture(t)
	listener := bindFixtureSocket(t, root, dir)
	defer listener.Close()
	monitor := exec.Command("sleep", "30")
	if err := monitor.Start(); err != nil {
		t.Skipf("cannot start monitor fixture: %v", err)
	}
	defer func() {
		_ = monitor.Process.Kill()
		_, _ = monitor.Process.Wait()
	}()
	if err := os.WriteFile(taskPaths(dir).MonitorPid, []byte(strconv.Itoa(monitor.Process.Pid)), 0o600); err != nil {
		t.Fatal(err)
	}
	real := dir + ".real"
	if err := os.Rename(dir, real); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, dir); err != nil {
		t.Fatal(err)
	}
	err := CancelTask(dir, root)
	assertCode(t, err, "cancel_incomplete")
	if err := monitor.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("swapped directory signalled the monitor: %v", err)
	}
	if _, statErr := os.Lstat(taskPaths(dir).Closed); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("swapped directory cancel wrote closed: %v", statErr)
	}
}

func TestCancelRevalidatesTaskDirectoryAfterOwnershipBeforeSignal(t *testing.T) {
	root, dir, _ := taskFixture(t)
	listener := bindFixtureSocket(t, root, dir)
	defer listener.Close()
	monitor := exec.Command("sleep", "30")
	if err := monitor.Start(); err != nil {
		t.Skipf("cannot start monitor fixture: %v", err)
	}
	defer func() {
		_ = monitor.Process.Kill()
		_, _ = monitor.Process.Wait()
	}()
	if err := os.WriteFile(taskPaths(dir).MonitorPid, []byte(strconv.Itoa(monitor.Process.Pid)), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := installFake(t, shellbackend.ServerMissing)
	real := dir + ".real"
	var once sync.Once
	swapped := false
	fake.onOwns = func() {
		once.Do(func() {
			swapped = true
			if err := os.Rename(dir, real); err != nil {
				t.Errorf("replace task directory: %v", err)
				return
			}
			if err := os.Symlink(real, dir); err != nil {
				t.Errorf("link replacement task directory: %v", err)
			}
		})
	}
	err := CancelTask(dir, root)
	assertCode(t, err, "cancel_incomplete")
	if !swapped {
		t.Fatal("fake ownership hook did not replace the task directory")
	}
	if signalErr := monitor.Process.Signal(syscall.Signal(0)); signalErr != nil {
		t.Fatalf("monitor was signalled after ownership replacement: %v", signalErr)
	}
	stateOutput, stateErr := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(monitor.Process.Pid)).Output()
	if stateErr != nil {
		t.Fatalf("cannot inspect monitor state: %v", stateErr)
	}
	monitorState := strings.TrimSpace(string(stateOutput))
	if monitorState == "" || strings.HasPrefix(monitorState, "Z") {
		t.Fatalf("monitor was killed/zombied by the pre-signal path: state %q", monitorState)
	}
	if _, statErr := os.Lstat(taskPaths(dir).Closed); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("ownership replacement wrote closed: %v", statErr)
	}
}
