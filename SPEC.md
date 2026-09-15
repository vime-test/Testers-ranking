# Testers Ranking — build spec

A drag-and-drop rating tool. The user drags named pixel-art avatars from a side tray onto the
floors of a cutaway building, then exports the result as a single PNG image.

The metaphor is the rating: the vault is the compliment, the sewer is the insult.

---

## 1. Stack and file layout

Vanilla HTML + CSS + JavaScript. No framework, no build step, no dependencies. The app must run by
opening `index.html` directly in a browser (`file://`) as well as from a static server.

```
index.html
styles.css
app.js
assets/
  background.png        1024 x 1024 pixel-art building cutaway (supplied by the user)
  background-data.js     assets/background.png re-encoded as a data: URI (generated, see below)
  items/                 the site's built-in avatar library — see "Default library" in section 5
    <name>.png, ...       the avatar images themselves
    manifest.json          hand-maintained list of filenames in this folder (generated, see below)
    layout.json             saved room for each one — same format section 5 "Folder sync" writes
```

Use ES modules only if the app is served over http. Since `file://` must work, keep `app.js` a
single classic script — no `import`/`export`, no `type="module"`.

**Load the background from `background-data.js`, not from `assets/background.png` directly.**
Drawing an `<img>` loaded from a separate `file://` resource into a canvas taints it — even from the
same folder — and a tainted canvas throws on `canvas.toBlob()` ("Tainted canvases may not be
exported"), which breaks both Export PNG and Copy PNG under `file://`. This surfaced for real: Copy
PNG shipped first, failed silently, and the console log that pinned it down was a `SecurityError`
from `toBlob`. A `data:` URI has no separate origin to taint with, so `background-data.js` — a
classic script loaded before `app.js` — embeds `assets/background.png` as a global
`BACKGROUND_DATA_URL` constant, and `app.js` uses that instead of an `<img src>` file reference.
Uploaded avatars were never affected: they already go through `FileReader.readAsDataURL`, which
produces a `data:` URL directly, never a `file://` src.

The trade-off: replacing the building art means regenerating `background-data.js` from the new
`assets/background.png` (base64-encode it, wrap it in the `var BACKGROUND_DATA_URL = "data:image/
png;base64,...";` declaration), not just dropping in a new file. `assets/background.png` itself stays
in the repo as the canonical source image and for anyone reading the file layout to know what the
embedded data actually is — the app just never loads it directly.

**Two independent write-back paths target `assets/items/layout.json`.** Folder sync (section 5)
writes it via the local File System Access API when a folder is connected. "Save to GitHub" (also
section 5) writes the same file via the GitHub REST API, directly from the browser, when the deployer
has configured their own repo:
```js
var GITHUB_OWNER = "";          // e.g. "vime-test" — deployer fills in for their own fork
var GITHUB_REPO = "";           // e.g. "Testers-ranking"
var GITHUB_BRANCH = "main";     // must match whichever branch GitHub Pages actually deploys from
```
Left blank (the shipped default), the whole GitHub-save feature stays hidden — same
feature-detect-and-hide pattern `FILE_SYSTEM_SUPPORTED` already uses for folder sync. A `GITHUB_BRANCH`
that doesn't match the branch Pages actually serves would silently write to a branch nobody's
deploying — worth checking when configuring a fork. These two write-back paths are unrelated
transports triggered differently (auto-on-drop locally, manual click for GitHub) and don't
coordinate with each other — see "GitHub save" in section 5 for the full story.

---

## 2. The canvas grid

The background image contains four stacked floors of equal height inside a building, surrounded by a
**border frame** holding the sky above and the soil below. The grid must align with the room
interiors, not with the image edges, so the grid is defined as an inset rectangle — the *playfield* —
rather than as the whole image.

The frame is **not** the same thickness on every side for the supplied artwork — the soil under the
Sewer floor is noticeably thinner than the sky/wall border everywhere else — so the inset and the
cell size are each split into a horizontal and a vertical figure rather than one shared number:

```js
const BG_SIZE = 1024;  // background image is BG_SIZE x BG_SIZE

const INSET_LEFT   = 96;
const INSET_RIGHT  = 96;
const INSET_TOP    = 96;
const INSET_BOTTOM = 64;  // thinner — measure per artwork, don't assume symmetry

const PLAYFIELD_W = BG_SIZE - INSET_LEFT - INSET_RIGHT;   // 832
const PLAYFIELD_H = BG_SIZE - INSET_TOP  - INSET_BOTTOM;  // 864

const ROWS = 4, SLOTS = 4;
const CELL_W = PLAYFIELD_W / SLOTS;  // 208
const CELL_H = PLAYFIELD_H / ROWS;   // 216
```

These are the only place the geometry is written down. If the final artwork changes, open it once,
measure where each side's interior wall starts (don't assume the four sides match), and update the
insets and `BG_SIZE` — nothing else in the code should need touching. Do not hardcode 1024, 208,
216, or 96 anywhere else.

