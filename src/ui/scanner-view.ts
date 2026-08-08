import { Camera } from "../camera/capture.ts";
import { CardDetector, DetectionResult } from "../detection/detector.ts";
import {
  type AlternativePrinting,
  type StagedCard,
  StagingList,
} from "../collection/staging.ts";
import { type CardEntry, collectionStore } from "../collection/store.ts";
import {
  type CardMetadata,
  defaultPrintingFor,
  groupedCardSearch,
  printingsForName,
} from "../collection/card-search.ts";
import { loadMetadata } from "../collection/metadata-loader.ts";
import { ScanDedupTracker } from "./scan-dedup.ts";
import { getCardImageUrl } from "../collection/card-image.ts";
import { openMergeView } from "./merge-view.ts";
import { showPrintingPicker } from "./printing-picker.ts";
import { showToast } from "./toast.ts";
import {
  type MergeMode,
  validateMergeSelection,
} from "../collection/merge-validation.ts";

type ScanMode = MergeMode;

export function ScannerView(container: HTMLElement) {
  const el = document.createElement("div");
  el.className = "view scanner-view";
  container.appendChild(el);

  let camera: Camera | null = null;
  let detector: CardDetector | null = null;
  let metadata: CardMetadata | null = null;
  let isProcessing = false;
  // True while the staging review overlay covers the camera feed — scans
  // must not keep matching/adding cards to the list the user is reviewing.
  let scanningPaused = false;
  let lastDetection: DetectionResult | null = null;
  /** The frame that produced `lastDetection`, kept so it can be identified. */
  let lastFrame: ImageData | null = null;
  let destinationFolderId: string | null = null;
  let secondaryFolderId: string | null = null; // "To" folder, only used in Move mode
  let mode: ScanMode = "add";
  const staging = new StagingList();

  // Frame sampling rate for the detection loop. Detection doesn't benefit from
  // display-rate sampling and running it flat out drains the battery.
  const TARGET_FPS = 20;

  // Stability tracking for auto-capture. At TARGET_FPS, 8 frames is ~0.4s of
  // holding the card steady.
  let stableFrameCount = 0;
  let lastCorners: [number, number][] | null = null;
  const STABLE_THRESHOLD = 8;
  const CORNER_TOLERANCE = 15;
  let lastCaptureTime = 0;
  const CAPTURE_COOLDOWN = 2000; // ms between captures to avoid duplicates

  // Suppress re-adding the same card while it just sits in view. Cleared once
  // the view has been empty for a bit, so removing and re-showing the same
  // card is treated as a fresh scan.
  const dedup = new ScanDedupTracker(500);

  // Minimum match confidence (%) required to accept a card into staging.
  // Below this the guess is still shown (in red) so the user can see what the
  // scanner thinks it is, but it is not added to the collection.
  const MIN_CONFIDENCE = 20;

  // How long the matched-card splash stays on screen.
  const SPLASH_DURATION = 2000;
  let splashTimer: ReturnType<typeof setTimeout> | null = null;

  el.innerHTML = `
    <div class="scanner-status" id="scanner-status">Loading...</div>
    <div class="camera-container">
      <video id="camera-video" playsinline autoplay muted></video>
      <canvas id="overlay-canvas"></canvas>
      <div class="match-splash hidden" id="match-splash">
        <canvas id="match-splash-canvas"></canvas>
        <div class="match-splash-label">
          <span class="match-splash-name" id="match-splash-name"></span>
          <span class="match-splash-confidence" id="match-splash-confidence"></span>
        </div>
      </div>
    </div>
    <div class="scanner-controls">
      <button class="capture-btn" id="capture-btn" title="Capture" disabled></button>
      <div class="scanner-controls-right">
        <button class="btn-sm btn-staging" id="btn-staging" enabled>
          Staged: <span id="staging-count">0</span>
        </button>
      </div>
    </div>
  `;

  async function init() {
    const videoEl = el.querySelector<HTMLVideoElement>("#camera-video")!;
    const statusEl = el.querySelector<HTMLElement>("#scanner-status")!;
    const captureBtn = el.querySelector<HTMLButtonElement>("#capture-btn")!;
    const overlayCanvas = el.querySelector<HTMLCanvasElement>(
      "#overlay-canvas",
    )!;
    const stagingBtn = el.querySelector<HTMLButtonElement>("#btn-staging")!;

    // Load card metadata (names/printings for display) via the shared
    // cached loader — the ~14 MB JSON.parse is slow enough to jank the UI if
    // done inline on the main thread, so it happens in a worker. The hash
    // database itself lives in the detection worker.
    statusEl.textContent = "Loading card metadata...";
    metadata = await loadMetadata();
    if (!metadata) {
      statusEl.textContent = "No card database found. Run db:build first.";
      // Continue without metadata — camera still works for testing
    }

    // Initialize detector (loads OpenCV and the hash DB in the worker)
    detector = new CardDetector();
    statusEl.textContent = "Card Detector initializing...";
    detector
      .waitUntilReady()
      .then(() => {
        statusEl.textContent = detector!.dbSize > 0
          ? `Ready - point at a card (${detector!.dbSize} cards)`
          : "OpenCV ready (no DB - detection only)";
      })
      .catch((err) => {
        const msg = `OpenCV failed: ${err.message}`;
        console.error(msg);
        statusEl.textContent = msg;
        statusEl.style.background = "rgba(233, 69, 96, 0.9)";
      });

    // Initialize camera
    statusEl.textContent = "Camera initializing...";
    camera = new Camera(videoEl);
    try {
      await camera.start({ facingMode: "environment", targetFps: TARGET_FPS });
      captureBtn.disabled = false;
      overlayCanvas.width = camera.videoWidth;
      overlayCanvas.height = camera.videoHeight;
      camera.setFrameHandler(() => processFrame(overlayCanvas));
    } catch (err) {
      statusEl.textContent = `Camera error: ${(err as Error).message}`;
      statusEl.style.background = "rgba(233, 69, 96, 0.9)";
    }

    // Event listeners
    captureBtn.addEventListener("click", handleManualCapture);
    stagingBtn.addEventListener("click", showStagingReview);

    // Update staging count display
    const updateStagingCount = () => {
      const countEl = el.querySelector<HTMLElement>("#staging-count")!;
      countEl.textContent = staging.totalQuantity.toString();
      // Always enabled: staging review is also where cards are added manually.
    };
    staging.onChange(updateStagingCount);
    updateStagingCount(); // sync with any items rehydrated from a previous session

    statusEl.textContent = "Initialization complete";
  }

  async function populateFolderSelect(select: HTMLSelectElement) {
    const folders = await collectionStore.getAllFolders();
    select.innerHTML = `<option value="">Select folder...</option>` +
      folders.map((f) =>
        `<option value="${f.id}">${escapeHtml(f.name)}</option>`
      ).join("");

    if (select.id === "folder-select") {
      // Restore a previously-chosen folder (persists across reopening the
      // staging review), otherwise default to "Unsorted".
      const defaultFolder = folders.find((f) => f.isDefault);
      const preselect = destinationFolderId ?? defaultFolder?.id;
      if (preselect) {
        select.value = preselect;
        destinationFolderId = preselect;
      }
    } else if (secondaryFolderId) {
      select.value = secondaryFolderId;
    }
  }

  async function processFrame(overlayCanvas: HTMLCanvasElement) {
    if (
      !camera || !detector || !detector.isReady || isProcessing ||
      scanningPaused
    ) return;

    isProcessing = true;

    try {
      const frame = camera.captureFrame();
      if (!frame) return;

      const result = await detector.detect(frame);
      lastDetection = result;
      lastFrame = frame;
      drawOverlay(overlayCanvas, result);

      // Stability tracking
      if (result.found && result.corners) {
        dedup.onFound();
        if (cornersAreStable(result.corners)) {
          stableFrameCount++;
          if (stableFrameCount >= STABLE_THRESHOLD) {
            const now = Date.now();
            if (now - lastCaptureTime > CAPTURE_COOLDOWN) {
              lastCaptureTime = now;
              await handleCapture(frame);
            }
            stableFrameCount = 0;
          }
        } else {
          stableFrameCount = 0;
        }
        lastCorners = result.corners;
      } else {
        stableFrameCount = 0;
        lastCorners = null;
        dedup.onNotFound(Date.now());
      }
    } finally {
      isProcessing = false;
    }
  }

  function cornersAreStable(corners: [number, number][]): boolean {
    if (!lastCorners) return false;
    for (let i = 0; i < 4; i++) {
      const dx = Math.abs(corners[i][0] - lastCorners[i][0]);
      const dy = Math.abs(corners[i][1] - lastCorners[i][1]);
      if (dx > CORNER_TOLERANCE || dy > CORNER_TOLERANCE) return false;
    }
    return true;
  }

  async function handleCapture(frame: ImageData) {
    if (!detector || !metadata) return;

    const statusEl = el.querySelector<HTMLElement>("#scanner-status")!;
    statusEl.textContent = "Matching...";

    // Full identification happens in the worker, which owns OpenCV and the
    // hash database: detect → warp → hash both portrait orientations → match.
    const best = await detector.identify(frame);

    const bestMatch = best.match;
    if (!bestMatch) {
      statusEl.textContent = "No match found. Try again.";
      setTimeout(() => {
        statusEl.textContent = "Ready - point at a card";
      }, 2000);
      return;
    }

    const illustration = metadata.illustrations[bestMatch.illustrationId];

    if (!illustration) {
      statusEl.textContent =
        "Match found but no metadata. DB may be incomplete.";
      setTimeout(() => {
        statusEl.textContent = "Ready - point at a card";
      }, 2000);
      return;
    }

    // Below the confidence threshold: show the guess (with its %) in red so the
    // user can see what the scanner thinks it is, but do NOT add it to staging.
    if (bestMatch.confidence < MIN_CONFIDENCE) {
      statusEl.style.color = "#e94560";
      statusEl.textContent =
        `${illustration.name}? (${bestMatch.confidence}% - too low)`;
      showMatchSplash(
        best.cardImage,
        illustration.name,
        bestMatch.confidence,
        false,
      );
      setTimeout(() => {
        statusEl.style.color = "";
        statusEl.textContent = "Ready - point at a card";
      }, 2000);
      return;
    }

    // Use the most recent English printing as default
    const defaultPrinting = defaultPrintingFor(illustration);

    // Same physical card still sitting in view: skip re-adding unless the
    // view has been empty for a bit (card removed and re-shown = fresh scan).
    const lastStaged = staging.getAll().at(-1);
    if (dedup.shouldSkip(defaultPrinting.id, lastStaged?.scryfallId)) {
      statusEl.style.color = "";
      statusEl.textContent = `${illustration.name} (${bestMatch.confidence}%)`;
      showMatchSplash(
        best.cardImage,
        illustration.name,
        bestMatch.confidence,
        true,
      );
      setTimeout(() => {
        statusEl.textContent = "Ready - point at a card";
      }, 2000);
      return;
    }

    // Add to staging
    addIllustrationToStaging(
      bestMatch.illustrationId,
      illustration,
      defaultPrinting,
      bestMatch.confidence,
    );
    dedup.recordCapture();

    statusEl.style.color = "";
    statusEl.textContent = `${illustration.name} (${bestMatch.confidence}%)`;
    showMatchSplash(
      best.cardImage,
      illustration.name,
      bestMatch.confidence,
      true,
    );
    setTimeout(() => {
      statusEl.textContent = "Ready - point at a card";
    }, 2000);
  }

  /** Add a matched illustration+printing to staging (used by scan capture and manual search-add). */
  function addIllustrationToStaging(
    illustrationId: string,
    illustration: CardMetadata["illustrations"][string],
    printing: CardMetadata["illustrations"][string]["printings"][number],
    confidence: number,
  ) {
    const alternatives = metadata
      ? printingsForName(metadata, illustration.name)
      : illustration.printings.map((p) => ({ ...p, illustrationId }));
    staging.add({
      illustrationId,
      scryfallId: printing.id,
      oracleId: illustration.oracle_id,
      name: illustration.name,
      setCode: printing.set,
      setName: printing.set_name,
      collectorNumber: printing.collector_number,
      quantity: 1,
      condition: "NM",
      confidence,
      cmc: illustration.cmc,
      colors: illustration.colors,
      rarity: printing.rarity,
      alternativePrintings: alternatives,
    });
  }

  function handleManualCapture() {
    if (lastDetection?.found && lastFrame) {
      handleCapture(lastFrame);
    } else {
      const statusEl = el.querySelector<HTMLElement>("#scanner-status")!;
      statusEl.textContent = "No card detected";
      setTimeout(() => {
        statusEl.textContent = "Ready - point at a card";
      }, 1500);
    }
  }

  async function showStagingReview() {
    // Replace main content with staging review
    const items = staging.getAll();

    const confirmDisabled =
      validateMergeSelection(mode, destinationFolderId, secondaryFolderId) !==
        null;
    const confirmLabel = mode === "add"
      ? "Add to Collection"
      : mode === "remove"
      ? "Remove from Collection"
      : "Move to Collection";

    const stagedCardsHtml = items.length > 0
      ? (await Promise.all(items.map((item) => renderStagedCard(item))))
        .join("")
      : `<p class="staging-empty">No cards staged yet.</p>`;

    const reviewHtml = `
      <div class="staging-review">
        <div class="staging-review-header">
          <h2>Review Scanned Cards (${staging.totalQuantity})</h2>
          <button class="btn-sm" id="btn-close-staging">Close</button>
        </div>
        <div class="staging-search">
          <input type="text" id="staging-search-input" class="staging-search-input"
            placeholder="Search card name to add manually..." autocomplete="off" />
          <ul class="staging-search-results hidden" id="staging-search-results"></ul>
        </div>
        <div class="staging-list">
          ${stagedCardsHtml}
        </div>
        <div class="staging-target">
          <select id="mode-select" class="mode-select">
            <option value="add">Add</option>
            <option value="remove">Remove</option>
            <option value="move">Move</option>
          </select>
          <select id="folder-select" class="folder-select">
            <option value="">Select folder...</option>
          </select>
          <select id="dest-folder-select" class="folder-select ${
      mode !== "move" ? "hidden" : ""
    }">
            <option value="">Select folder...</option>
          </select>
        </div>
        <div class="staging-actions">
          <button class="btn-sm" id="btn-clear-staging">Clear All</button>
          <button class="btn-primary" id="btn-confirm-staging" ${
      confirmDisabled || items.length === 0 ? "disabled" : ""
    }>
            ${confirmLabel}
          </button>
        </div>
      </div>
    `;

    const overlay = document.createElement("div");
    overlay.className = "staging-overlay";
    overlay.innerHTML = reviewHtml;
    el.appendChild(overlay);

    const modeSelect = overlay.querySelector<HTMLSelectElement>(
      "#mode-select",
    )!;
    const folderSelect = overlay.querySelector<HTMLSelectElement>(
      "#folder-select",
    )!;
    const destFolderSelect = overlay.querySelector<HTMLSelectElement>(
      "#dest-folder-select",
    )!;
    modeSelect.value = mode;
    await populateFolderSelect(folderSelect);
    await populateFolderSelect(destFolderSelect);

    modeSelect.addEventListener("change", () => {
      mode = modeSelect.value as ScanMode;
      overlay.remove();
      showStagingReview();
    });
    folderSelect.addEventListener("change", () => {
      destinationFolderId = folderSelect.value || null;
      overlay.remove();
      showStagingReview();
    });
    destFolderSelect.addEventListener("change", () => {
      secondaryFolderId = destFolderSelect.value || null;
      overlay.remove();
      showStagingReview();
    });

    // Pause scanning while the overlay covers the camera feed — otherwise
    // scans keep matching and mutating the list underneath the user.
    scanningPaused = true;
    const closeOverlay = () => {
      scanningPaused = false;
      overlay.remove();
    };

    // Event handlers
    overlay.querySelector("#btn-close-staging")!.addEventListener(
      "click",
      () => {
        closeOverlay();
      },
    );

    overlay.querySelector("#btn-clear-staging")!.addEventListener(
      "click",
      () => {
        staging.clear();
        closeOverlay();
      },
    );

    overlay.querySelector("#btn-confirm-staging")!.addEventListener(
      "click",
      async () => {
        await confirmStaging();
        closeOverlay();
      },
    );

    // Remove buttons
    overlay.querySelectorAll<HTMLElement>(".staged-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id!;
        staging.remove(id);
        btn.closest(".staged-card")?.remove();
        // Update count in header
        const header = overlay.querySelector("h2")!;
        header.textContent = `Review Scanned Cards (${staging.totalQuantity})`;
      });
    });

    // Quantity +/- buttons
    overlay.querySelectorAll<HTMLElement>(".staged-qty-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id!;
        const delta = Number(btn.dataset.delta);
        const item = staging.getAll().find((i) => i.id === id);
        if (!item) return;
        staging.setQuantity(id, item.quantity + delta);
        const qtyEl = overlay.querySelector<HTMLElement>(
          `.staged-card[data-id="${id}"] .card-qty`,
        )!;
        qtyEl.textContent = `\u00d7${
          staging.getAll().find((i) => i.id === id)!.quantity
        }`;
        const header = overlay.querySelector("h2")!;
        header.textContent = `Review Scanned Cards (${staging.totalQuantity})`;
      });
    });

    // Change-printing buttons
    overlay.querySelectorAll<HTMLElement>(".staged-change-printing").forEach(
      (btn) => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.id!;
          const item = staging.getAll().find((i) => i.id === id);
          if (!item || !item.alternativePrintings?.length) return;
          showPrintingPicker({
            container: el,
            cardName: item.name,
            printings: item.alternativePrintings,
            currentScryfallId: item.scryfallId,
            onSelect: (printing: AlternativePrinting) => {
              staging.changePrinting(id, printing);
              overlay.remove();
              showStagingReview();
            },
          });
        });
      },
    );

    // Manual search-to-add
    const searchInput = overlay.querySelector<HTMLInputElement>(
      "#staging-search-input",
    )!;
    const resultsEl = overlay.querySelector<HTMLElement>(
      "#staging-search-results",
    )!;

    searchInput.addEventListener("input", () => {
      if (!metadata) return;
      const matches = groupedCardSearch(metadata, searchInput.value);
      if (matches.length === 0) {
        resultsEl.classList.add("hidden");
        resultsEl.innerHTML = "";
        return;
      }
      resultsEl.innerHTML = matches.map((m) => `
          <li class="staging-search-result" data-name="${escapeHtml(m.name)}">
            <span class="card-name">${escapeHtml(m.name)}</span>
          </li>
        `).join("");
      resultsEl.classList.remove("hidden");

      resultsEl.querySelectorAll<HTMLElement>(".staging-search-result")
        .forEach((li) => {
          li.addEventListener("click", () => {
            const name = li.dataset.name!;
            const printings = printingsForName(metadata!, name);
            resultsEl.classList.add("hidden");
            showPrintingPicker({
              container: el,
              cardName: name,
              printings,
              onSelect: (printing) => {
                const illustration = metadata!.illustrations[
                  printing.illustrationId
                ];
                addIllustrationToStaging(
                  printing.illustrationId,
                  illustration,
                  printing,
                  100,
                );
                overlay.remove();
                showStagingReview();
              },
            });
          });
        });
    });

    // Click outside results closes the dropdown
    overlay.addEventListener("click", (e) => {
      if (
        e.target !== searchInput && !resultsEl.contains(e.target as Node)
      ) {
        resultsEl.classList.add("hidden");
      }
    });
  }

  async function renderStagedCard(item: StagedCard): Promise<string> {
    return `
      <div class="staged-card" data-id="${item.id}">
        <img class="card-thumb" crossorigin="anonymous" src="${await getCardImageUrl(
      item.scryfallId,
    )}" alt="" loading="lazy" onerror="this.classList.add('card-thumb-blank');this.removeAttribute('src')" />
        <div class="staged-info">
          <span class="card-name">${escapeHtml(item.name)}</span>
          <span class="card-set">${item.setCode.toUpperCase()} #${item.collectorNumber}</span>
          <span class="staged-confidence">${item.confidence}% match</span>
        </div>
        <div class="staged-actions">
          <button class="btn-sm staged-qty-btn" data-id="${item.id}" data-delta="-1">-</button>
          <span class="card-qty">&times;${item.quantity}</span>
          <button class="btn-sm staged-qty-btn" data-id="${item.id}" data-delta="1">+</button>
          <button class="btn-sm staged-change-printing" data-id="${item.id}" title="Change printing">Printing</button>
          <button class="btn-sm staged-remove" data-id="${item.id}">Remove</button>
        </div>
      </div>
    `;
  }

  /**
   * Resolve a scanned staged card to an existing CardEntry in a folder: try
   * the exact printing first, then fall back to any printing of the same
   * illustration (the folder may hold a different printing than was scanned).
   */
  async function resolveEntry(
    folderId: string,
    item: StagedCard,
  ): Promise<CardEntry | undefined> {
    return (await collectionStore.findCardInFolder(
      folderId,
      item.scryfallId,
    )) ??
      (await collectionStore.findCardInFolderByIllustration(
        folderId,
        item.illustrationId,
      ));
  }

  /**
   * Resolve a scanned staged card against an already-fetched folder card
   * list (sync, no store round-trip) — used to build the merge-view preview
   * with the same matching rules as `resolveEntry`.
   */
  function resolveFromList(
    cards: CardEntry[],
    item: StagedCard,
  ): CardEntry | undefined {
    return cards.find((c) => c.scryfallId === item.scryfallId) ??
      cards.find((c) => c.illustrationId === item.illustrationId);
  }

  /** Simulate applying an Add of `items` onto `cards` (for merge-view preview). */
  function simulateAdd(
    cards: CardEntry[],
    items: readonly StagedCard[],
  ): CardEntry[] {
    const result = cards.map((c) => ({ ...c }));
    for (const item of items) {
      const existing = result.find((c) => c.scryfallId === item.scryfallId);
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        result.push({
          id: item.id,
          folderId: "",
          scryfallId: item.scryfallId,
          illustrationId: item.illustrationId,
          oracleId: item.oracleId,
          name: item.name,
          setCode: item.setCode,
          setName: item.setName,
          collectorNumber: item.collectorNumber,
          quantity: item.quantity,
          condition: item.condition,
          notes: "",
          dateAdded: "",
          cmc: item.cmc,
          colors: item.colors,
          rarity: item.rarity,
        });
      }
    }
    return result;
  }

  /**
   * Simulate removing `items`' quantities from `cards` (for merge-view
   * preview). Cards that would drop to 0 are dropped entirely, matching
   * `computeDiff`'s "removed" semantics.
   */
  function simulateRemove(
    cards: CardEntry[],
    items: readonly StagedCard[],
  ): CardEntry[] {
    const result = cards.map((c) => ({ ...c }));
    for (const item of items) {
      const entry = resolveFromList(result, item);
      if (!entry) continue;
      entry.quantity = Math.max(0, entry.quantity - item.quantity);
    }
    return result.filter((c) => c.quantity > 0);
  }

  async function confirmStaging() {
    const error = validateMergeSelection(
      mode,
      destinationFolderId,
      secondaryFolderId,
    );
    if (error) {
      showToast(error);
      return;
    }
    if (!destinationFolderId) return; // for type narrowing, validated above

    const items = staging.getAll();

    if (mode === "add") {
      const destCards = await collectionStore.getCardsByFolder(
        destinationFolderId,
      );
      openMergeView({
        container: el,
        stagingCards: items as StagedCard[],
        panels: [
          {
            title: "Destination",
            before: destCards,
            after: simulateAdd(destCards, items),
          },
        ],
        confirmLabel: "Add to Collection",
        onConfirm: () => commitStaging(),
      });
    } else if (mode === "remove") {
      const destCards = await collectionStore.getCardsByFolder(
        destinationFolderId,
      );
      const skipped = items.filter((item) =>
        !resolveFromList(destCards, item)
      ).length;
      openMergeView({
        container: el,
        stagingCards: items as StagedCard[],
        panels: [
          {
            title: "Source",
            before: destCards,
            after: simulateRemove(destCards, items),
          },
        ],
        skippedCount: skipped,
        confirmLabel: "Remove from Collection",
        onConfirm: () => commitStaging(),
      });
    } else {
      // move
      const sourceCards = await collectionStore.getCardsByFolder(
        destinationFolderId,
      );
      const destCards = await collectionStore.getCardsByFolder(
        secondaryFolderId!,
      );
      const skipped = items.filter((item) =>
        !resolveFromList(sourceCards, item)
      ).length;
      openMergeView({
        container: el,
        stagingCards: items as StagedCard[],
        panels: [
          {
            title: "Source",
            before: sourceCards,
            after: simulateRemove(sourceCards, items),
          },
          {
            title: "Destination",
            before: destCards,
            after: simulateAdd(destCards, items),
          },
        ],
        skippedCount: skipped,
        confirmLabel: "Move to Collection",
        onConfirm: () => commitStaging(),
      });
    }
  }

  async function commitStaging() {
    if (!destinationFolderId) return;

    const items = staging.getAll();
    const statusEl = el.querySelector<HTMLElement>("#scanner-status")!;
    let skipped = 0;
    const destFolder = await collectionStore.getFolder(destinationFolderId);
    const destName = destFolder?.name ?? "folder";

    if (mode === "add") {
      for (const item of items) {
        await collectionStore.addCard({
          folderId: destinationFolderId,
          scryfallId: item.scryfallId,
          illustrationId: item.illustrationId,
          oracleId: item.oracleId,
          name: item.name,
          setCode: item.setCode,
          setName: item.setName,
          collectorNumber: item.collectorNumber,
          quantity: item.quantity,
          condition: item.condition,
          notes: "",
          cmc: item.cmc,
          colors: item.colors,
          rarity: item.rarity,
        });
      }
      showToast(`Added ${staging.totalQuantity} card(s) to "${destName}"`);
    } else if (mode === "remove") {
      for (const item of items) {
        const entry = await resolveEntry(destinationFolderId, item);
        if (!entry) {
          skipped++;
          continue;
        }
        if (item.quantity >= entry.quantity) {
          await collectionStore.deleteCard(entry.id);
        } else {
          entry.quantity -= item.quantity;
          await collectionStore.putCard(entry);
        }
      }
      const removedCount = items.length - skipped;
      showToast(
        skipped > 0
          ? `Removed ${removedCount} card(s) from "${destName}", ${skipped} skipped (not in folder)`
          : `Removed ${removedCount} card(s) from "${destName}"`,
      );
    } else {
      // move
      if (!secondaryFolderId) return;
      const secondaryFolder = await collectionStore.getFolder(
        secondaryFolderId,
      );
      const secondaryName = secondaryFolder?.name ?? "folder";
      for (const item of items) {
        const entry = await resolveEntry(destinationFolderId, item);
        if (!entry) {
          skipped++;
          continue;
        }
        await collectionStore.moveCard(
          entry.id,
          secondaryFolderId,
          Math.min(item.quantity, entry.quantity),
        );
      }
      const movedCount = items.length - skipped;
      showToast(
        skipped > 0
          ? `Moved ${movedCount} card(s) from "${destName}" to "${secondaryName}", ${skipped} skipped (not in folder)`
          : `Moved ${movedCount} card(s) from "${destName}" to "${secondaryName}"`,
      );
    }

    staging.clear();
    statusEl.textContent = "Ready - point at a card";
  }

  /**
   * Flash the scanned card image in the top-left corner along with the matched
   * name, so the user gets immediate visual confirmation of what was read.
   */
  function showMatchSplash(
    cardImage: ImageData | undefined,
    name: string,
    confidence: number,
    accepted: boolean,
  ) {
    const splash = el.querySelector<HTMLElement>("#match-splash")!;
    const canvas = el.querySelector<HTMLCanvasElement>("#match-splash-canvas")!;
    const nameEl = el.querySelector<HTMLElement>("#match-splash-name")!;
    const confidenceEl = el.querySelector<HTMLElement>(
      "#match-splash-confidence",
    )!;

    if (cardImage) {
      canvas.width = cardImage.width;
      canvas.height = cardImage.height;
      canvas.getContext("2d")!.putImageData(cardImage, 0, 0);
      canvas.classList.remove("hidden");
    } else {
      canvas.classList.add("hidden");
    }

    nameEl.textContent = name;
    confidenceEl.textContent = `${confidence}%`;
    splash.classList.remove("hidden");
    splash.classList.toggle("rejected", !accepted);

    // Restart the entrance animation even if the splash is already showing.
    splash.classList.remove("splash-in");
    void splash.offsetWidth;
    splash.classList.add("splash-in");

    if (splashTimer !== null) clearTimeout(splashTimer);
    splashTimer = setTimeout(() => {
      splash.classList.add("hidden");
      splashTimer = null;
    }, SPLASH_DURATION);
  }

  function drawOverlay(canvas: HTMLCanvasElement, result: DetectionResult) {
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const strokeQuad = (quad: [number, number][]) => {
      ctx.beginPath();
      ctx.moveTo(quad[0][0], quad[0][1]);
      for (let i = 1; i < quad.length; i++) {
        ctx.lineTo(quad[i][0], quad[i][1]);
      }
      ctx.closePath();
      ctx.stroke();
    };

    // Debug: outline every card-shaped candidate the detector considered this
    // frame (yellow), so it's visible what is / isn't being picked up — even
    // when no single card is ultimately selected.
    if (result.candidates && result.candidates.length > 0) {
      const selected = result.corners;
      const sameQuad = (a: [number, number][], b: [number, number][]) =>
        a.length === b.length &&
        a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);
      ctx.strokeStyle = "rgba(255, 214, 0, 0.9)";
      ctx.lineWidth = 2;
      for (const quad of result.candidates) {
        // Skip the selected quad here; it's drawn in green below.
        if (selected && sameQuad(quad, selected)) continue;
        strokeQuad(quad);
      }
    }

    if (result.found && result.corners) {
      const corners = result.corners;

      // Draw card outline
      ctx.strokeStyle = "#4caf50";
      ctx.lineWidth = 3;
      strokeQuad(corners);

      // Corner dots
      ctx.fillStyle = "#e94560";
      for (const corner of corners) {
        ctx.beginPath();
        ctx.arc(corner[0], corner[1], 6, 0, Math.PI * 2);
        ctx.fill();
      }

      // Stability indicator
      if (stableFrameCount > 0) {
        const progress = stableFrameCount / STABLE_THRESHOLD;
        ctx.strokeStyle = `rgba(76, 175, 80, ${0.3 + progress * 0.7})`;
        ctx.lineWidth = 3 + progress * 4;
        strokeQuad(corners);
      }
    }
  }

  function destroy() {
    if (camera) {
      camera.stop();
      camera = null;
    }
    if (detector) {
      detector.destroy();
      detector = null;
    }
    isProcessing = false;
    scanningPaused = false;
    stableFrameCount = 0;
    lastCorners = null;
    lastDetection = null;
    lastFrame = null;
    if (splashTimer !== null) {
      clearTimeout(splashTimer);
      splashTimer = null;
    }
    el.querySelector<HTMLElement>("#match-splash")?.classList.add("hidden");
  }

  return { el, init, destroy };
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
