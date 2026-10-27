#!/usr/bin/env node
// The `maximus` command. It loads the built CLI, so a workspace that installs before it builds still links
// the command, which a package manager links only to a file that exists.
import '../dist/tooling/cli.js';