Cells end up 208 x 216 — close to square but not quite, and that's fine; the point is that all
sixteen are identical rectangles that line up with the room interiors, not that they're perfect
squares.

The ground line sits on the boundary between row 2 and row 3, at `INSET_TOP + 3 * CELL_H` (744).
Rows 0–2 are above ground; row 3 is the underground sewer. This matters only for artwork alignment —
the code treats all four rows identically.

Overlay a **4 x 4 grid** of `CELL_W x CELL_H` cells over the playfield.

| Row | Floor | Name       | Theme                         |
|-----|-------|------------|-------------------------------|
| 0   | 4     | Vault      | gold and trophies, the best   |
| 1   | 3     | Office     | high-tech workspace           |
| 2   | 2     | Dorm       | beds, the sleepers            |
| 3   | 1     | Sewer      | underground, the worst ones   |

Row 0 is the top of the image. Each row holds exactly **4 slots**, left to right, index 0–3.

A placement is stored as `{ row, slot }` — never as pixel coordinates. Pixels are derived:

```
cellX = INSET_LEFT + slot * CELL_W
cellY = INSET_TOP  + row  * CELL_H
```

Pointer position converts back the same way, and a pointer landing on the exterior wall falls
outside the playfield and is not a valid drop target:

```js
const col = Math.floor((px - INSET_LEFT) / CELL_W);
const row = Math.floor((py - INSET_TOP) / CELL_H);
const inside = col >= 0 && col < SLOTS && row >= 0 && row < ROWS;
```

This keeps the data resolution-independent, so the canvas can be displayed at any size and the
export always renders at the full `BG_SIZE`.

### Cell composition

The avatar box and label baseline were originally specified against a 256px square reference cell:
avatar 160 x 160 with its top edge 30px down, label baseline at 232px, label max width 240px. Since
the real cell is 208 x 216 — a different size, and not square — scale each reference number against
whichever axis it belongs to, rather than hardcoding the scaled result:

```js
const CELL_REFERENCE = 256;      // the cell size the four numbers above were authored for
const SCALE_X = CELL_W / CELL_REFERENCE;
const SCALE_Y = CELL_H / CELL_REFERENCE;
```

- Avatar image: a square box, `160 * SCALE_X` per side (130), horizontally centered, top edge at
  `30 * SCALE_Y` (25) from the cell top. It's sized off `SCALE_X` — not some mix of both axes — so
  the sprite is never stretched off-square.
- Name label: centered, baseline at `232 * SCALE_Y` (196) from the cell top, so it sits clear of the
  floor beam below it. Max width `240 * SCALE_X` (195), font size `26 * SCALE_X` (21).
- Name text longer than the cell width is truncated with an ellipsis at render time and shown in
  full on hover in the DOM version.

