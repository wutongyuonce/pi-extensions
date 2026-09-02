**English** | [简体中文](README.zh-CN.md)

# pi-kanban0

pi-kanban0 is a project-aware Kanban board for [Pi](https://pi.dev/): a keyboard-only TUI that agents can operate, with all data stored locally in Markdown. It starts no service, creates no database, and does not require Obsidian.

![pi-kanban0 showing a project-local board with five columns](docs/images/pi-kanban0-board.png)

## Installation and development

Requires Pi `0.83.0+` and Node.js `22.19.0+`.

Install from npm:

```powershell
pi install npm:pi-kanban0
```

Uninstall:

```powershell
pi remove npm:pi-kanban0
```

Run from source:

```powershell
npm install
npm run check
pi -e .\src\index.ts
```

For local package development, use `pi install <path-to-this-repository>`.

## Native Pi workflow

Run this command from any project:

```text
/kanban
```

The extension opens a board according to these rules:

1. If the current project already has `.pi/kanban.md`, open the project board immediately.
2. Otherwise, if a global board already exists, open it immediately.
3. If neither board exists, show a keyboard-only scope menu:
   - Create a project board at `<project>/.pi/kanban.md`.
   - Create a global board in `pi-kanban0/kanban.md` under Pi's home directory.

Pi's default home directory is `~/.pi/agent`, so the default global board path is:

```text
~/.pi/agent/pi-kanban0/kanban.md
```

You can skip the scope menu explicitly:

```text
/kanban project
/kanban global
```

A new board starts with five columns: `Inbox → Todo → In Progress → Review → Done`. Project boards are useful for work tied to one repository and can either be committed to Git or added to `.gitignore`. The global board is suited to personal work that spans projects. Both live outside the extension's installation directory, so extension updates never touch board data. The panel title shows either `.pi/kanban.md` or `pi-kanban0/kanban.md`, making the active scope clear.

In addition to the TUI, the extension registers a `kanban_board` tool. You can ask Pi to:

```text
Add “Write keyboard tests for the login page” to Todo.
Move it to In Progress.
Mark “Write keyboard tests for the login page” as done.
Set its time to “2026-08-04 10:00” and add the “urgent” label.
List cards related to login on the current board.
```

The agent and TUI use the same `auto` scope resolution: prefer the project board, then fall back to the global board. The tool also accepts explicit `scope: project | global`; an explicit scope never falls through to the other board. A read-only `list` never creates a missing board, and if neither board exists the agent asks which scope to create before a write. List output includes card times and labels; pass a `column` plus `includeDetails: true` to retrieve complete card bodies in one bounded call. Completion uses an explicit `set_done` action so retries cannot accidentally toggle a card back open. If a card title or column name is ambiguous, the tool refuses to guess and asks to read the board first.

## TUI features

- An embedded multi-column panel with adaptive width and height. By default it stays compact for small boards, grows to about 34 rows for larger boards, and scrolls within each column; its height can also be fixed from 6 to 100 rows (subject to available terminal space).
- Reserved space for Pi's input and status areas so the board title stays visible. Narrow terminals automatically show fewer columns at once.
- Full action names in the footer, grouped by navigation, card, move, and board actions. When space is tight, a complete keyboard-help entry remains available instead of cryptic abbreviations.
- Browse cards, view their full contents, add, edit, delete, complete, and reopen them.
- Render up to two lines per card by default. The title, body text, time, and labels wrap naturally within the column and share a configurable 1–12-row limit; an ellipsis appears only when the fully wrapped content exceeds that limit.
- Press `y` on a selected card or in card details to copy the title and full body in one action; time and labels are omitted.
- Press `@` on a selected card to set its time, or `#` to add a custom label. Both shortcuts also work in card details.
- Reorder cards within a column or move them to an adjacent column.
- Press `c` to open one column menu for adding, renaming, moving, or deleting columns.
- Search all card text; press `1`–`9` to jump directly to frequently used columns.
- Write every change to local Markdown immediately, using an atomic temporary-file replacement in the same directory.
- Detect changes made by another editor or process before writing. On conflict, the extension stops instead of overwriting; press `r` to reload from disk.

The extension does not register mouse events. Adding and editing cards reuse Pi's built-in multiline editor, so input methods and existing Pi editing shortcuts continue to work as expected.

## Keyboard controls

The main workflow uses the arrow keys, Space, Enter, and a small set of familiar single-letter keys. Press `?` at any time for complete help.

| Action | Keys |
|---|---|
| Switch columns | `←` / `→`, `h` / `l`, `Tab` / `Shift+Tab` |
| Select a card | `↑` / `↓`, `j` / `k`, `PgUp` / `PgDn` |
| Jump to a column | `1`–`9` |
| First / last card | `Home` / `End`, `g` / `G` |
| Complete / reopen | `Space` |
| Move to adjacent column | `Shift+←` / `Shift+→`; fallback keys `[` / `]` |
| Move up / down within column | `Shift+↑` / `Shift+↓`; fallback keys `K` / `J` |
| View details | `Enter` |
| Copy the selected card title and body | `y` |
| Add / edit / delete a card | `a` / `e` / `d` |
| Set card time | `@` |
| Add a custom label | `#` |
| Manage the current column | `c`, then use Pi's keyboard selection menu |
| Display settings | `s` |
| Search | `/`; press `Esc` while searching to clear it |
| Reload from disk | `r` |
| Help / close | `?` / `q` or `Esc` |

## Display settings

Press `s` on the board to set the total board height to `auto` or an exact value from 6 to 100 rows, and to set each card's maximum display height from 1 to 12 rows including its title. The terminal's available height always remains the final cap. Board height and card rows have no direct adjustment shortcuts; change both from this settings menu.

To avoid stale terminal rows when a TUI grows or shrinks dynamically, display changes **do not resize the currently open panel**. They are saved immediately and take effect after closing the board with `q` / `Esc` and running `/kanban` again.

Display choices persist across boards in:

```text
~/.pi/agent/pi-kanban0/settings.json
```

Choose **Reset display defaults** in the `s` menu to restore automatic board height and two rows per card.

## Time and label format

`@` and `#` write metadata into the card's indented Markdown body, with no sidecar files. For example:

```markdown
- [ ] Ship the keyboard Kanban
    @{2026-08-04 10:00}
    #urgent
    #{release candidate}
    Finish Windows terminal validation
```

- Times are stored as `@{...}`. The contents can be a date and time or any custom single-line value.
- Single-word labels are stored as `#label`; labels containing spaces are stored automatically as `#{custom label}`.
- Pressing `@` again replaces the existing time. Duplicate labels are removed case-insensitively.
- After pressing `@`, `Today` is selected by default, so Enter immediately writes today's date. The menu also provides `Now`, `Tomorrow`, and `Custom time…`. All relative dates use the Pi process's local time zone.
- Times and labels are not part of the card title, so they do not affect agent title matching.

## One-time migration from existing Markdown

An old board is only a migration source, not a runtime dependency. To import an existing Markdown board, run:

```text
/kanban import "D:\path\to\legacy-board.md"
```

The extension validates the source without changing it. An existing project board is the import target; if the project has none, an existing global board is used. When neither exists, Pi shows a keyboard menu to choose a project or global destination, and `Esc` cancels. Replacing an existing target always requires confirmation. After import, the selected local file becomes the source of truth and `/kanban` is all you need.

The compatible format is intentionally simple: columns are top-level level-two headings (`## Column`), and cards are top-level Markdown tasks (`- [ ] title` or `- [x] title`). Multiline bodies and `@{time}` / `#label` metadata are indented under the Markdown task. Unrecognized YAML, code blocks, and other content are preserved as raw blocks. This supports migration from common Obsidian Kanban files, while the extension itself depends on neither Obsidian nor any legacy file path.

## Acknowledgements

Thanks to the [LINUX DO](https://linux.do/) community.
