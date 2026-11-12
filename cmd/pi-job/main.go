package main

import (
	"os"

	"pijob/internal/asyncshell"
)

func main() {
	os.Exit(asyncshell.Main(os.Args))
}
