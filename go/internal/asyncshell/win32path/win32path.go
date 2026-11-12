package win32path

import (
	"os"
	"strings"
)

// seam_win32.go implements the path.win32 dialect used to stay platform-neutral.
// Windows backslash/absolute semantics are reproduced for translation fidelity.

func win32IsSep(c byte) bool { return c == '/' || c == '\\' }

// Basename is path.win32.basename.
func Basename(value string) string {
	trimmed := strings.TrimRight(value, "/\\")
	if trimmed == "" {
		return ""
	}
	if index := strings.LastIndexAny(trimmed, "/\\"); index >= 0 {
		return trimmed[index+1:]
	}
	return trimmed
}

// Extname is path.win32.extname.
func Extname(value string) string {
	base := Basename(value)
	if base == "." || base == ".." {
		return ""
	}
	dot := strings.LastIndexByte(base, '.')
	if dot <= 0 {
		return ""
	}
	return base[dot:]
}

// Dirname is path.win32.dirname.
func Dirname(value string) string {
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

// Join is path.win32.join.
func Join(parts ...string) string {
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

// Resolve is path.win32.resolve.
func Resolve(parts ...string) string {
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