Keep the avatar and the label inside the cell bounds. Nothing overlaps a neighbouring cell.

If the artwork is replaced and the measured `CELL_W`/`CELL_H` change, every number above rescales
automatically — nothing here should need touching by hand.

---

## 3. Data model

```js
const state = {
  title: "Testers Ranking",
  items: [
    {
      id: "itm_3",            // unique, generated
      name: "Steve",
      src: "data:image/png;base64,...",  // data URL from the uploaded file
      image: HTMLImageElement,           // decoded, kept in memory for canvas export
      placement: null,                   // or { row: 0, slot: 2 }
      fileName: "Steve.png"              // or null — see "Folder sync" below
    }
  ]
};
```

`placement === null` means the item lives in the left tray. Every item is either in the tray or in
exactly one grid cell. A cell holds at most one item.

`fileName` is the name of the backing file in the connected folder, if any (see section 5). It's
`null` for items that were added while no folder was connected.

Board placement for folder-backed items is also mirrored to `layout.json` on disk (section 5,
"Board layout") — but that file is never part of in-memory `state`; it's read once, on connect, to
seed `placement`.

"Save to GitHub" (section 5) reads `fileName`/`placement` off the very same `state.items` too — it's
the same identity, just written to a different destination (the repo, via the GitHub API, on a manual
click) than folder sync's local-disk `layout.json`. No new field on the item shape for this.

---

## 4. Layout

```
+------------------------+------------------------------------------+
|  Testers Ranking       |                                          |
|  [ Add image ]         |   +----+----+----+----+                  |
|  [ Connect folder... ] |   |    |    |    |    |   Vault          |
|  [ Connect GitHub... ] |   +----+----+----+----+                  |
|                        |   |    |    |    |    |   Office         |
|  +------+ +------+     |   +----+----+----+----+                  |
|  | img  | | img  |     |   |    |    |    |    |   Dorm           |
|  | name | | name |     |   +----+----+----+----+                  |
|  +------+ +------+     |   |    |    |    |    |   Sewer          |
|  +------+              |   +----+----+----+----+                  |
|  | img  |              |                                          |
|  | name |              |                                          |
|  +------+              |                                          |
|      (scrolls)         |                                          |
|                        |                                          |
|  [ Copy PNG ]          |                                          |
|  [ Export PNG ]        |                                          |
|  [ Save to GitHub ]    |                                          |
+------------------------+------------------------------------------+
```

**Left tray** — fixed 300px wide, full viewport height, three regions:

- Header (pinned): the title, an "Add image" button, and two independent connection controls beneath
  it — folder sync and GitHub save — each hidden until its own precondition is met (browser support
  for folder sync, `GITHUB_OWNER`/`GITHUB_REPO` configured for GitHub save; see section 5).
- Body (scrolls): a 2-column grid of unplaced items, each an avatar with its name underneath.
- Footer (pinned): "Copy PNG", "Export PNG", then "Save to GitHub" (hidden until connected), all
  full width — see section 6 for the first two, section 5 "GitHub save" for the third.

**Right stage** — fills the remaining space, centers the canvas, and scales it to
`min(availableWidth, availableHeight)` while keeping it square. The canvas is displayed at whatever
size fits; the underlying coordinate system stays `BG_SIZE x BG_SIZE`.

The whole app fits the viewport with no page scrolling. Only the tray body scrolls.

---

## 5. Interactions

### Dragging

Do **not** use the HTML5 drag-and-drop API. It is unreliable, ugly to style, and has no touch
support. Use **pointer events** (`pointerdown` / `pointermove` / `pointerup` with
`setPointerCapture`).

On `pointerdown` over an item:

1. Record the pointer offset within the item so the grab point stays under the cursor.
2. Create a floating ghost element (`position: fixed`, `pointer-events: none`, high z-index)
   following the pointer.
