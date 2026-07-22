import { Camera } from "../camera/capture.ts";
import { CardDetector, DetectionResult } from "../detection/detector.ts";
import { HashDB } from "../matching/hashdb.ts";
import { matchArtOrientations } from "../detection/identify.ts";
import { type StagedCard, StagingList } from "../collection/staging.ts";
import { collectionStore, type Folder } from "../collection/store.ts";

// Metadata type matching what build-hashdb.ts generates
interface CardMetadata {
  illustrations: Record<string, {
    oracle_id: string;
    name: string;
    printings: {
      id: string;
      set: string;
      set_name: string;
      collector_number: string;
      lang: string;
      released_at: string;
    }[];
  }>;
}

export function ScannerView(container: HTMLElement) {
  const el = document.createElement("div");
  el.className = "view scanner-view";
  container.appendChild(el);

  let camera: Camera | null = null;
  let detector: CardDetector | null = null;
  let hashDB: HashDB | null = null;
  let metadata: CardMetadata | null = null;
  let isProcessing = false;
  let lastDetection: DetectionResult | null = null;
  let destinationFolderId: string | null = null;
  const staging = new StagingList();

  // Stability tracking for auto-capture
  let stableFrameCount = 0;
  let lastCorners: [number, number][] | null = null;
  const STABLE_THRESHOLD = 15;
  const CORNER_TOLERANCE = 15;
  let lastCaptureTime = 0;
  const CAPTURE_COOLDOWN = 2000; // ms between captures to avoid duplicates

  // Minimum match confidence (%) required to accept a card into staging.
  // Below this the guess is still shown (in red) so the user can see what the
  // scanner thinks it is, but it is not added to the collection.
  const MIN_CONFIDENCE = 20;

  el.innerHTML = `
    <div class="scanner-status" id="scanner-status">Loading...</div>
    <div class="camera-container">
      <video id="camera-video" playsinline autoplay muted></video>
      <canvas id="overlay-canvas"></canvas>
    </div>
    <div class="scanner-controls">
      <div class="scanner-controls-left">
        <select id="folder-select" class="folder-select">
          <option value="">Select folder...</option>
        </select>
      </div>
      <button class="capture-btn" id="capture-btn" title="Capture" disabled></button>
      <div class="scanner-controls-right">
        <button class="btn-sm btn-staging" id="btn-staging" disabled>
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
    const folderSelect = el.querySelector<HTMLSelectElement>("#folder-select")!;
    const stagingBtn = el.querySelector<HTMLButtonElement>("#btn-staging")!;

    // Load folder list
    await populateFolderSelect(folderSelect);

    folderSelect.addEventListener("change", () => {
      destinationFolderId = folderSelect.value || null;
    });

    // Load hash database and metadata
    statusEl.textContent = "Loading card database...";
    try {
      const [db, meta] = await Promise.all([
        HashDB.load("/db/hash-db.bin"),
        fetch("/db/metadata.json").then((r) => r.json()) as Promise<
          CardMetadata
        >,
      ]);
      hashDB = db;
      metadata = meta;
      statusEl.textContent = `DB loaded: ${db.size} cards. Loading OpenCV...`;
    } catch {
      statusEl.textContent = "No card database found. Run db:build first.";
      // Continue without DB — camera still works for testing
    }

    // Initialize detector (loads OpenCV in worker)
    detector = new CardDetector();
    statusEl.textContent = "Card Detector initializing...";
    detector
      .waitUntilReady()
      .then(() => {
        statusEl.textContent = hashDB
          ? "Ready - point at a card"
          : "OpenCV ready (no DB - detection only)";
      })
      .catch((err) => {
        statusEl.textContent = `OpenCV failed: ${err.message}`;
        statusEl.style.background = "rgba(233, 69, 96, 0.9)";
      });

    // Initialize camera
    statusEl.textContent = "Camera initializing...";
    camera = new Camera(videoEl);
    try {
      await camera.start({ facingMode: "environment" });
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
    staging.onChange(() => {
      const countEl = el.querySelector<HTMLElement>("#staging-count")!;
      countEl.textContent = staging.totalQuantity.toString();
      stagingBtn.disabled = staging.count === 0;
    });

    statusEl.textContent = "Initialization complete";
  }

  async function populateFolderSelect(select: HTMLSelectElement) {
    const folders = await collectionStore.getAllFolders();
    select.innerHTML = `<option value="">Select folder...</option>` +
      folders.map((f) =>
        `<option value="${f.id}">${escapeHtml(f.name)}</option>`
      ).join("");

    // Default to "Unsorted" folder
    const defaultFolder = folders.find((f) => f.isDefault);
    if (defaultFolder) {
      select.value = defaultFolder.id;
      destinationFolderId = defaultFolder.id;
    }
  }

  async function processFrame(overlayCanvas: HTMLCanvasElement) {
    if (!camera || !detector || !detector.isReady || isProcessing) return;
    isProcessing = true;

    try {
      const frame = camera.captureFrame();
      if (!frame) return;

      const result = await detector.detect(frame);
      lastDetection = result;
      drawOverlay(overlayCanvas, result);

      // Stability tracking
      if (result.found && result.corners) {
        if (cornersAreStable(result.corners)) {
          stableFrameCount++;
          if (stableFrameCount >= STABLE_THRESHOLD) {
            const now = Date.now();
            if (now - lastCaptureTime > CAPTURE_COOLDOWN) {
              lastCaptureTime = now;
              await handleCapture(result);
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

  async function handleCapture(result: DetectionResult) {
    if (!result.artRegions || !hashDB || !metadata) return;

    const statusEl = el.querySelector<HTMLElement>("#scanner-status")!;
    statusEl.textContent = "Matching...";

    // Match across all four card orientations, keeping the best.
    const best = matchArtOrientations(hashDB, result.artRegions);

    if (!best) {
      statusEl.textContent = "No match found. Try again.";
      setTimeout(() => {
        statusEl.textContent = "Ready - point at a card";
      }, 2000);
      return;
    }

    const bestMatch = best.match;
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
      setTimeout(() => {
        statusEl.style.color = "";
        statusEl.textContent = "Ready - point at a card";
      }, 2000);
      return;
    }

    // Use the most recent English printing as default
    const defaultPrinting = illustration.printings
      .filter((p) => p.lang === "en")
      .sort((a, b) => b.released_at.localeCompare(a.released_at))[0] ||
      illustration.printings[0];

    // Add to staging
    staging.add({
      illustrationId: bestMatch.illustrationId,
      scryfallId: defaultPrinting.id,
      oracleId: illustration.oracle_id,
      name: illustration.name,
      setCode: defaultPrinting.set,
      setName: defaultPrinting.set_name,
      collectorNumber: defaultPrinting.collector_number,
      quantity: 1,
      condition: "NM",
      confidence: bestMatch.confidence,
      alternativePrintings: illustration.printings.map((p) => ({
        scryfallId: p.id,
        setCode: p.set,
        setName: p.set_name,
        collectorNumber: p.collector_number,
        lang: p.lang,
      })),
    });

    statusEl.style.color = "";
    statusEl.textContent = `${illustration.name} (${bestMatch.confidence}%)`;
    setTimeout(() => {
      statusEl.textContent = "Ready - point at a card";
    }, 2000);
  }

  function handleManualCapture() {
    if (lastDetection?.found) {
      handleCapture(lastDetection);
    } else {
      const statusEl = el.querySelector<HTMLElement>("#scanner-status")!;
      statusEl.textContent = "No card detected";
      setTimeout(() => {
        statusEl.textContent = "Ready - point at a card";
      }, 1500);
    }
  }

  function showStagingReview() {
    // Replace main content with staging review
    const items = staging.getAll();
    if (items.length === 0) return;

    const reviewHtml = `
      <div class="staging-review">
        <div class="staging-review-header">
          <h2>Review Scanned Cards (${staging.totalQuantity})</h2>
          <button class="btn-sm" id="btn-close-staging">Close</button>
        </div>
        <div class="staging-list">
          ${items.map((item) => renderStagedCard(item)).join("")}
        </div>
        <div class="staging-actions">
          <button class="btn-sm" id="btn-clear-staging">Clear All</button>
          <button class="btn-primary" id="btn-confirm-staging" ${
      !destinationFolderId ? "disabled" : ""
    }>
            Add to Collection
          </button>
        </div>
      </div>
    `;

    const overlay = document.createElement("div");
    overlay.className = "staging-overlay";
    overlay.innerHTML = reviewHtml;
    el.appendChild(overlay);

    // Event handlers
    overlay.querySelector("#btn-close-staging")!.addEventListener(
      "click",
      () => {
        overlay.remove();
      },
    );

    overlay.querySelector("#btn-clear-staging")!.addEventListener(
      "click",
      () => {
        staging.clear();
        overlay.remove();
      },
    );

    overlay.querySelector("#btn-confirm-staging")!.addEventListener(
      "click",
      async () => {
        await confirmStaging();
        overlay.remove();
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
  }

  function renderStagedCard(item: StagedCard): string {
    return `
      <div class="staged-card" data-id="${item.id}">
        <div class="staged-info">
          <span class="card-name">${escapeHtml(item.name)}</span>
          <span class="card-set">${item.setCode.toUpperCase()} #${item.collectorNumber}</span>
          <span class="staged-confidence">${item.confidence}% match</span>
        </div>
        <div class="staged-actions">
          <span class="card-qty">&times;${item.quantity}</span>
          <button class="btn-sm staged-remove" data-id="${item.id}">Remove</button>
        </div>
      </div>
    `;
  }

  async function confirmStaging() {
    if (!destinationFolderId) return;

    const items = staging.getAll();
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
      });
    }

    const statusEl = el.querySelector<HTMLElement>("#scanner-status")!;
    statusEl.textContent =
      `Added ${staging.totalQuantity} card(s) to collection!`;
    staging.clear();

    setTimeout(() => {
      statusEl.textContent = "Ready - point at a card";
    }, 2000);
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
    stableFrameCount = 0;
    lastCorners = null;
    lastDetection = null;
  }

  return { el, init, destroy };
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
