package asyncshell

import "testing"

func TestIsTaskID(t *testing.T) {
	valid := []string{"job_00000000", "job_abcdef12", "job_3f8a1c2d"}
	for _, value := range valid {
		if !IsTaskID(value) {
			t.Errorf("IsTaskID(%q) = false, want true", value)
		}
	}
	invalid := []string{
		"", "job_", "job_1234567", "job_123456789", "job_ABCDEF12",
		"job_gggggggg", "xjob_12345678", "job_12345678x",
	}
	for _, value := range invalid {
		if IsTaskID(value) {
			t.Errorf("IsTaskID(%q) = true, want false", value)
		}
	}
}