3. Mark the source — tray item or grid cell — as visually vacated.
4. Only begin the drag after the pointer has moved more than 4px, so a click isn't a drag.

While dragging, hit-test the pointer against the canvas rect, convert to grid coordinates, and
highlight the cell under the pointer. If the pointer is outside the canvas, show the tray as the
highlighted target instead.

### Drop rules

| From  | To            | Result                                            |
|-------|---------------|---------------------------------------------------|
| Tray  | Empty cell    | Item is placed there.                             |
| Tray  | Occupied cell | Occupant returns to the tray; new item takes it.   |
| Cell  | Empty cell    | Item moves.                                       |
| Cell  | Occupied cell | The two items swap places.                        |
| Cell  | Tray          | Item returns to the tray.                         |
| Any   | Outside both  | Nothing changes; the item snaps back.             |

Snapping is implicit — a drop resolves to a whole cell, never a pixel position, so an item can never
land half in and half out of a slot.

### Adding images

"Add image" opens a dialog (use the native `<dialog>` element):

- A file input accepting `image/*`, `multiple` allowed.
- For each selected file, a row appears with a small preview and a name field, pre-filled with the
  filename minus its extension.
- "Add to tray" commits them all. Cancel discards.

Read files with `FileReader.readAsDataURL`, then decode into an `Image` object and wait for `onload`
before adding to state — the export path needs a decoded image, not a pending one.

### Removing

Each tray item has a small remove control, visible on hover or focus. Removing an item deletes it
from state entirely (and its backing file, if it has one — see below). Placed items must be dragged
back to the tray before they can be removed.

### Default library

On load, always try to populate the board from `assets/items/` — the avatar set shipped with the
site itself — before anything else runs. This is what makes a hosted deployment (GitHub Pages, etc.)
show something on first visit: "Connect folder" only works in Chrome/Edge, and only for a folder on
*that visitor's own machine*, so it can't be how a public page shows a curated set to everyone.

