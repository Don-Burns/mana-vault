import {
  type CardEntry,
  collectionStore,
  type Folder,
} from "../collection/store.ts";
import {
  exportAsCSV,
  exportAsJSON,
  importFromJSON,
} from "../collection/export.ts";
import { Camera } from "../camera/capture.ts";
import { CardDetector } from "../detection/detector.ts";

export function CollectionView(container: HTMLElement) {
  const el = document.createElement("div");
  el.className = "view collection-view";
  container.appendChild(el);

  let currentFolderId: string | null = null;
  let selectedCardIds: Set<string> = new Set();
  let selectMode = false;
  let scanSelectMode = false;
  let scanSelectCamera: Camera | null = null;
  let scanSelectDetector: CardDetector | null = null;

  el.innerHTML = `
    <div class="collection-header" id="collection-header">
      <h1>Collection</h1>
      <div class="header-actions">
        <button class="btn-sm" id="btn-add-folder">+ Folder</button>
        <button class="btn-sm" id="btn-export">Export</button>
        <button class="btn-sm" id="btn-import">Import</button>
      </div>
    </div>
    <div class="folder-list" id="folder-list"></div>
    <div class="folder-detail hidden" id="folder-detail">
      <div class="folder-detail-header">
        <button class="btn-back" id="btn-back">&larr;</button>
        <h2 id="folder-title">Folder</h2>
        <div class="folder-detail-actions">
          <button class="btn-sm" id="btn-select-mode">Select</button>
          <button class="btn-sm" id="btn-scan-select">Scan Select</button>
        </div>
      </div>
      <div class="card-list" id="card-list"></div>
      <div class="selection-bar hidden" id="selection-bar">
        <span id="selection-count">0 selected</span>
        <div class="selection-actions">
          <button class="btn-sm" id="btn-move-selected">Move to...</button>
          <button class="btn-sm" id="btn-deselect-all">Deselect</button>
        </div>
      </div>
    </div>
    <div class="scan-select-overlay hidden" id="scan-select-overlay">
      <div class="scan-select-header">
        <span id="scan-select-status">Initializing...</span>
        <button class="btn-sm" id="btn-close-scan-select">Done</button>
      </div>
      <div class="scan-select-camera">
        <video id="scan-select-video" playsinline autoplay muted></video>
      </div>
      <div class="scan-select-results" id="scan-select-results"></div>
    </div>
  `;

  function init() {
    renderFolderList();
    setupEventListeners();
  }

  function setupEventListeners() {
    el.querySelector("#btn-add-folder")!.addEventListener(
      "click",
      handleAddFolder,
    );
    el.querySelector("#btn-export")!.addEventListener("click", handleExport);
    el.querySelector("#btn-import")!.addEventListener("click", handleImport);
    el.querySelector("#btn-back")!.addEventListener("click", handleBack);
    el.querySelector("#btn-select-mode")!.addEventListener(
      "click",
      toggleSelectMode,
    );
    el.querySelector("#btn-scan-select")!.addEventListener(
      "click",
      startScanSelect,
    );
    el.querySelector("#btn-close-scan-select")!.addEventListener(
      "click",
      stopScanSelect,
    );
    el.querySelector("#btn-move-selected")!.addEventListener(
      "click",
      handleMoveSelected,
    );
    el.querySelector("#btn-deselect-all")!.addEventListener(
      "click",
      deselectAll,
    );
  }

  // ─── Folder List ────────────────────────────────────────────────

  async function renderFolderList() {
    const folders = await collectionStore.getAllFolders();
    const listEl = el.querySelector("#folder-list")!;

    const items = await Promise.all(
      folders.map(async (folder) => {
        const count = await collectionStore.getFolderCardCount(folder.id);
        return renderFolderItem(folder, count);
      }),
    );

    listEl.innerHTML = items.join("");

    listEl.querySelectorAll<HTMLElement>(".folder-item").forEach((item) => {
      item.addEventListener("click", () => openFolder(item.dataset.folderId!));
    });
  }

  function renderFolderItem(folder: Folder, cardCount: number): string {
    return `
      <div class="folder-item" data-folder-id="${folder.id}">
        <span class="folder-color" style="background:${folder.color}"></span>
        <span class="folder-name">${escapeHtml(folder.name)}</span>
        <span class="folder-count">${cardCount} card${
      cardCount !== 1 ? "s" : ""
    }</span>
      </div>
    `;
  }

  // ─── Folder Detail ──────────────────────────────────────────────

  async function openFolder(folderId: string) {
    currentFolderId = folderId;
    selectedCardIds.clear();
    selectMode = false;

    const folder = await collectionStore.getFolder(folderId);
    if (!folder) return;

    el.querySelector<HTMLElement>("#folder-title")!.textContent = folder.name;
    showFolderDetail();
    await renderCardList(folderId);
    updateSelectionBar();
  }

  async function renderCardList(folderId: string) {
    const cards = await collectionStore.getCardsByFolder(folderId);
    const listEl = el.querySelector("#card-list")!;

    if (cards.length === 0) {
      listEl.innerHTML =
        `<div class="empty-state">No cards in this folder.<br>Scan some cards to add them!</div>`;
      return;
    }

    listEl.innerHTML = cards.map((card) => renderCardItem(card)).join("");

    // Attach click handlers for selection
    listEl.querySelectorAll<HTMLElement>(".card-item").forEach((item) => {
      item.addEventListener("click", () => {
        if (selectMode) {
          toggleCardSelection(item.dataset.cardId!);
          item.classList.toggle(
            "selected",
            selectedCardIds.has(item.dataset.cardId!),
          );
          updateSelectionBar();
        }
      });
    });
  }

  function renderCardItem(card: CardEntry): string {
    const isSelected = selectedCardIds.has(card.id);
    return `
      <div class="card-item ${
      isSelected ? "selected" : ""
    }" data-card-id="${card.id}">
        <div class="card-info">
          <span class="card-name">${escapeHtml(card.name)}</span>
          <span class="card-set">${card.setCode.toUpperCase()} #${card.collectorNumber}</span>
        </div>
        <div class="card-meta">
          <span class="card-qty">&times;${card.quantity}</span>
          <span class="card-condition">${card.condition}</span>
        </div>
      </div>
    `;
  }

  // ─── Selection Mode ─────────────────────────────────────────────

  function toggleSelectMode() {
    selectMode = !selectMode;
    const btn = el.querySelector<HTMLButtonElement>("#btn-select-mode")!;
    btn.textContent = selectMode ? "Cancel" : "Select";
    btn.classList.toggle("active", selectMode);

    if (!selectMode) {
      deselectAll();
    }

    updateSelectionBar();
  }

  function toggleCardSelection(cardId: string) {
    if (selectedCardIds.has(cardId)) {
      selectedCardIds.delete(cardId);
    } else {
      selectedCardIds.add(cardId);
    }
  }

  function deselectAll() {
    selectedCardIds.clear();
    el.querySelectorAll(".card-item.selected").forEach((item) => {
      item.classList.remove("selected");
    });
    updateSelectionBar();
  }

  function updateSelectionBar() {
    const bar = el.querySelector<HTMLElement>("#selection-bar")!;
    const count = el.querySelector<HTMLElement>("#selection-count")!;

    if (selectedCardIds.size > 0) {
      bar.classList.remove("hidden");
      count.textContent = `${selectedCardIds.size} selected`;
    } else {
      bar.classList.add("hidden");
    }
  }

  // ─── Move Flow ──────────────────────────────────────────────────

  async function handleMoveSelected() {
    if (selectedCardIds.size === 0) return;

    // Show folder picker dialog
    const folders = await collectionStore.getAllFolders();
    const otherFolders = folders.filter((f) => f.id !== currentFolderId);

    if (otherFolders.length === 0) {
      alert("No other folders to move to. Create a new folder first.");
      return;
    }

    // Simple folder picker using prompt (will be replaced with proper UI later)
    const options = otherFolders.map((f, i) => `${i + 1}. ${f.name}`).join(
      "\n",
    );
    const choice = prompt(
      `Move ${selectedCardIds.size} card(s) to:\n\n${options}\n\nEnter number:`,
    );

    if (!choice) return;
    const idx = parseInt(choice) - 1;
    if (idx < 0 || idx >= otherFolders.length) return;

    const destFolder = otherFolders[idx];

    // Perform the move
    await collectionStore.moveCards([...selectedCardIds], destFolder.id);

    // Refresh
    selectedCardIds.clear();
    selectMode = false;
    el.querySelector<HTMLButtonElement>("#btn-select-mode")!.textContent =
      "Select";
    await renderCardList(currentFolderId!);
    updateSelectionBar();
  }

  // ─── Scan-to-Select Mode ───────────────────────────────────────

  // Frame sampling rate for scan-to-select. See ScannerView for rationale.
  const SCAN_SELECT_FPS = 20;

  async function startScanSelect() {
    if (!currentFolderId) {
      return;
    }

    scanSelectMode = true;
    selectMode = true; // Enable selection mode too

    const overlay = el.querySelector<HTMLElement>("#scan-select-overlay")!;
    overlay.classList.remove("hidden");

    const videoEl = el.querySelector<HTMLVideoElement>("#scan-select-video")!;
    const statusEl = el.querySelector<HTMLElement>("#scan-select-status")!;

    // Get illustration IDs in this folder for subset matching
    const folderIllustrations = await collectionStore
      .getIllustrationIdsInFolder(currentFolderId);

    if (folderIllustrations.size === 0) {
      statusEl.textContent = "Folder is empty - nothing to scan for.";
      return;
    }

    // Initialize camera and detector
    scanSelectCamera = new Camera(videoEl);
    scanSelectDetector = new CardDetector();

    try {
      await scanSelectCamera.start({
        facingMode: "environment",
        targetFps: SCAN_SELECT_FPS,
      });
      await scanSelectDetector.waitUntilReady();
      statusEl.textContent =
        `Scan cards to select them (${folderIllustrations.size} unique arts in folder)`;
    } catch (err) {
      statusEl.textContent = `Error: ${(err as Error).message}`;
      return;
    }

    // Processing loop
    let isProcessing = false;
    let lastMatchTime = 0;
    const MATCH_COOLDOWN = 2000;

    scanSelectCamera.setFrameHandler(async () => {
      if (isProcessing || !scanSelectDetector?.isReady || !scanSelectCamera) {
        return;
      }
      isProcessing = true;

      try {
        const frame = scanSelectCamera.captureFrame();
        if (!frame) return;

        // Cheap geometry-only pass first; only pay for identification once a
        // card is actually in frame.
        const detection = await scanSelectDetector.detect(frame);
        if (!detection.found) return;

        const now = Date.now();
        if (now - lastMatchTime < MATCH_COOLDOWN) return;

        // Identify in the worker, restricted to this folder's illustrations.
        const best = await scanSelectDetector.identify(
          frame,
          folderIllustrations,
        );

        if (best.match && best.match.confidence > 50) {
          lastMatchTime = now;
          const match = best.match;

          // Find the card(s) in this folder with this illustration
          const folderCards = await collectionStore.getCardsByFolder(
            currentFolderId!,
          );
          const matchedCards = folderCards.filter(
            (c) => c.illustrationId === match.illustrationId,
          );

          // Select all matching cards
          for (const card of matchedCards) {
            selectedCardIds.add(card.id);
          }

          // Update UI
          const resultsEl = el.querySelector<HTMLElement>(
            "#scan-select-results",
          )!;
          const matchName = matchedCards[0]?.name || "Unknown";
          resultsEl.innerHTML = `
            <div class="scan-match-result">
              Selected: ${escapeHtml(matchName)} (${match.confidence}%)
            </div>
          ` + resultsEl.innerHTML;

          // Update card list selection visual
          el.querySelectorAll<HTMLElement>(".card-item").forEach((item) => {
            item.classList.toggle(
              "selected",
              selectedCardIds.has(item.dataset.cardId!),
            );
          });
          updateSelectionBar();

          statusEl.textContent =
            `${selectedCardIds.size} card(s) selected. Keep scanning...`;
        }
      } finally {
        isProcessing = false;
      }
    });
  }

  function stopScanSelect() {
    scanSelectMode = false;

    if (scanSelectCamera) {
      scanSelectCamera.stop();
      scanSelectCamera = null;
    }
    if (scanSelectDetector) {
      scanSelectDetector.destroy();
      scanSelectDetector = null;
    }

    const overlay = el.querySelector<HTMLElement>("#scan-select-overlay")!;
    overlay.classList.add("hidden");

    // Clear scan results
    el.querySelector<HTMLElement>("#scan-select-results")!.innerHTML = "";

    // Update the card list to show selections
    updateSelectionBar();
  }

  // ─── Navigation ─────────────────────────────────────────────────

  function handleBack() {
    if (scanSelectMode) {
      stopScanSelect();
    }
    currentFolderId = null;
    selectMode = false;
    selectedCardIds.clear();
    showFolderList();
  }

  function showFolderList() {
    el.querySelector<HTMLElement>("#folder-list")!.classList.remove("hidden");
    el.querySelector<HTMLElement>("#folder-detail")!.classList.add("hidden");
    el.querySelector<HTMLElement>("#collection-header")!.classList.remove(
      "hidden",
    );
    el.querySelector<HTMLElement>("#selection-bar")!.classList.add("hidden");
    renderFolderList();
  }

  function showFolderDetail() {
    el.querySelector<HTMLElement>("#folder-list")!.classList.add("hidden");
    el.querySelector<HTMLElement>("#folder-detail")!.classList.remove("hidden");
    el.querySelector<HTMLElement>("#collection-header")!.classList.add(
      "hidden",
    );
  }

  // ─── Folder Actions ─────────────────────────────────────────────

  async function handleAddFolder() {
    const name = prompt("Folder name:");
    if (!name?.trim()) return;
    await collectionStore.createFolder(name.trim());
    await renderFolderList();
  }

  async function handleExport() {
    const format = prompt("Export format: json or csv", "json");
    if (format === "csv") {
      await exportAsCSV();
    } else {
      await exportAsJSON();
    }
  }

  async function handleImport() {
    try {
      const result = await importFromJSON();
      alert(`Imported ${result.folders} folders and ${result.cards} cards.`);
      await renderFolderList();
    } catch (err) {
      alert(`Import failed: ${(err as Error).message}`);
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  function destroy() {
    if (scanSelectMode) stopScanSelect();
    currentFolderId = null;
    selectMode = false;
    selectedCardIds.clear();
  }

  return { el, init, destroy };
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
