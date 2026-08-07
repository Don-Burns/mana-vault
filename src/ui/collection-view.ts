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
import { openMergeView } from "./merge-view.ts";
import { localCardImageUrl } from "../collection/card-image.ts";
export function CollectionView(container: HTMLElement) {
  const el = document.createElement("div");
  el.className = "view collection-view";
  container.appendChild(el);

  let currentFolderId: string | null = null;
  let selectedCardIds: Set<string> = new Set();
  let editMode = false;

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
          <button class="btn-sm" id="btn-edit-mode">Edit</button>
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
    <dialog id="move-dialog">
      <select id="move-folder-select"></select>
      <div class="move-dialog-actions">
        <button class="btn-sm" id="btn-move-cancel">Cancel</button>
        <button class="btn-sm" id="btn-move-confirm">Move</button>
      </div>
    </dialog>
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
    el.querySelector("#btn-edit-mode")!.addEventListener(
      "click",
      toggleEditMode,
    );
    el.querySelector("#btn-move-selected")!.addEventListener(
      "click",
      handleMoveSelected,
    );
    el.querySelector("#btn-deselect-all")!.addEventListener(
      "click",
      deselectAll,
    );
    el.querySelector("#btn-move-cancel")!.addEventListener("click", () => {
      (el.querySelector("#move-dialog") as HTMLDialogElement).close();
    });
    el.querySelector("#btn-move-confirm")!.addEventListener(
      "click",
      confirmMove,
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
    editMode = false;

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
      item.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("[data-action]")) return;
        if (editMode) {
          toggleCardSelection(item.dataset.cardId!);
          item.classList.toggle(
            "selected",
            selectedCardIds.has(item.dataset.cardId!),
          );
          updateSelectionBar();
        }
      });
    });

    // Attach handlers for per-row edit controls
    listEl.querySelectorAll<HTMLElement>("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const cardId = btn.dataset.cardId!;
        const action = btn.dataset.action!;
        if (action === "inc") adjustQuantity(cardId, 1);
        else if (action === "dec") adjustQuantity(cardId, -1);
        else if (action === "delete") deleteCardEntry(cardId);
      });
    });
  }

  async function adjustQuantity(cardId: string, delta: number) {
    const card = await collectionStore.getCard(cardId);
    if (!card) return;

    if (card.quantity + delta <= 0) {
      await collectionStore.deleteCard(cardId);
    } else {
      card.quantity += delta;
      await collectionStore.putCard(card);
    }

    selectedCardIds.delete(cardId);
    await renderCardList(currentFolderId!);
    updateSelectionBar();
  }

  async function deleteCardEntry(cardId: string) {
    if (!confirm("Delete this card?")) return;
    await collectionStore.deleteCard(cardId);
    selectedCardIds.delete(cardId);
    await renderCardList(currentFolderId!);
    updateSelectionBar();
  }

  function renderCardItem(card: CardEntry): string {
    const isSelected = selectedCardIds.has(card.id);
    return `
      <div class="card-item ${
      isSelected ? "selected" : ""
    }" data-card-id="${card.id}">
        <img class="card-thumb" src="${
      localCardImageUrl(card.illustrationId)
    }" alt="" loading="lazy" onerror="this.classList.add('card-thumb-blank');this.removeAttribute('src')" />
        <div class="card-info">
          <span class="card-name">${escapeHtml(card.name)}</span>
          <span class="card-set">${card.setCode.toUpperCase()} #${card.collectorNumber}</span>
        </div>
        <div class="card-meta">
          ${
      editMode
        ? `
          <div class="card-qty-stepper">
            <button class="btn-sm" data-action="dec" data-card-id="${card.id}">−</button>
            <span class="card-qty">&times;${card.quantity}</span>
            <button class="btn-sm" data-action="inc" data-card-id="${card.id}">+</button>
          </div>
          <button class="btn-sm btn-delete" data-action="delete" data-card-id="${card.id}" aria-label="Delete card" title="Delete card">🗑</button>
        `
        : `<span class="card-qty">&times;${card.quantity}</span>`
    }
          <span class="card-condition">${card.condition}</span>
        </div>
      </div>
    `;
  }

  // ─── Edit Mode ──────────────────────────────────────────────────

  function toggleEditMode() {
    editMode = !editMode;
    const btn = el.querySelector<HTMLButtonElement>("#btn-edit-mode")!;
    btn.textContent = editMode ? "Done" : "Edit";
    btn.classList.toggle("active", editMode);

    if (!editMode) {
      deselectAll();
    }

    renderCardList(currentFolderId!);
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

    const folders = await collectionStore.getAllFolders();
    const otherFolders = folders.filter((f) => f.id !== currentFolderId);

    if (otherFolders.length === 0) {
      alert("No other folders to move to. Create a new folder first.");
      return;
    }

    const select = el.querySelector<HTMLSelectElement>(
      "#move-folder-select",
    )!;
    select.innerHTML = otherFolders
      .map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`)
      .join("");

    (el.querySelector("#move-dialog") as HTMLDialogElement).showModal();
  }

  async function confirmMove() {
    const select = el.querySelector<HTMLSelectElement>(
      "#move-folder-select",
    )!;
    const destFolderId = select.value;
    const dialog = el.querySelector("#move-dialog") as HTMLDialogElement;
    dialog.close();
    if (!destFolderId) return;

    const cardIds = [...selectedCardIds];
    const sourceCards = await collectionStore.getCardsByFolder(currentFolderId!);
    const destCards = await collectionStore.getCardsByFolder(destFolderId);
    const moving = sourceCards.filter((c) => cardIds.includes(c.id));

    // Full move: each selected entry's whole quantity relocates (matches
    // moveCards, which moves without a partial-quantity argument).
    const sourceAfter = sourceCards.filter((c) => !cardIds.includes(c.id));
    const destAfter = destCards.map((c) => ({ ...c }));
    for (const card of moving) {
      const existing = destAfter.find((c) => c.scryfallId === card.scryfallId);
      if (existing) {
        existing.quantity += card.quantity;
      } else {
        destAfter.push({ ...card, folderId: destFolderId });
      }
    }

    openMergeView({
      container: el,
      stagingCards: moving,
      panels: [
        { title: "Source", before: sourceCards, after: sourceAfter },
        { title: "Destination", before: destCards, after: destAfter },
      ],
      confirmLabel: "Move to Collection",
      onConfirm: async () => {
        await collectionStore.moveCards(cardIds, destFolderId);
        selectedCardIds.clear();
        editMode = false;
        el.querySelector<HTMLButtonElement>("#btn-edit-mode")!.textContent =
          "Edit";
        await renderCardList(currentFolderId!);
        updateSelectionBar();
      },
    });
  }

  // ─── Navigation ─────────────────────────────────────────────────

  function handleBack() {
    currentFolderId = null;
    editMode = false;
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
    currentFolderId = null;
    editMode = false;
    selectedCardIds.clear();
  }

  return { el, init, destroy };
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