`fetch(DEFAULT_LIBRARY_DIR + "manifest.json")` for the file list, then `fetch()` each image and
`layout.json` for their saved rooms — same reading logic as folder sync below, just sourced from
plain HTTP instead of a `FileSystemDirectoryHandle`. Skip any filename already represented in state
(so this can't double-add against a locally-connected copy of the same folder), and run it *before*
folder sync's own auto-resume attempt, so that dedup has something to check against rather than the
two racing each other.

Works in every browser — no File System Access API involved, just `fetch()` and `<img>`. Under
`file://` specifically, `fetch()` to a local file is blocked, so this silently does nothing there;
Connect Folder (below) remains how to work with this same folder locally.

`assets/items/manifest.json` is a plain JSON array of filenames. There's no way to ask a static file
host to list a directory's contents, so — like `background-data.js` — this has to be regenerated by
hand whenever a file is added to or removed from `assets/items/`. `layout.json` can't substitute for
it: that file only records *placed* items, so an avatar left sitting in the tray wouldn't be in it.

### Folder sync

The tray's contents don't survive a page reload on their own beyond the default library above —
there's no server and no database, so persisting *changes* (not just the shipped default) means
writing real files to a real folder on disk, via the **File System
Access API** (`showDirectoryPicker`). This is Chrome/Edge only; feature-detect it and hide the
control entirely in browsers that don't support it (Firefox, Safari). The app must stay fully usable
without it — connecting a folder is an enhancement, not a requirement.

**Connecting.** A "Connect folder…" button sits below "Add image" (hidden if unsupported). Clicking
it opens the native folder picker. The chosen folder's handle is stored in IndexedDB so it can be
looked up again on a later visit — browsers never allow silently reading a folder with no user
interaction at all, so a returning visit still needs one click to reconfirm access, but not a full
re-pick:

- No stored handle yet → button reads "Connect folder…" → opens the picker.
- A stored handle whose permission hasn't been reconfirmed this session → button reads "Reconnect
  "‹name›"" → calls `requestPermission()` on the existing handle (no picker dialog).
- Permission already granted (either just now, or because the browser remembered it) → button shows
  "Folder: ‹name›"; the tray loads automatically. Clicking it again opens a fresh picker to switch
  folders.

**Writing.** Every image added via the dialog is also written into the connected folder (if any) as
its original bytes, named from the typed name plus the original file's extension — this is what
`fileName` in the data model records. A name collision (two items writing the same filename) gets a
" (2)", " (3)", ... suffix; state keeps whatever duplicate names the user typed (section 8), only the
files on disk need to stay unique. Items already in the tray when a folder is first connected get
written out too, so nothing already added is left behind.

**Reading.** Once a folder is connected (fresh pick, or a successful reconnect), every image file in
it that isn't already represented in state becomes a new tray item: name = filename minus extension,
`fileName` = the real filename. This is how the tray repopulates itself on a later visit.

**Deleting.** Removing a tray item also deletes its backing file from the connected folder, if it has
one. Best-effort — a file that's already missing (moved or deleted outside the app) doesn't block
removing the item from state.

**Board layout.** Every drop that changes what's on the board writes the current room of every
placed, folder-backed avatar to `layout.json` in the connected folder —
`{ "version": 1, "placements": { "‹fileName›": { "row": 0, "slot": 0 } } }`. Writes are serialized
(one in flight at a time, each reading current state when it actually runs, not a snapshot taken when
it was queued) so a burst of rapid drops can't land out of order. Reconnecting a folder (fresh pick,
resumed session, or reconnect) reads it back and restores each avatar to its saved room before the
first render, so there's no flash of an empty board that then jumps. Best-effort, like the rest of
folder sync: a missing or unreadable file just means nothing gets restored, not an error — though a
read that fails (as opposed to the file simply not existing yet) also suspends writes for the rest of
the session, so a transient failure can't cause a good file to be silently overwritten with a smaller
one. `layout.json` is a reserved filename inside the connected folder — it's never picked up as an
avatar (only recognized image extensions are).

**Scope note.** Folder sync restores both the *avatar library* (which images exist) and the *board
layout* (which room each one was standing in) — see "Board layout" above. Both require an actively
connected folder to persist *changes*; the shipped default library above survives a reload on its own
with no folder connected, but anything added, moved, or removed beyond that shipped state does not,
unless a folder is connected to write it to. See section 10.

### GitHub save

Folder sync (above) persists changes to a folder on the *editor's own local machine* — useless for
the site **owner** wanting to rearrange avatars directly on the *live, hosted* page with no local dev
environment involved at all. Since the site has no backend, that means the browser itself calling the
GitHub REST API directly, which needs a credential — see section 1 for the `GITHUB_OWNER`/
`GITHUB_REPO`/`GITHUB_BRANCH` constants that gate the whole feature.

**Manual trigger, not automatic on every drop** — the one deliberate difference from folder sync's
`writeLayoutFile()` above. Every GitHub Contents API write creates a real commit in the repo's
permanent history; auto-saving on every drag would spam that history with one commit per drop.
Batching everything into one click when the owner explicitly presses "Save to GitHub" avoids that.

**Scope: rearrangement only.** Saves the same `buildPlacementsMap()` output folder sync's "Board
layout" writes, just to a different destination — existing shipped avatars only. Does not add or
upload new avatar images, does not touch `manifest.json`, and never reads GitHub state back into the
board — write-only. (Items added via the "Add images" dialog on a page with no local folder connected
don't get a `fileName` at all, so they're already excluded from what gets saved, same as they are for
folder sync.)

