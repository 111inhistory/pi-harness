package asyncshell

import "regexp"

// task-id.ts translates src/async-shell/task-id.ts.
//
// Public task handles are compact names; execution authority is a separate token.

var taskIDPattern = regexp.MustCompile(`^job_[0-9a-f]{8}$`)

// IsTaskID reports whether value has the public task-id form (TS: isTaskId).
func IsTaskID(value string) bool {
	return taskIDPattern.MatchString(value)
}
