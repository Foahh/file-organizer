# fortify

Sorts a Downloads (or similar) folder by extension into category folders, and optionally moves duplicate files aside. Dry-run by default — nothing moves until you `apply`. Use `undo` to reverse the last apply.

## Install

```bash
# From this repo
bun link

# Or build a standalone binary
bun run build   # → dist/fortify (+ dist/rules.toml)
```

Then install the user config (copies `rules.toml` into your config dir):

```bash
fortify install              # config only
fortify install --every 1h   # config + hourly schedule
```

## Quick start

```bash
fortify -d ./Downloads       # preview (default)
fortify apply -d ./Downloads # move files
fortify undo -d ./Downloads  # reverse last apply
fortify --help
```

Default target is `~/Downloads` if it exists. After `install`, the saved directory is used when you omit `-d`.

## Schedule

```bash
fortify install -d ~/Downloads --every 1h
fortify schedule --every 6h
fortify status
fortify unschedule
fortify uninstall
```

| Interval | Meaning |
|----------|---------|
| `30m` | every 30 minutes |
| `1h` / `hourly` | every hour |
| `6h` | every 6 hours |
| `1d` / `daily` | every day at 09:00 |

Scheduled runs call `apply` and append to the log in the config dir:

- Windows: `%APPDATA%\fortify\`
- macOS / Linux: `~/.config/fortify/`

Uses Task Scheduler on Windows, crontab elsewhere.

## Options

| Flag | Description |
|------|-------------|
| `-d, --directory <path>` | Target directory |
| `-c, --config <path>` | Rules file (installed rules, else `./rules.toml`) |
| `--every <interval>` | For `install` / `schedule` |
| `--no-sort-files` | Skip sorting into category folders |
| `--no-move-duplicates` | Skip MD5 duplicate detection |
| `--no-remove-empty-folders` | Skip pruning empty category folders |

## How it works

1. **Sort** — Named matchers run first (basename globs), then extension mapping from `rules.toml`. Unknown extensions go to `Others/`.
2. **Duplicates** — Same content (MD5) moves later copies into `Duplicates/` with unique names.
3. **Empty folders** — Removes empty dirs under known category folders.

A few details that matter in practice:

- Files already under the right category stay put (`Pictures/Vacation/photo.jpg` is not flattened).
- Unknown folders are left alone — at the root (`CoolGame/`) and under categories (`Compressed/CoolGame/`). The tool only walks paths that lead to configured destinations (e.g. `Pictures/Screenshots`).
- Name collisions get a suffix (`report_1.pdf`) instead of failing.
- Extensions are case-insensitive (`.PDF` → Documents).
- `apply` writes `<target>/.fortify/last-run.json` for `undo`.

## Config

See [`rules.toml`](rules.toml) for the default extension map and ignore list.

### Named matchers (`[[rules]]`)

Optional ordered rules. First match wins; then `[mapping]` by extension.

```toml
[[rules]]
name = "installers"
match = ["*Setup*", "*setup*", "*Installer*", "*installer*"]
folder = "Programs"

[[rules]]
name = "screenshots"
match = ["*Screenshot*", "*screenshot*", "Screen Shot *"]
folder = "Pictures/Screenshots"
```

| Field | Meaning |
|-------|---------|
| `name` | Shown in dry-run as `sort[name]:` |
| `match` | Basename-only globs (case-sensitive as written) |
| `folder` | Destination under the target; may be nested |

Omit `[[rules]]` to use extension mapping only.

### Extension mapping (`[mapping]`)

Maps extensions to category folders. The `ignore` list covers incomplete downloads, OS junk, and `Duplicates/`.
