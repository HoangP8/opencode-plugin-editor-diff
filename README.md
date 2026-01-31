# opencode-plugin-editor-diff

[![npm](https://img.shields.io/npm/v/@hoangp8/opencode-plugin-editor-diff)](https://www.npmjs.com/package/@hoangp8/opencode-plugin-editor-diff)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A temporary workaround using `.tmp` backups to show visual diffs in your editor after file edits.

## Setup

`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  // Pin version for faster startup
  "plugin": ["@hoangp8/opencode-plugin-editor-diff@0.0.4"]
}
```

## Configuration

`~/.config/opencode/diff.jsonc`:

```jsonc
{
  "editor": "code",
  "os": "linux"
}
```

- **editor**: `code` | `cursor` | `antigravity` | `windsurf` (default: `code`)
- **os**: `windows` | `linux` (default: `linux`)

## Note

1. Editor diffs only show when edits are done (approved or auto-allowed), otherwise diffs appear in TUI only.
2. I suggest enabling auto-edit, then you see the change, type `/undo` to revert, or feedback for further edits.
