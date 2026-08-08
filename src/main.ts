import { ScannerView } from "./ui/scanner-view.ts";
import { CollectionView } from "./ui/collection-view.ts";
import { showToast } from "./ui/toast.ts";
import { collectionStore, DB_PATH } from "./collection/store.ts";

type ViewName = "scanner" | "collection";

class App {
  private currentView: ViewName = "scanner";
  private views: Record<ViewName, { el: HTMLElement; init: () => void; destroy: () => void }>;
  private mainContent: HTMLElement;

  constructor() {
    this.mainContent = document.getElementById("main-content")!;
    this.views = {
      scanner: ScannerView(this.mainContent),
      collection: CollectionView(this.mainContent),
    };

    this.setupNav();
    this.showView("scanner");
  }

  private setupNav() {
    const navButtons = document.querySelectorAll<HTMLButtonElement>(".nav-btn");
    navButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view as ViewName;
        if (view && view !== this.currentView) {
          this.showView(view);
          navButtons.forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
        }
      });
    });
  }

  private showView(name: ViewName) {
    // Destroy current view
    if (this.views[this.currentView]) {
      this.views[this.currentView].destroy();
      this.views[this.currentView].el.classList.remove("active");
    }

    this.currentView = name;

    // Initialize and show new view
    const view = this.views[name];
    view.el.classList.add("active");
    view.init();
  }
}

// The Turso WASM DB is a threaded build that needs SharedArrayBuffer, which
// requires the page to be cross-origin isolated. GitHub Pages can't set the
// COOP/COEP headers for that itself, so src/sw.ts injects them on every
// same-origin response instead. Those headers only take effect on a
// navigation the service worker actually controls — not the very first page
// load before it's installed — so force one reload after the SW is ready.
// sessionStorage guards against a reload loop if isolation still fails.
async function ensureCrossOriginIsolated(): Promise<void> {
  if (self.crossOriginIsolated || !("serviceWorker" in navigator)) return;
  if (sessionStorage.getItem("coi-reload")) return;
  await navigator.serviceWorker.ready;
  sessionStorage.setItem("coi-reload", "1");
  location.reload();
}

// True if the collection database doesn't exist on disk yet (fresh install
// or cleared storage), checked before `open()` creates it.
async function isFirstRun(): Promise<boolean> {
  if (!navigator.storage?.getDirectory) return false;
  try {
    const root = await navigator.storage.getDirectory();
    await root.getFileHandle(DB_PATH);
    return false;
  } catch {
    return true;
  }
}

// Boot the app
async function boot() {
  await ensureCrossOriginIsolated();
  if (!self.crossOriginIsolated && sessionStorage.getItem("coi-reload")) {
    // Reload was already triggered on a previous pass (or isolation is
    // unreachable, e.g. no SW support); don't try to open the threaded wasm
    // DB in a non-isolated context, just bail out.
    return;
  }

  const firstRun = await isFirstRun();

  // Initialize the database
  await collectionStore.open();
  await collectionStore.ensureDefaultFolder();

  if (firstRun) {
    showToast("No existing collection found. Use Import to load a saved database.");
  }

  // Note: the service worker is registered automatically by vite-plugin-pwa
  // (injectRegister: "auto"), which uses the correct worker URL in both dev
  // and production.

  // Start the app
  new App();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

// Release the OPFS sync access handle on reload/navigation/close — otherwise
// it stays locked and the next load fails with "Access Handles cannot be
// created if there is another open Access Handle" (also hit on every Vite
// full-page reload in dev, since that's a real unload too).
addEventListener("pagehide", () => {
  collectionStore.close();
});