**Auth.** A fine-grained GitHub personal access token, scoped to just this one repo, "Contents: Read
and write" permission only — the owner creates and pastes it in themselves via a "Connect GitHub…"
dialog (parallel to "Connect folder…" and to the Add-images dialog), with an expiration set (the
dialog's own copy recommends this — costs nothing, meaningfully bounds exposure if it ever leaks).
Stored in `localStorage` under a namespaced key, never committed, sent only to `api.github.com`. The
dialog states plainly: anyone with access to that browser's storage — including any installed
extension with broad permissions, not just someone physically at the device — can read the token back
out. This is for the owner's own trusted device, not a shared or public computer.

**Writing.** On click: `GET .../contents/assets/items/layout.json` for the current file's `sha`
(a 404 here isn't an error — it just means the file doesn't exist yet, so the `sha` is omitted from
the next step and GitHub creates it), then `PUT` the same path with the new content, that `sha` (when
one exists), and a fixed commit message. The `sha` is always fetched fresh immediately before writing
— never reused from an earlier page load — to avoid a stale-`sha` conflict later.

**Conflict handling.** A `409` (something else changed the file between the GET and the PUT — in
practice, most plausibly a second open tab) fails with a clear "Changed on GitHub" message rather than
silently re-fetching and overwriting: that would discard whatever changed it with no diff shown to
anyone. A human deciding is the safer default for a personal, single-owner tool.

**Button feedback**, same flash-then-revert pattern Copy PNG uses: "Saving…" while in flight (button
disabled, no auto-revert), "Saved!" on success, and on failure a specific, honest label rather than
one generic "Save failed" for everything the cause can actually distinguish — "Bad token" (401, which
also reverts the Connect button back to "Connect GitHub…" rather than continuing to claim
"connected" while every subsequent save would fail the same way), "No permission" or "Rate limited"
(both are HTTP 403 from GitHub; told apart by the `x-ratelimit-remaining` response header), "Changed
on GitHub" (409), or "Save failed" (network/CORS failure, or anything not otherwise distinguishable).

**Independent from folder sync.** These are two unrelated write-back paths to the same file —
different transport (GitHub API vs. local File System Access API), different trigger (manual vs.
auto-on-drop) — that happen not to coordinate with each other. An owner using both in the same session
(a local folder connected *and* a GitHub token configured) gets exactly what each does independently:
every drop still auto-saves to the local folder as before, and "Save to GitHub" remains a separate,
explicit action that only fires on click. Nothing here assumes the two stay in sync with each other.

---

## 6. Export

Both "Copy PNG" and "Export PNG" render to the same offscreen `<canvas>`, at exactly
`BG_SIZE x BG_SIZE`, via one shared render step:

1. `ctx.imageSmoothingEnabled = false` — **critical**. These are pixel-art sprites; smoothing turns
   them to mush.
2. Draw the background (`BACKGROUND_DATA_URL`, not `assets/background.png` directly — see section 1)
   at 0, 0, BG_SIZE, BG_SIZE.
3. For each placed item, draw the avatar and its name using the cell composition from section 2.

They differ only in what happens to the rendered canvas next:

- **Export PNG** — `canvas.toBlob(...)` → object URL → trigger a download named
  `testers-ranking-<yyyy-mm-dd>.png`.
- **Copy PNG** — call `navigator.clipboard.write()` **synchronously** inside the click handler, before
  the blob exists yet — pass it a pending `Promise<Blob>` (`new ClipboardItem({'image/png':
  blobPromise})`) rather than waiting to call `write()` until the blob is in hand. Calling it late
  (e.g. from inside `canvas.toBlob`'s own callback) falls outside the browser's user-activation
  window for the click, and has been observed to hang indefinitely rather than reject when that
  happens — this is a real trap, not a hypothetical one. Feature-detect `navigator.clipboard`/
  `ClipboardItem` first. Disable the button while a write is in flight, so a second click can't start
  an overlapping one. Race the write against a ~3s timeout as a last-resort safety net against a hang.
  On success, flash the button label ("Copied!"); on any failure (unsupported, rejected, or timed
  out), flash "Copy failed" and stop there — **no fallback to downloading.** Export PNG is a separate,
  explicit action; a failed copy silently producing a download looks exactly like a successful copy
  if you're only watching the clipboard, which defeats the point of failure feedback at all.

The tray is not part of either output. Only the building and the placed items.

Draw the name text with a pixel-appropriate font, a solid dark outline or drop shadow behind it, so
it stays readable over both the bright gold floor and the dark sewer floor. Minecraft's own
convention — white text with a hard black offset shadow at 1–2px down-right — fits the subject and
works on every background.

---

## 7. Visual direction

The building artwork is the only image in the product, so let it carry the whole personality. The
interface around it should be quiet enough to look like a display case for it.

- **Palette.** Chrome in deep neutral stone tones so the pixel art reads as the brightest thing on
  screen. Pull one accent from the artwork itself — the vault gold — and use it for exactly one
  purpose: the active drop target. Nothing else on screen should be gold, so the highlight is never
  ambiguous. Avoid cyan and magenta in the interface chrome; the office floor already owns those,
  and a matching accent would get lost against it.
- **Pixels.** `image-rendering: pixelated` on every avatar and on the background. No border-radius
  on avatars, no soft shadows under them. A blurred or rounded sprite breaks the illusion instantly.
- **Grid affordance.** Cell boundaries stay invisible while idle — the building should look like a
  picture, not a spreadsheet. They appear only during a drag, and only as much as needed to show
  where the item will land.
- **Motion.** One place only: the settle when an item lands in a cell. No entrance animations, no
  hover transitions on every element.
- **Type.** One family for the interface. The sprite labels are their own thing and should look like
  they belong to the game, not to the toolbar.
- **Empty tray.** When everything is placed, the tray body says so and points at the export button.
  Treat it as the finish line, not an error.

Accessibility floor: visible keyboard focus rings, `prefers-reduced-motion` respected, buttons are
real `<button>` elements, the file dialog is reachable by keyboard.

---

## 8. Edge cases to handle

- Non-square uploaded images: fit inside the avatar box preserving aspect ratio, centered.
- Very long names: truncate visually, keep the full string in state and in the `title` attribute.
- Duplicate names: allowed in state. IDs are what matter — a folder-synced duplicate gets a
  disambiguated filename on disk (section 5), but the name shown in the UI is untouched.
- `BACKGROUND_DATA_URL` missing or empty (background-data.js didn't load, or wasn't generated yet):
  show a plain placeholder grid with the floor names, and a message saying the background image is
  not in place yet. The app must still be usable. Don't fall back to loading `assets/background.png`
  directly in this case — that would reintroduce the canvas-tainting problem section 1 describes.
- Dragging off the window edge and releasing: treat as a cancelled drag.
- Releasing over the border frame — the sky, the soil, or the outer wall — is outside the playfield,
  so treat it as a cancelled drag, not as a drop into the nearest cell.
- Rapid double "Add image" clicks: don't open two dialogs.
- Folder sync unsupported (Firefox, Safari, or any browser without `showDirectoryPicker`): hide the
  control entirely rather than showing something broken.
- Folder picker cancelled, or permission declined on reconnect: no error, no state change — the
  button just stays in (or returns to) its previous state.
- Writing or deleting a file fails (permissions revoked mid-session, disk error, file removed outside
  the app): log a warning, don't block the state change the user asked for.
- `layout.json` missing, unreadable, or containing invalid/out-of-range cell data: treat as "nothing
  to restore," not an error — never block the tray/board from rendering.
- Two entries in `layout.json` claim the same cell (e.g. a hand-edited file): the first one
  encountered wins; the rest stay in the tray.
- `GITHUB_OWNER`/`GITHUB_REPO` left blank: the entire GitHub-save feature — connect row and Save
  button both — stays hidden. Save is never clickable without a configured token; there's no path
  where the button is visible but silently does nothing.
- GitHub save fails: 401 (bad/expired token — also reverts the Connect button so there's a path back
  to reconnecting, rather than continuing to claim "connected" while every save keeps failing), 403
  permission-denied vs. 403 rate-limited (both the same HTTP status from GitHub; distinguished via the
  `x-ratelimit-remaining` response header), 409 (something else changed the file between the read and
  the write — fail with a clear message, don't auto-retry and silently overwrite it), or a
  network/CORS failure. Each gets its own honest label on the button, not one generic failure message.
- `GITHUB_BRANCH` doesn't match the branch GitHub Pages actually deploys from for a given fork: writes
  would silently land somewhere nobody's serving. Nothing detects this automatically — it's on the
  deployer to get right when configuring their fork.

---

## 9. Done when

- [ ] Four floors, four slots each, visible only during a drag.
- [ ] Cells line up with the room interiors, not the image edges — nothing lands on the wall, and
      this holds independently on all four sides even if the border frame isn't uniform.
- [ ] An item can go tray → cell, cell → cell, cell → tray.
- [ ] Dropping onto an occupied cell swaps the two items.
- [ ] Items always land centered in a cell, never between cells.
- [ ] Adding an image with a name works, including several at once.
- [ ] Export produces a `BG_SIZE x BG_SIZE` (1024 x 1024) PNG with crisp, unsmoothed pixels and
      readable names.
- [ ] The exported file matches what is on screen.
- [ ] Copy PNG puts the same image on the clipboard; where the Clipboard API is unsupported or a
      write hangs/fails, the button visibly says so ("Copy failed") rather than hanging or silently
      doing something else — no fallback download.
- [ ] Neither Export PNG nor Copy PNG ever hits "Tainted canvases may not be exported" — verified
      specifically under `file://`, not just a local server.
- [ ] Works from `file://` with no server and no console errors.
- [ ] Window resizing keeps the canvas square and the placements correct.
- [ ] Connecting a folder (Chrome/Edge) writes added images there and deletes removed ones.
- [ ] Reopening the app and reconnecting the same folder repopulates the tray from its files.
- [ ] Reopening the app and reconnecting the same folder also restores which room each avatar was
      standing in, with no visible flash of an empty board first.
- [ ] The app is fully usable in a browser without File System Access support — the folder control
      simply isn't shown.
- [ ] Opening the site fresh — no folder connected, no prior session — shows the built-in
      `assets/items/` library already in its saved rooms, in every major browser, not just Chrome/Edge.
- [ ] With `GITHUB_OWNER`/`GITHUB_REPO` configured, the owner can connect a repo-scoped fine-grained
      token, click "Save to GitHub", and see the resulting commit land in their repo's history.
- [ ] GitHub-save failure causes are distinguishable on the button itself (bad token, no permission,
      rate limited, conflict, generic failure), not just visible in the console.

---

## 10. Not in scope for v1

More or fewer floors, custom floor names, more than 4 slots per floor, sharing links, undo.

**Persisting changes requires either a connected folder or a configured GitHub token** — the shipped
default library (section 5, "Default library") survives a reload with neither, but anything you
change beyond that shipped state needs one of the two write-back paths (section 5, "Board layout" /
"GitHub save") to land anywhere, or it's gone on reload. Switching to a *different* folder mid-session
(clicking "Folder: …" again while already connected) isn't specifically handled beyond what section 5
already describes — items from the previous folder stay in state until removed.

**GitHub save is deliberately narrow.** No adding or uploading new avatar images through it, no
`manifest.json` updates, no reading GitHub's state back into the board (write-only), no OAuth flow, no
backend or proxy of any kind — a pasted personal access token calling `api.github.com` directly is the
whole mechanism. Rearranging the existing shipped avatars and pressing Save is the entire feature.

Keep the data model clean enough that slot and floor counts, and the geometry constants in section 2,
are constants at the top of `app.js` rather than numbers scattered through the code.
