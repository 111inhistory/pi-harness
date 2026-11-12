package asyncshell

import (
	"os"
	"strings"
)

// seam_win32.go implements the path.win32 dialect used to stay platform-neutral.
// Windows backslash/absolute semantics are reproduced for translation fidelity.

func win32IsSep(c byte) bool { return c == '/' || c == '\\' }

// Win32PathBasename is path.win32.basename.
func Win32PathBasename(value string) string {
	trimmed := strings.TrimRight(value, "/\\")
	if trimmed == "" {
		return ""
	}
	if index := strings.LastIndexAny(trimmed, "/\\"); index >= 0 {
		return trimmed[index+1:]
	}
	return trimmed
}

// Win32PathExtname is path.win32.extname.
func Win32PathExtname(value string) string {
	base := Win32PathBasename(value)
	if base == "." || base == ".." {
		return ""
	}
	dot := strings.LastIndexByte(base, '.')
	if dot <= 0 {
		return ""
	}
	return base[dot:]
}

// Win32PathDirname is path.win32.dirname.
func Win32PathDirname(value string) string {
	trimmed := strings.TrimRight(value, "/\\")
	if trimmed == "" {
		if value == "" {
			return "."
		}
		return string(value[0])
	}
	index := strings.LastIndexAny(trimmed, "/\\")
	if index < 0 {
		return "."
	}
	parent := trimmed[:index]
	if parent == "" {
		return string(trimmed[0])
	}
	if len(parent) == 2 && parent[1] == ':' {
		return parent + "\\"
	}
	return parent
}

// Win32PathJoin is path.win32.join.
func Win32PathJoin(parts ...string) string {
	nonEmpty := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			nonEmpty = append(nonEmpty, part)
		}
	}
	if len(nonEmpty) == 0 {
		return "."
	}
	return win32Normalize(strings.Join(nonEmpty, "\\"))
}

// Win32PathResolve is path.win32.resolve.
func Win32PathResolve(parts ...string) string {
	absolute := ""
	for _, part := range parts {
		if part == "" {
			continue
		}
		if win32IsAbsolute(part) {
			absolute = part
		} else if absolute == "" {
			absolute = part
		} else {
			absolute = absolute + "\\" + part
		}
	}
	if !win32IsAbsolute(absolute) {
		cwd, err := os.Getwd()
		if err != nil {
			cwd = "."
		}
		absolute = strings.ReplaceAll(cwd, "/", "\\") + "\\" + absolute
	}
	return win32Normalize(absolute)
}

func win32IsAbsolute(value string) bool {
	if strings.HasPrefix(value, "\\\\") {
		return true
	}
	if len(value) >= 3 && value[1] == ':' && win32IsSep(value[2]) {
		return true
	}
	return len(value) >= 1 && win32IsSep(value[0])
}

func win32Normalize(value string) string {
	value = strings.ReplaceAll(value, "/", "\\")
	prefix := ""
	rest := value
	if strings.HasPrefix(rest, "\\\\") {
		prefix = "\\\\"
		rest = rest[2:]
	} else if len(rest) >= 2 && rest[1] == ':' {
		prefix = rest[:2]
		rest = rest[2:]
	} else if strings.HasPrefix(rest, "\\") {
		prefix = "\\"
		rest = rest[1:]
	}
	segments := strings.Split(rest, "\\")
	stack := make([]string, 0, len(segments))
	for _, segment := range segments {
		switch segment {
		case "", ".":
			continue
		case "..":
			if len(stack) > 0 && stack[len(stack)-1] != ".." {
				stack = stack[:len(stack)-1]
			} else if prefix == "" {
				stack = append(stack, "..")
			}
		default:
			stack = append(stack, segment)
		}
	}
	joined := strings.Join(stack, "\\")
	if prefix == "" {
		if joined == "" {
			return "."
		}
		return joined
	}
	return prefix + joined
}
