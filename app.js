/* ---------------------------------------------------------------------
   Testers Ranking
   Vanilla JS, no build step, no dependencies. Classic script (no
   import/export) so it runs from file:// as well as a static server.
--------------------------------------------------------------------- */

(function () {
  "use strict";

  // -------------------------------------------------------------
  // Constants — the only place slot/floor counts and pixel offsets
  // are allowed to appear as numbers.
  // -------------------------------------------------------------

  // The background image is a square building cutaway surrounded by a
  // border frame (sky above, soil below/beside). The grid must align
  // with the room interiors — the *playfield* — not the image edges.
  //
  // Measured directly against assets/background.png: the side walls
  // sit ~96px in from the left/right edges, and the ceiling ~96px down
  // from the top — but the bottom border (soil under the Sewer floor)
  // is noticeably thinner, only ~64px. So the border frame is NOT
  // uniform on all four sides for this artwork, and cells end up a bit
  // taller than wide rather than perfect squares — confirmed against
  // all three internal floor-beams (Vault/Office, Office/Dorm,
  // Dorm/Sewer), which land within a few px of INSET_TOP + n*CELL_H.
  // If the artwork changes, remeasure and update the four inset/size
  // constants — nothing else below should need touching.
  var BG_SIZE = 1024;      // background.png is BG_SIZE x BG_SIZE
  var INSET_LEFT = 96;
  var INSET_RIGHT = 96;
  var INSET_TOP = 96;
  var INSET_BOTTOM = 64;
  var PLAYFIELD_W = BG_SIZE - INSET_LEFT - INSET_RIGHT;
  var PLAYFIELD_H = BG_SIZE - INSET_TOP - INSET_BOTTOM;
  var ROWS = 4, SLOTS = 4;
  var CELL_W = PLAYFIELD_W / SLOTS; // 208
  var CELL_H = PLAYFIELD_H / ROWS;  // 216

  // Cell composition (avatar box, label baseline) was specified as
  // 30/160/232/240px against a 256px square reference cell. Our cells
  // are a different size — and no longer square — so scale horizontal
  // numbers (avatar width, label max-width) against CELL_W and
  // vertical ones (avatar top, label baseline) against CELL_H, each
  // keeping the same proportion of the cell the reference numbers did.
  // Everything still derives from these two factors, so a remeasured
  // CELL_W/CELL_H rescales all of it.
  var CELL_REFERENCE = 256; // the cell size the composition numbers below were authored for
  var SCALE_X = CELL_W / CELL_REFERENCE;
  var SCALE_Y = CELL_H / CELL_REFERENCE;
  function scaledX(px) { return px * SCALE_X; }
  function scaledY(px) { return px * SCALE_Y; }

  var AVATAR_SIZE = scaledX(160); // square sprite box; sized off cell width so it never distorts
  var AVATAR_TOP = scaledY(30);
  var LABEL_BASELINE = scaledY(232);
  var LABEL_MAX_WIDTH = scaledX(240);
  var LABEL_FONT_PX = Math.round(scaledX(26));
  var LABEL_FONT = "bold " + LABEL_FONT_PX + "px ui-monospace, Consolas, 'Courier New', monospace";
  var LABEL_SHADOW_OFFSET = Math.max(1, Math.round(scaledX(2)));

  var FLOOR_NAMES = ["Vault", "Office", "Dorm", "Sewer"];

  var DRAG_THRESHOLD = 4; // px before a pointerdown becomes a drag

  var IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

  // The built-in avatar library shipped with the site — see "Default
  // library" below. Its manifest.json/layout.json live here too.
  var DEFAULT_LIBRARY_DIR = "assets/items/";

  // Site owner's own GitHub repo — fill these in for your own fork to
  // enable "Save to GitHub" (see that section below). Left blank, the
  // whole feature stays hidden. GITHUB_BRANCH must match whichever
  // branch GitHub Pages actually deploys from for this repo — a
  // mismatch here silently writes to a branch nobody's serving.
  var GITHUB_OWNER = "vime-test";
  var GITHUB_REPO = "Testers-ranking";
  var GITHUB_BRANCH = "main";
  var GITHUB_TOKEN_KEY = "testers-ranking:github-token"; // namespaced — this repo gets forked
  var GITHUB_LAYOUT_PATH = DEFAULT_LIBRARY_DIR + "layout.json";
  var GITHUB_CONFIGURED = !!(GITHUB_OWNER && GITHUB_REPO);

  // -------------------------------------------------------------
  // State
  // -------------------------------------------------------------

  var state = {
    title: "Testers Ranking",
    items: [] // { id, name, src, image, placement: null | {row, slot} }
  };

  var bgReady = false;

  // -------------------------------------------------------------
  // DOM refs
  // -------------------------------------------------------------

  var trayBody = document.getElementById("trayBody");
  var trayEmptyMsg = document.getElementById("trayEmptyMsg");
  var addImageBtn = document.getElementById("addImageBtn");
  var copyBtn = document.getElementById("copyBtn");
  var exportBtn = document.getElementById("exportBtn");
  var folderRow = document.getElementById("folderRow");
  var folderBtn = document.getElementById("folderBtn");
  var githubRow = document.getElementById("githubRow");
  var githubConnectBtn = document.getElementById("githubConnectBtn");
  var saveGithubBtn = document.getElementById("saveGithubBtn");

  var stage = document.getElementById("stage");
  var canvasWrap = document.getElementById("canvasWrap");
  var building = document.getElementById("building");
  var bgImageEl = document.getElementById("bgImage");
  var bgFallbackEl = document.getElementById("bgFallback");
  var bgMissingMsgEl = document.getElementById("bgMissingMsg");
  var gridEl = document.getElementById("grid");

  var addDialog = document.getElementById("addDialog");
  var addForm = document.getElementById("addForm");
  var fileInput = document.getElementById("fileInput");
  var fileRows = document.getElementById("fileRows");
  var cancelBtn = document.getElementById("cancelBtn");
  var commitBtn = document.getElementById("commitBtn");

  var githubDialog = document.getElementById("githubDialog");
  var githubForm = document.getElementById("githubForm");
  var githubTokenInput = document.getElementById("githubTokenInput");
  var githubCancelBtn = document.getElementById("githubCancelBtn");

  var dragGhost = document.getElementById("dragGhost");
  var exportCanvas = document.getElementById("exportCanvas");
  exportCanvas.width = BG_SIZE;
  exportCanvas.height = BG_SIZE;

  // -------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------

  var idCounter = 0;
  function genId() {
    idCounter += 1;
    if (window.crypto && window.crypto.randomUUID) {
      return "itm_" + window.crypto.randomUUID();
    }
    return "itm_" + Date.now().toString(36) + "_" + idCounter;
  }

  function stripExtension(filename) {
    var idx = filename.lastIndexOf(".");
    if (idx <= 0) return filename;
    return filename.slice(0, idx);
  }

  function extensionOf(filename) {
    var m = /\.[^.]+$/.exec(filename);
    return m ? m[0] : "";
  }

  // Shared by the Add-image dialog and folder sync below — both need
  // "raw File -> data URL -> decoded Image" before an item is usable.
  function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(file);
    });
  }

  function decodeImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("Could not decode image")); };
      img.src = dataUrl;
    });
  }

  function getItem(id) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) return state.items[i];
    }
    return null;
  }

  function findItemAtCell(row, slot) {
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i];
      if (it.placement && it.placement.row === row && it.placement.slot === slot) {
        return it;
      }
    }
    return null;
  }

  // -------------------------------------------------------------
  // Background image loading (spec section 8: missing asset fallback)
  //
  // Deliberately NOT `bgImageEl.src = "assets/background.png"`. Chrome
  // taints a canvas that's had a separate file:// resource drawn into
  // it — even one loaded from the very same folder — which then throws
  // on canvas.toBlob() ("Tainted canvases may not be exported"),
  // breaking both Copy PNG and Export PNG under file://. A data: URI
  // has no separate origin to taint with, so background-data.js (a
  // classic script loaded before this one, see index.html) embeds
  // assets/background.png as BACKGROUND_DATA_URL and we use that
  // instead. Uploaded avatars already avoid this — they go through
  // FileReader.readAsDataURL, never a file:// src — so this is the one
  // remaining place it applied.
  // -------------------------------------------------------------

  bgImageEl.addEventListener("load", function () {
    bgReady = true;
    building.classList.remove("bg-missing");
    bgImageEl.hidden = false;
    bgFallbackEl.hidden = true;
    bgMissingMsgEl.hidden = true;
  });

  bgImageEl.addEventListener("error", function () {
    bgReady = false;
    building.classList.add("bg-missing");
    bgImageEl.hidden = true;
    bgFallbackEl.hidden = false;
    bgMissingMsgEl.hidden = false;
  });

  // Populate fallback floor labels from the constant so they can't drift.
  (function initFallbackLabels() {
    var floors = bgFallbackEl.querySelectorAll(".fallback-floor");
    for (var i = 0; i < floors.length; i++) {
      var row = Number(floors[i].dataset.row);
      var span = floors[i].querySelector("span");
      if (span) span.textContent = FLOOR_NAMES[row];
    }
  })();

  if (typeof BACKGROUND_DATA_URL === "string" && BACKGROUND_DATA_URL) {
    bgImageEl.src = BACKGROUND_DATA_URL;
  } else {
    // background-data.js didn't load or wasn't generated — same
    // degraded path as a missing background.png (spec section 8).
    // Deliberately not falling back to loading the plain file path
    // here: that would silently reintroduce the taint risk above.
    bgImageEl.dispatchEvent(new Event("error"));
  }

  // -------------------------------------------------------------
  // Publish the pixel-composition constants above as CSS custom
  // properties, once, so the DOM preview (styles.css) and the canvas
  // export (drawLabel/drawAvatarFit below) derive from the same
  // numbers instead of two hand-copied sets that can drift apart.
  // -------------------------------------------------------------

  function publishLayoutVars() {
    var root = document.documentElement.style;
    root.setProperty("--c-avatar-top", AVATAR_TOP + "px");
    root.setProperty("--c-avatar-size", AVATAR_SIZE + "px");
    root.setProperty("--c-label-max-width", LABEL_MAX_WIDTH + "px");
    root.setProperty("--c-label-font-size", LABEL_FONT_PX + "px");
    root.setProperty("--c-label-shadow", LABEL_SHADOW_OFFSET + "px");

    // The canvas draws text at an alphabetic baseline (LABEL_BASELINE);
    // a DOM span positions by its top edge instead. Pull the top edge
    // up by an approximate font ascent so the two line up visually.
    var ascentApprox = Math.round(LABEL_FONT_PX * 0.78);
    var labelTop = LABEL_BASELINE - AVATAR_TOP - ascentApprox;
    root.setProperty("--c-label-top", labelTop + "px");
  }
  publishLayoutVars();

  // -------------------------------------------------------------
  // Stage sizing — keep the canvas square, fit available space, and
  // publish --px-scale so CSS cell composition matches the BG_SIZE
  // export exactly.
  // -------------------------------------------------------------

  function resizeStage() {
    var rect = stage.getBoundingClientRect();
    var size = Math.floor(Math.min(rect.width, rect.height));
    if (size < 32) size = 32;
    canvasWrap.style.width = size + "px";
    canvasWrap.style.height = size + "px";
    var scale = size / BG_SIZE;
    document.documentElement.style.setProperty("--px-scale", String(scale));
  }

  window.addEventListener("resize", resizeStage);
  if (window.ResizeObserver) {
    new ResizeObserver(resizeStage).observe(stage);
  }
  resizeStage();

  // -------------------------------------------------------------
  // Grid cell scaffolding (built once; content re-rendered on state change)
  // -------------------------------------------------------------

  // #grid itself covers only the playfield — inset from the building
  // square on every side (asymmetrically — see the constants above) —
  // not the whole image, so the border frame (sky/soil/walls) never
  // counts as a cell. These are fixed ratios of the constants above,
  // so they're set once and don't need to change on resize (--px-scale
  // handles the rest).
  function positionPlayfield() {
    gridEl.style.left = (INSET_LEFT / BG_SIZE * 100) + "%";
    gridEl.style.top = (INSET_TOP / BG_SIZE * 100) + "%";
    gridEl.style.width = (PLAYFIELD_W / BG_SIZE * 100) + "%";
    gridEl.style.height = (PLAYFIELD_H / BG_SIZE * 100) + "%";
  }
  positionPlayfield();

  var cellEls = []; // [row][slot] -> element

  function buildGridCells() {
    for (var row = 0; row < ROWS; row++) {
      cellEls[row] = [];
      for (var slot = 0; slot < SLOTS; slot++) {
        var cell = document.createElement("div");
        cell.className = "cell";
        cell.dataset.row = String(row);
        cell.dataset.slot = String(slot);
        cell.style.left = (slot * 100 / SLOTS) + "%";
        cell.style.top = (row * 100 / ROWS) + "%";
        cell.style.width = (100 / SLOTS) + "%";
        cell.style.height = (100 / ROWS) + "%";
        gridEl.appendChild(cell);
        cellEls[row][slot] = cell;
      }
    }
  }
  buildGridCells();

  // -------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------

  var lastDroppedItemId = null; // gets a "settle" animation on next render

  function render() {
    renderTray();
    renderGrid();
  }

  function renderTray() {
    // Remove existing tray-item cards, keep the empty-state message node.
    var existing = trayBody.querySelectorAll(".tray-item");
    for (var i = 0; i < existing.length; i++) existing[i].remove();

    var trayItems = state.items.filter(function (it) { return it.placement === null; });

    for (var j = 0; j < trayItems.length; j++) {
      trayBody.appendChild(createTrayItemEl(trayItems[j]));
    }

    trayEmptyMsg.hidden = !(state.items.length > 0 && trayItems.length === 0);
  }

  function createTrayItemEl(item) {
    var card = document.createElement("div");
    card.className = "tray-item";
    card.dataset.itemId = item.id;

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-btn";
    removeBtn.setAttribute("aria-label", "Remove " + item.name);
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      removeItem(item.id);
    });

    var img = document.createElement("img");
    img.className = "avatar";
    img.src = item.src;
    img.draggable = false;
    img.alt = "";

    var name = document.createElement("span");
    name.className = "tray-name";
    name.textContent = item.name;
    name.title = item.name;

    card.appendChild(removeBtn);
    card.appendChild(img);
    card.appendChild(name);
    return card;
  }

  function renderGrid() {
    for (var row = 0; row < ROWS; row++) {
      for (var slot = 0; slot < SLOTS; slot++) {
        var cell = cellEls[row][slot];
        var existing = cell.querySelector(".placed-item");
        if (existing) existing.remove();

        var item = findItemAtCell(row, slot);
        if (item) {
          cell.appendChild(createPlacedItemEl(item));
        }
      }
    }
    lastDroppedItemId = null;
  }

  function createPlacedItemEl(item) {
    var wrap = document.createElement("div");
    wrap.className = "placed-item";
    wrap.dataset.itemId = item.id;
    if (item.id === lastDroppedItemId) {
      wrap.classList.add("settle");
    }

    var img = document.createElement("img");
    img.className = "avatar";
    img.src = item.src;
    img.draggable = false;
    img.alt = "";

    var name = document.createElement("span");
    name.className = "cell-name";
    name.textContent = item.name;
    name.title = item.name;

    wrap.appendChild(img);
    wrap.appendChild(name);
    return wrap;
  }

  function removeItem(id) {
    var item = getItem(id);
    if (!item || item.placement !== null) return; // must be in tray
    state.items = state.items.filter(function (it) { return it.id !== id; });
    render();
    deleteItemFile(item); // best-effort; no-op if not folder-backed
  }

  // -------------------------------------------------------------
  // Drag & drop — pointer events only (no HTML5 DnD).
  // -------------------------------------------------------------

  var pending = null; // set on pointerdown, promoted to a real drag past threshold

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    var itemEl = e.target.closest ? e.target.closest("[data-item-id]") : null;
    if (!itemEl) return;
    if (e.target.closest(".remove-btn")) return;

    var itemId = itemEl.dataset.itemId;
    var item = getItem(itemId);
    if (!item) return;

    var rect = itemEl.getBoundingClientRect();

    pending = {
      pointerId: e.pointerId,
      itemId: itemId,
      originEl: itemEl,
      originType: item.placement ? "cell" : "tray",
      originPlacement: item.placement ? { row: item.placement.row, slot: item.placement.slot } : null,
      startX: e.clientX,
      startY: e.clientY,
      grabOffsetX: e.clientX - rect.left,
      grabOffsetY: e.clientY - rect.top,
      grabWidth: rect.width,
      grabHeight: rect.height,
      started: false,
      currentTarget: null // { type: 'cell', row, slot } | { type: 'tray' } | null
    };

    itemEl.setPointerCapture(e.pointerId);
    itemEl.addEventListener("pointermove", onPointerMove);
    itemEl.addEventListener("pointerup", onPointerUp);
    itemEl.addEventListener("pointercancel", onPointerCancel);
  }

  function onPointerMove(e) {
    if (!pending || e.pointerId !== pending.pointerId) return;

    if (!pending.started) {
      var dx = e.clientX - pending.startX;
      var dy = e.clientY - pending.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      startDrag(e);
    }

    updateDrag(e);
  }

  function startDrag(e) {
    pending.started = true;
    pending.originEl.classList.add("vacated");
    gridEl.classList.add("dragging");

    buildGhost();
    positionGhost(e);
  }

  function buildGhost() {
    var item = getItem(pending.itemId);
    dragGhost.innerHTML = "";
    dragGhost.style.width = pending.grabWidth + "px";

    var img = document.createElement("img");
    img.src = item.src;
    dragGhost.appendChild(img);

    var name = document.createElement("span");
    name.className = "drag-ghost-name";
    name.textContent = item.name;
    dragGhost.appendChild(name);

    dragGhost.hidden = false;
  }

  function positionGhost(e) {
    dragGhost.style.left = (e.clientX - pending.grabOffsetX) + "px";
    dragGhost.style.top = (e.clientY - pending.grabOffsetY) + "px";
  }

  function updateDrag(e) {
    positionGhost(e);

    var target = hitTest(e.clientX, e.clientY);
    setDropTarget(target);
    pending.currentTarget = target;
  }

  function hitTest(clientX, clientY) {
    var canvasRect = canvasWrap.getBoundingClientRect();
    if (
      clientX >= canvasRect.left && clientX <= canvasRect.right &&
      clientY >= canvasRect.top && clientY <= canvasRect.bottom &&
      canvasRect.width > 0
    ) {
      var localX = clientX - canvasRect.left;
      var localY = clientY - canvasRect.top;
      // Convert rendered pixels back to the BG_SIZE coordinate space and
      // apply the same inset/cell math the export uses (spec section 2).
      var px = (localX / canvasRect.width) * BG_SIZE;
      var py = (localY / canvasRect.height) * BG_SIZE;
      var slot = Math.floor((px - INSET_LEFT) / CELL_W);
      var row = Math.floor((py - INSET_TOP) / CELL_H);
      var inside = slot >= 0 && slot < SLOTS && row >= 0 && row < ROWS;
      if (inside) {
        return { type: "cell", row: row, slot: slot };
      }
      // Over the canvas but on the border frame (sky/soil/wall) — not a
      // valid drop target, and not the nearest cell either.
      return null;
    }

    var trayRect = trayBody.getBoundingClientRect();
    if (
      clientX >= trayRect.left && clientX <= trayRect.right &&
      clientY >= trayRect.top && clientY <= trayRect.bottom
    ) {
      return { type: "tray" };
    }

    return null;
  }

  var highlightedCell = null;

  function setDropTarget(target) {
    if (highlightedCell) {
      highlightedCell.classList.remove("drop-target");
      highlightedCell = null;
    }
    trayBody.classList.remove("drop-target");

    if (!target) return;
    if (target.type === "cell") {
      highlightedCell = cellEls[target.row][target.slot];
      highlightedCell.classList.add("drop-target");
    } else if (target.type === "tray") {
      trayBody.classList.add("drop-target");
    }
  }

  function endDrag(commit) {
    if (!pending) return;

    var itemEl = pending.originEl;
    itemEl.removeEventListener("pointermove", onPointerMove);
    itemEl.removeEventListener("pointerup", onPointerUp);
    itemEl.removeEventListener("pointercancel", onPointerCancel);
    try { itemEl.releasePointerCapture(pending.pointerId); } catch (err) { /* noop */ }

    if (pending.started) {
      dragGhost.hidden = true;
      dragGhost.innerHTML = "";
      gridEl.classList.remove("dragging");
      setDropTarget(null);

      if (commit) {
        resolveDrop();
      }

      itemEl.classList.remove("vacated");
    }

    pending = null;
  }

  function resolveDrop() {
    var item = getItem(pending.itemId);
    if (!item) return;
    var target = pending.currentTarget;

    if (!target) {
      return; // dropped outside both tray and canvas: snap back, no change
    }

    if (target.type === "tray") {
      if (pending.originType === "cell") {
        item.placement = null;
        render();
        writeLayoutFile();
      }
      return;
    }

    // target.type === 'cell'
    var occupant = findItemAtCell(target.row, target.slot);

    if (occupant && occupant.id === item.id) {
      return; // dropped back where it started
    }

    if (pending.originType === "tray") {
      if (occupant) occupant.placement = null;
      item.placement = { row: target.row, slot: target.slot };
    } else {
      if (occupant) {
        occupant.placement = pending.originPlacement;
      }
      item.placement = { row: target.row, slot: target.slot };
    }

    lastDroppedItemId = item.id;
    render();
    writeLayoutFile();
  }

  function onPointerUp(e) {
    if (!pending || e.pointerId !== pending.pointerId) return;
    if (!pending.started) {
      // Never crossed the drag threshold: treat as a click, no state change.
      endDrag(false);
      return;
    }
    endDrag(true);
  }

  function onPointerCancel(e) {
    if (!pending || e.pointerId !== pending.pointerId) return;
    endDrag(false); // cancelled drag: item snaps back, nothing changes
  }

  trayBody.addEventListener("pointerdown", onPointerDown);
  gridEl.addEventListener("pointerdown", onPointerDown);

  // -------------------------------------------------------------
  // Add-image dialog
  // -------------------------------------------------------------

  var pendingFiles = []; // { tempId, name, dataUrl, image, ready, readyPromise }

  addImageBtn.addEventListener("click", function () {
    if (addDialog.open) return; // guard against rapid double-clicks
    addDialog.showModal();
  });

  cancelBtn.addEventListener("click", function () {
    addDialog.close();
  });

  addDialog.addEventListener("close", function () {
    pendingFiles = [];
    fileRows.innerHTML = "";
    fileInput.value = "";
    commitBtn.disabled = true;
  });

  fileInput.addEventListener("change", function () {
    var files = Array.prototype.slice.call(fileInput.files || []);
    files.forEach(addPendingFile);
    fileInput.value = ""; // allow re-selecting the same file later
  });

  function addPendingFile(file) {
    var entry = {
      tempId: "tmp_" + (idCounter++),
      name: stripExtension(file.name),
      file: file, // kept so a folder-connected save can write the original bytes
      dataUrl: null,
      image: null,
      ready: false
    };
    entry.readyPromise = readAsDataURL(file).then(function (dataUrl) {
      entry.dataUrl = dataUrl;
      renderFileRows();
      return decodeImage(dataUrl);
    }).then(function (img) {
      entry.image = img;
      entry.ready = true;
      updateCommitState();
    }).catch(function () {
      entry.ready = true; // don't block the dialog forever on a bad file
      entry.failed = true;
      updateCommitState();
    });

    pendingFiles.push(entry);
    renderFileRows();
    updateCommitState();
  }

  function updateCommitState() {
    commitBtn.disabled = pendingFiles.length === 0;
  }

  function renderFileRows() {
    fileRows.innerHTML = "";
    pendingFiles.forEach(function (entry) {
      var row = document.createElement("div");
      row.className = "file-row";

      var img = document.createElement("img");
      if (entry.dataUrl) img.src = entry.dataUrl;
      row.appendChild(img);

      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = entry.name;
      nameInput.setAttribute("aria-label", "Name");
      nameInput.addEventListener("input", function () {
        entry.name = nameInput.value;
      });
      row.appendChild(nameInput);

      fileRows.appendChild(row);
    });
  }

  addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (pendingFiles.length === 0) return;

    var toCommit = pendingFiles.slice();
    Promise.all(toCommit.map(function (entry) { return entry.readyPromise; })).then(function () {
      var newlyAdded = []; // { item, file } — file needed to write to the folder, if connected
      toCommit.forEach(function (entry) {
        if (entry.failed) return;
        var trimmedName = entry.name.trim() || "Untitled";
        var item = {
          id: genId(),
          name: trimmedName,
          src: entry.dataUrl,
          image: entry.image,
          placement: null,
          fileName: null
        };
        state.items.push(item);
        newlyAdded.push({ item: item, file: entry.file });
      });
      render();
      addDialog.close();
      saveNewItemsToFolder(newlyAdded); // fire-and-forget; no-op if no folder connected
    });
  });

  // -------------------------------------------------------------
  // Default library — the avatar set shipped with the site itself, so
  // every visitor sees it populated without needing to connect a
  // folder (which only works in Chrome/Edge, and only for a folder on
  // *their own* machine — useless for showing a curated set on a
  // hosted page). Loaded via plain fetch()/<img>, so it works in every
  // browser; it just silently does nothing under file:// (fetch to a
  // local file is blocked there — Connect Folder remains the way to
  // work with this same folder locally).
  //
  // DEFAULT_LIBRARY_DIR/manifest.json is a plain JSON array of
  // filenames — there's no way to ask a static file host to list a
  // directory's contents, so this has to be generated by hand and
  // regenerated whenever files are added to or removed from the
  // folder (layout.json only records *placed* items, so it can't
  // stand in for this — an avatar left in the tray wouldn't be in it).
  // -------------------------------------------------------------

  async function addDefaultLibraryItem(fileName, cell) {
    var res = await fetch(DEFAULT_LIBRARY_DIR + fileName);
    if (!res.ok) throw new Error("HTTP " + res.status);
    var blob = await res.blob();
    var dataUrl = await readAsDataURL(blob); // FileReader accepts any Blob, not just File
    var img = await decodeImage(dataUrl);
    state.items.push({
      id: genId(),
      name: stripExtension(fileName),
      src: dataUrl,
      image: img,
      placement: isValidCell(cell) ? { row: cell.row, slot: cell.slot } : null,
      fileName: fileName
    });
  }

  async function loadDefaultLibrary() {
    try {
      var manifestRes = await fetch(DEFAULT_LIBRARY_DIR + "manifest.json");
      if (!manifestRes.ok) return;
      var fileNames = await manifestRes.json();
      if (!Array.isArray(fileNames)) return;

      var placements = {};
      try {
        var layoutRes = await fetch(DEFAULT_LIBRARY_DIR + "layout.json");
        if (layoutRes.ok) {
          var parsed = await layoutRes.json();
          placements = (parsed && parsed.placements) || {};
        }
      } catch (err) {
        // No saved layout, or couldn't read it — items just land in the tray.
      }

      for (var i = 0; i < fileNames.length; i++) {
        var fileName = fileNames[i];
        if (itemHasFile(fileName)) continue; // already present this session
        try {
          await addDefaultLibraryItem(fileName, placements[fileName]);
        } catch (err) {
          console.warn("Could not load \"" + fileName + "\" from the built-in library:", err);
        }
      }

      render();
    } catch (err) {
      // fetch() itself unavailable (e.g. a real file:// open, where local
      // fetches are blocked) — silently skip. Connect Folder still works
      // for local use; nothing here should block that.
    }
  }

  // -------------------------------------------------------------
  // Folder sync — persists uploaded avatars as real files on disk via
  // the File System Access API, so the tray repopulates itself next
  // time the folder is reconnected instead of starting empty.
  //
  // Chrome/Edge only (no Firefox/Safari support); the whole feature is
  // feature-detected and stays hidden where it's unavailable. This
  // section uses async/await (unlike the rest of the file's ES5 style)
  // because the directory-entries API is only usable as an async
  // iterator — a browser new enough for showDirectoryPicker already
  // supports it natively, so it costs nothing in compatibility.
  // -------------------------------------------------------------

  var FILE_SYSTEM_SUPPORTED = !!window.showDirectoryPicker;
  var folderHandle = null;
  var folderUiState = "unsupported"; // 'unsupported' | 'disconnected' | 'needs-permission' | 'connected'
  var folderPickerOpen = false;

  var IDB_NAME = "building-tiers";
  var IDB_STORE = "handles";
  var IDB_KEY = "imageFolder";

  var LAYOUT_FILE_NAME = "layout.json"; // reserved filename inside the connected folder
  var LAYOUT_VERSION = 1;
  // Set for the rest of the session if layout.json exists but couldn't be
  // read (permissions hiccup, IO error) — distinct from "no file yet".
  // Without this, a transient read failure would look identical to "empty",
  // and the next write would overwrite a perfectly good file with a much
  // smaller map, permanently losing whatever it couldn't read.
  var layoutWritesSuspended = false;

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGetHandle() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readonly");
        var req = tx.objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbSetHandle(handle) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function setFolderUiState(nextState, name) {
    folderUiState = nextState;
    if (nextState === "unsupported") {
      folderRow.hidden = true;
      return;
    }
    folderRow.hidden = false;
    if (nextState === "disconnected") {
      folderBtn.textContent = "Connect folder…";
    } else if (nextState === "needs-permission") {
      folderBtn.textContent = "Reconnect “" + (name || "folder") + "”";
    } else if (nextState === "connected") {
      folderBtn.textContent = "Folder: " + (name || "connected");
    }
  }

  function itemHasFile(fileName) {
    return state.items.some(function (it) { return it.fileName === fileName; });
  }

  function sanitizeFileName(name) {
    var cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").replace(/[\s.]+$/, "");
    return cleaned.slice(0, 150) || "untitled";
  }

  async function fileExists(dirHandle, name) {
    try {
      await dirHandle.getFileHandle(name, { create: false });
      return true;
    } catch (err) {
      return false;
    }
  }

  async function uniqueFileName(dirHandle, baseName, ext) {
    var candidate = baseName + ext;
    var n = 2;
    while (await fileExists(dirHandle, candidate)) {
      candidate = baseName + " (" + n + ")" + ext;
      n++;
    }
    return candidate;
  }

  async function addItemFromFileHandle(fileHandle) {
    var file = await fileHandle.getFile();
    var dataUrl = await readAsDataURL(file);
    var img = await decodeImage(dataUrl);
    state.items.push({
      id: genId(),
      name: stripExtension(fileHandle.name),
      src: dataUrl,
      image: img,
      placement: null,
      fileName: fileHandle.name
    });
  }

  async function syncFromFolder() {
    if (!folderHandle) return;
    var entries = [];
    for await (var entry of folderHandle.values()) {
      if (entry.kind === "file" && IMAGE_EXT_RE.test(entry.name) && !itemHasFile(entry.name)) {
        entries.push(entry);
      }
    }
    entries.sort(function (a, b) { return a.name.localeCompare(b.name); });
    for (var i = 0; i < entries.length; i++) {
      try {
        await addItemFromFileHandle(entries[i]);
      } catch (err) {
        console.warn("Could not load " + entries[i].name + " from folder:", err);
      }
    }

    var layoutResult = await readLayoutFile();
    if (!layoutResult.ok) layoutWritesSuspended = true;
    applyLayoutToItems(layoutResult.placements);

    render();
  }

  async function saveItemFile(item, file) {
    if (!folderHandle || !file) return;
    var ext = extensionOf(file.name) || ".png";
    var baseName = sanitizeFileName(item.name);
    try {
      var fileName = await uniqueFileName(folderHandle, baseName, ext);
      var handle = await folderHandle.getFileHandle(fileName, { create: true });
      var writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
      item.fileName = fileName;
    } catch (err) {
      console.warn("Could not save \"" + item.name + "\" to the connected folder:", err);
    }
  }

  async function saveNewItemsToFolder(newItems) {
    if (!folderHandle) return;
    for (var i = 0; i < newItems.length; i++) {
      await saveItemFile(newItems[i].item, newItems[i].file);
    }
  }

  function dataUrlToFile(dataUrl, name) {
    return fetch(dataUrl).then(function (res) { return res.blob(); }).then(function (blob) {
      return new File([blob], name, { type: blob.type });
    });
  }

  // Items added before any folder was connected have no fileName yet;
  // write them out too so connecting a folder doesn't leave anything behind.
  async function backfillExistingItems() {
    if (!folderHandle) return;
    var toSave = state.items.filter(function (it) { return !it.fileName; });
    for (var i = 0; i < toSave.length; i++) {
      var item = toSave[i];
      try {
        var file = await dataUrlToFile(item.src, item.name);
        await saveItemFile(item, file);
      } catch (err) {
        console.warn("Could not back-fill \"" + item.name + "\" into the connected folder:", err);
      }
    }
  }

  function deleteItemFile(item) {
    if (!folderHandle || !item.fileName) return;
    folderHandle.removeEntry(item.fileName).catch(function () {
      /* best-effort — file may already be gone; state removal already happened */
    });
  }

  // -------------------------------------------------------------
  // Board-layout persistence — remembers which room each folder-backed
  // avatar was standing in, mirrored to layout.json in the connected
  // folder. Rides on the same folderHandle as the images themselves:
  // with no folder connected there's nothing to write this to, exactly
  // like the avatars it applies to.
  // -------------------------------------------------------------

  function buildPlacementsMap() {
    var map = {};
    state.items.forEach(function (it) {
      if (it.placement && it.fileName) {
        map[it.fileName] = { row: it.placement.row, slot: it.placement.slot };
      }
    });
    return map;
  }

  function isValidCell(v) {
    return !!v &&
      typeof v.row === "number" && v.row >= 0 && v.row < ROWS &&
      typeof v.slot === "number" && v.slot >= 0 && v.slot < SLOTS;
  }

  // Serialized write queue. Deliberately does NOT snapshot state.items at
  // call time and queue the snapshots — per the File System Access API,
  // two overlapping writable streams to the same file each keep an
  // independent swap file, and whichever close() resolves *last* wins,
  // regardless of call order. Queuing the operation itself instead (it
  // reads state.items fresh when it actually runs) guarantees only one
  // write is ever in flight and it always reflects true current state.
  var layoutWriteChain = Promise.resolve();

  function writeLayoutFile() {
    if (!folderHandle || layoutWritesSuspended) return;
    // The .catch(noop) matters: without it, one failed write would
    // permanently poison every subsequent queued write, since a
    // rejected promise short-circuits a .then() chain forever.
    layoutWriteChain = layoutWriteChain.catch(function () {}).then(doWriteLayout);
    return layoutWriteChain;
  }

  async function doWriteLayout() {
    if (!folderHandle) return;
    try {
      var handle = await folderHandle.getFileHandle(LAYOUT_FILE_NAME, { create: true });
      var writable = await handle.createWritable();
      await writable.write(JSON.stringify({ version: LAYOUT_VERSION, placements: buildPlacementsMap() }));
      await writable.close();
    } catch (err) {
      console.warn("Could not save layout to the connected folder:", err);
    }
  }

  // Never throws out. { ok: false, ... } means "couldn't tell" (permission
  // hiccup, IO error) as opposed to "genuinely no file yet" — see
  // layoutWritesSuspended above for why that distinction matters.
  async function readLayoutFile() {
    if (!folderHandle) return { ok: true, placements: {} };
    try {
      var handle = await folderHandle.getFileHandle(LAYOUT_FILE_NAME, { create: false });
      var file = await handle.getFile();
      var parsed = JSON.parse(await file.text());
      return { ok: true, placements: (parsed && parsed.placements) || {} };
    } catch (err) {
      if (err && err.name === "NotFoundError") return { ok: true, placements: {} }; // no file yet
      console.warn("Could not read layout.json from the connected folder:", err);
      return { ok: false, placements: {} };
    }
  }

  // Seeds .placement on freshly-synced items from a saved layout map.
  // Never relocates something already placed this session, and a corrupt
  // file claiming two files for one cell resolves first-one-wins, rest
  // stay in the tray.
  function applyLayoutToItems(placementsMap) {
    state.items.forEach(function (it) {
      if (it.placement !== null || !it.fileName) return;
      var cell = placementsMap[it.fileName];
      if (!isValidCell(cell)) return;
      if (findItemAtCell(cell.row, cell.slot)) return;
      it.placement = { row: cell.row, slot: cell.slot };
    });
  }

  async function pickFolder() {
    if (folderPickerOpen) return; // guard rapid double-clicks, same as the Add-image dialog
    folderPickerOpen = true;
    try {
      var handle = await window.showDirectoryPicker({ mode: "readwrite" });
      folderHandle = handle;
      await idbSetHandle(handle);
      setFolderUiState("connected", handle.name);
      await syncFromFolder();
      await backfillExistingItems();
      // Captures layout immediately if items were already placed before this
      // folder was ever connected, rather than waiting for the next drag.
      await writeLayoutFile();
    } catch (err) {
      if (err && err.name !== "AbortError") { // AbortError = user cancelled the picker; not an error
        console.warn("Could not connect a folder:", err);
      }
    } finally {
      folderPickerOpen = false;
    }
  }

  async function reconnectFolder() {
    if (!folderHandle) return pickFolder();
    try {
      var perm = await folderHandle.requestPermission({ mode: "readwrite" });
      if (perm === "granted") {
        setFolderUiState("connected", folderHandle.name);
        await syncFromFolder();
      }
      // else: user declined: stay in 'needs-permission', nothing else to do
    } catch (err) {
      console.warn("Could not reconnect the folder:", err);
    }
  }

  folderBtn.addEventListener("click", function () {
    if (folderUiState === "needs-permission") {
      reconnectFolder();
    } else {
      pickFolder();
    }
  });

  async function initFolderSync() {
    if (!FILE_SYSTEM_SUPPORTED) {
      setFolderUiState("unsupported");
      return;
    }
    try {
      var handle = await idbGetHandle();
      if (!handle) {
        setFolderUiState("disconnected");
        return;
      }
      folderHandle = handle;
      var perm = await handle.queryPermission({ mode: "readwrite" });
      if (perm === "granted") {
        setFolderUiState("connected", handle.name);
        await syncFromFolder();
      } else {
        setFolderUiState("needs-permission", handle.name);
      }
    } catch (err) {
      console.warn("Folder sync could not resume automatically:", err);
      setFolderUiState("disconnected");
    }
  }

  // Load the built-in library first, then let folder sync resume — that
  // order (rather than running them in parallel) means folder sync's
  // itemHasFile() dedup reliably sees what the default library already
  // added, instead of racing it if the same folder happens to be the
  // one already connected locally.
  loadDefaultLibrary().then(initFolderSync);

  // -------------------------------------------------------------
  // GitHub save — lets the site owner (not visitors) push the current
  // board layout back to GITHUB_LAYOUT_PATH in their own repo via the
  // GitHub Contents API, directly from the browser. Entirely separate
  // from folder sync's writeLayoutFile() above: different transport
  // (GitHub API vs local File System Access API), different trigger
  // (manual click, not automatic on every drop — each API write is a
  // permanent commit, and auto-saving every drag would spam the repo's
  // history with one commit per drop). The two don't share state and
  // don't need to agree with each other.
  //
  // Scope: rearrangement of the existing shipped avatars only —
  // buildPlacementsMap() (above) is reused as-is. This does not upload
  // new avatar images, update manifest.json, or ever read GitHub state
  // back into the board; it's write-only.
  // -------------------------------------------------------------

  var githubUiState = "unconfigured"; // 'unconfigured' | 'disconnected' | 'connected'
  var saveGithubInFlight = false;

  function getGithubToken() { return localStorage.getItem(GITHUB_TOKEN_KEY); }
  function setGithubToken(token) { localStorage.setItem(GITHUB_TOKEN_KEY, token); }

  function setGithubUiState(nextState) {
    githubUiState = nextState;
    if (!GITHUB_CONFIGURED) {
      githubRow.hidden = true;
      saveGithubBtn.hidden = true;
      return;
    }
    githubRow.hidden = false;
    if (nextState === "disconnected") {
      githubConnectBtn.textContent = "Connect GitHub…";
      saveGithubBtn.hidden = true;
    } else if (nextState === "connected") {
      githubConnectBtn.textContent = "GitHub: connected";
      saveGithubBtn.hidden = false;
    }
  }

  function initGithubSync() {
    if (!GITHUB_CONFIGURED) {
      setGithubUiState("unconfigured");
      return;
    }
    setGithubUiState(getGithubToken() ? "connected" : "disconnected");
  }

  githubConnectBtn.addEventListener("click", function () {
    if (githubDialog.open) return; // guard rapid double-clicks, same as the Add-image dialog
    githubTokenInput.value = getGithubToken() || "";
    githubDialog.showModal();
  });

  githubCancelBtn.addEventListener("click", function () {
    githubDialog.close();
  });

  githubForm.addEventListener("submit", function () {
    var token = githubTokenInput.value.trim();
    if (token) setGithubToken(token);
    setGithubUiState(token ? "connected" : "disconnected");
  });

  githubDialog.addEventListener("close", function () {
    githubTokenInput.value = ""; // never leave the token sitting in the DOM after the dialog closes
  });

  function githubApiUrl(path) {
    return "https://api.github.com/repos/" + GITHUB_OWNER + "/" + GITHUB_REPO +
      "/contents/" + path + "?ref=" + encodeURIComponent(GITHUB_BRANCH);
  }

  function utf8ToBase64(str) {
    // btoa() only handles Latin1; TextEncoder gets the raw UTF-8 bytes
    // first so this survives non-ASCII avatar names down the line, even
    // though layout.json's keys (filenames) are ASCII-only today.
    var bytes = new TextEncoder().encode(str);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // Fetches the current sha right before writing — never reused from an
  // earlier load — to avoid a stale-sha 409 later. A 404 here isn't an
  // error, it just means the file doesn't exist yet: sha comes back
  // null, and the caller omits it from the PUT so GitHub creates it.
  async function githubGetSha() {
    var res = await fetch(githubApiUrl(GITHUB_LAYOUT_PATH), {
      headers: {
        "Authorization": "Bearer " + getGithubToken(),
        "Accept": "application/vnd.github+json"
      }
    });
    if (res.status === 404) return { ok: true, sha: null };
    if (!res.ok) return { ok: false, status: res.status, headers: res.headers };
    var body = await res.json();
    return { ok: true, sha: body.sha };
  }

  function githubPutLayout(sha) {
    var payload = { version: LAYOUT_VERSION, placements: buildPlacementsMap() };
    var body = {
      message: "Update layout.json via Testers Ranking",
      content: utf8ToBase64(JSON.stringify(payload, null, 2)),
      branch: GITHUB_BRANCH
    };
    if (sha) body.sha = sha; // omitted entirely (not null) tells GitHub to create rather than update
    return fetch(githubApiUrl(GITHUB_LAYOUT_PATH), {
      method: "PUT",
      headers: {
        "Authorization": "Bearer " + getGithubToken(),
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  }

  // GitHub returns 403 for both "no permission" and "rate limited" —
  // x-ratelimit-remaining is what actually tells them apart.
  function classifyGithubFailure(res) {
    if (!res) return "Save failed"; // network/CORS-level failure, no response at all
    if (res.status === 401) return "Bad token";
    if (res.status === 403) {
      return res.headers.get("x-ratelimit-remaining") === "0" ? "Rate limited" : "No permission";
    }
    if (res.status === 409) return "Changed on GitHub";
    return "Save failed";
  }

  var saveGithubDefaultLabel = saveGithubBtn.textContent;
  var saveGithubFeedbackTimer = null;

  function flashSaveGithubBtn(label) {
    clearTimeout(saveGithubFeedbackTimer);
    saveGithubBtn.textContent = label;
    saveGithubFeedbackTimer = setTimeout(function () {
      saveGithubBtn.textContent = saveGithubDefaultLabel;
    }, 1500);
  }

  async function saveToGithub() {
    if (saveGithubInFlight || githubUiState !== "connected") return;

    saveGithubInFlight = true;
    saveGithubBtn.disabled = true;
    clearTimeout(saveGithubFeedbackTimer);
    saveGithubBtn.textContent = "Saving…"; // no auto-revert — shouldn't flip back while still waiting

    try {
      var shaResult = await githubGetSha();
      if (!shaResult.ok) {
        // A confirmed bad token shouldn't keep claiming "connected" —
        // leave a path back to reconnecting instead of failing forever.
        if (shaResult.status === 401) setGithubUiState("disconnected");
        flashSaveGithubBtn(classifyGithubFailure({ status: shaResult.status, headers: shaResult.headers }));
        return;
      }

      var putRes = await githubPutLayout(shaResult.sha);
      if (!putRes.ok) {
        if (putRes.status === 401) setGithubUiState("disconnected");
        // On a 409 (someone/something else changed the file between GET
        // and PUT — most plausibly a second open tab), fail with a clear
        // message rather than silently re-fetching and overwriting: that
        // would discard whatever changed it with no diff shown to anyone.
        flashSaveGithubBtn(classifyGithubFailure(putRes));
        return;
      }

      flashSaveGithubBtn("Saved!");
    } catch (err) {
      console.warn("Could not save layout to GitHub:", err); // never log the token itself
      flashSaveGithubBtn("Save failed");
    } finally {
      saveGithubInFlight = false;
      saveGithubBtn.disabled = false;
    }
  }

  saveGithubBtn.addEventListener("click", saveToGithub);

  // No IndexedDB/permission round-trip needed (just a synchronous
  // localStorage read), so this doesn't need to join the
  // loadDefaultLibrary().then(initFolderSync) chain above.
  initGithubSync();

  // -------------------------------------------------------------
  // Export
  // -------------------------------------------------------------

  function drawLabel(ctx, text, centerX, baselineY, maxWidth) {
    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    var str = text;
    if (ctx.measureText(str).width > maxWidth) {
      while (str.length > 1 && ctx.measureText(str + "…").width > maxWidth) {
        str = str.slice(0, -1);
      }
      str = str + "…";
    }

    ctx.fillStyle = "#000";
    ctx.fillText(str, centerX + LABEL_SHADOW_OFFSET, baselineY + LABEL_SHADOW_OFFSET);
    ctx.fillStyle = "#fff";
    ctx.fillText(str, centerX, baselineY);
  }

  function drawAvatarFit(ctx, img, cellX, cellY) {
    var boxSize = AVATAR_SIZE;
    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;

    var scale = Math.min(boxSize / iw, boxSize / ih);
    var drawW = iw * scale;
    var drawH = ih * scale;
    var dx = cellX + (CELL_W - drawW) / 2;
    var dy = cellY + AVATAR_TOP + (boxSize - drawH) / 2;

    ctx.drawImage(img, dx, dy, drawW, drawH);
  }

  // Draws the current state to exportCanvas. Shared by both "Export
  // PNG" (download) and "Copy PNG" (clipboard) — they differ only in
  // what happens to the rendered canvas afterward.
  function renderExportCanvas() {
    var ctx = exportCanvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, BG_SIZE, BG_SIZE);

    if (bgReady) {
      ctx.drawImage(bgImageEl, 0, 0, BG_SIZE, BG_SIZE);
    } else {
      // Degraded fallback: full-bleed strips (no border frame to speak
      // of, since there's no artwork), matching the DOM fallback in
      // index.html. Item placement below still follows the real inset
      // grid regardless of which background got drawn.
      var stripHeight = BG_SIZE / ROWS;
      ctx.fillStyle = "#1b1a20";
      ctx.fillRect(0, 0, BG_SIZE, BG_SIZE);
      ctx.strokeStyle = "#383540";
      for (var r = 1; r < ROWS; r++) {
        ctx.beginPath();
        ctx.moveTo(0, r * stripHeight);
        ctx.lineTo(BG_SIZE, r * stripHeight);
        ctx.stroke();
      }
    }

    for (var row = 0; row < ROWS; row++) {
      for (var slot = 0; slot < SLOTS; slot++) {
        var item = findItemAtCell(row, slot);
        if (!item || !item.image) continue;

        var cellX = INSET_LEFT + slot * CELL_W;
        var cellY = INSET_TOP + row * CELL_H;

        drawAvatarFit(ctx, item.image, cellX, cellY);
        drawLabel(
          ctx,
          item.name,
          cellX + CELL_W / 2,
          cellY + LABEL_BASELINE,
          LABEL_MAX_WIDTH
        );
      }
    }
  }

  // Returns a Promise<Blob> for the current export canvas. Draws fresh
  // (synchronously) before asking for the blob, so it always reflects
  // whatever is on the board right now.
  function getExportBlob() {
    return new Promise(function (resolve, reject) {
      renderExportCanvas();
      exportCanvas.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error("canvas.toBlob returned null"));
      }, "image/png");
    });
  }

  function todayStamp() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function downloadPNG() {
    getExportBlob().then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "testers-ranking-" + todayStamp() + ".png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }).catch(function (err) {
      console.warn("Could not render the export canvas:", err);
    });
  }

  var CLIPBOARD_SUPPORTED = !!(navigator.clipboard && window.ClipboardItem);
  var copyBtnDefaultLabel = copyBtn.textContent;
  var copyFeedbackTimer = null;
  var copyInFlight = false; // guards overlapping clicks while a write is pending

  function flashCopyBtn(label) {
    clearTimeout(copyFeedbackTimer);
    copyBtn.textContent = label;
    copyFeedbackTimer = setTimeout(function () {
      copyBtn.textContent = copyBtnDefaultLabel;
    }, 1500);
  }

  // navigator.clipboard.write() must be called synchronously inside the
  // click handler to be recognized as user-initiated. Waiting until a
  // blob is already in hand (e.g. inside canvas.toBlob's callback) calls
  // it too late — that's outside the activation window, and it has been
  // observed to hang indefinitely rather than reject when that happens.
  // So call write() immediately, right here, and hand it a *pending*
  // Promise<Blob> instead; the browser waits for that to resolve. A
  // fallback timer still covers the case where it hangs anyway.
  var CLIPBOARD_TIMEOUT_MS = 3000;

  function copyPNG() {
    if (copyInFlight) return; // a previous click's write is still pending
    if (!CLIPBOARD_SUPPORTED) {
      flashCopyBtn("Copy not supported");
      return;
    }

    copyInFlight = true;
    copyBtn.disabled = true;
    clearTimeout(copyFeedbackTimer); // "Copying…" has no auto-revert; it shouldn't flip
    copyBtn.textContent = "Copying…"; // back to the default label while still genuinely waiting.

    var done = false;
    function finish(ok, err) {
      if (done) return;
      done = true;
      copyInFlight = false;
      copyBtn.disabled = false;
      if (ok) {
        flashCopyBtn("Copied!");
      } else {
        // No download fallback here on purpose — Export PNG is right
        // below for that. Just report the failure; make it visible on
        // the button itself, not just the console.
        if (err) {
          console.warn(
            "Clipboard write failed: " + (err.name || "Error") + ": " + err.message,
            err
          );
        }
        flashCopyBtn("Copy failed");
      }
    }

    navigator.clipboard.write([
      new ClipboardItem({ "image/png": getExportBlob() })
    ]).then(function () {
      finish(true);
    }).catch(function (err) {
      finish(false, err);
    });

    setTimeout(function () {
      finish(false, new Error("clipboard write timed out"));
    }, CLIPBOARD_TIMEOUT_MS);
  }

  copyBtn.addEventListener("click", copyPNG);
  exportBtn.addEventListener("click", downloadPNG);

  // -------------------------------------------------------------
  // Initial render
  // -------------------------------------------------------------

  render();
})();
