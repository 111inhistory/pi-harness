package proc

// ChildCommand is the command a pane executes. Verbatim means cmd.exe needs
// the prepared line as-is.
type ChildCommand struct {
	File     string
	Args     []string
	Verbatim bool
}
