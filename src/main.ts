import { ScannerView } from "./ui/scanner-view.ts";
import { CollectionView } from "./ui/collection-view.ts";
import { showToast } from "./ui/toast.ts";
import { renderFooter } from "./ui/footer.ts";
import { collectionStore } from "./collection/store.ts";

type ViewName = "scanner" | "collection";

class App {
  private currentView: ViewName = "scanner";
  private views: Record<
    ViewName,
    { el: HTMLElement; init: () => void; destroy: () => void }
  >;
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

// True if the collection database has no folders yet (fresh install or
// cleared storage), checked before `ensureDefaultFolder()` creates one.
// Replaces a previous raw-OPFS file-existence check: the store's
// `opfs-sahpool` VFS (see docs/turso_wasm_hang_and_alternatives.md) manages
// its own private file mapping, so there's no plain OPFS file to peek at
// directly anymore, and this check is simpler anyway.
async function isFirstRun(): Promise<boolean> {
  return (await collectionStore.getAllFolders()).length === 0;
}

// Exposed so Playwright tests can seed/measure the store directly — bulk
// staging 500+ cards through the manual search-and-pick UI one at a time
// isn't a real user flow and would be far too slow/flaky to drive in e2e.
// No auth/secrets in this app (fully local/offline), so no security concern.
// TODO: Implement the plan in `./docs/plans/build-build-ui.md
(window as unknown as { __collectionStore: typeof collectionStore })
  .__collectionStore = collectionStore;

// Boot the app
async function boot() {
  // Initialize the database
  await collectionStore.open().catch((err) => {
    console.error("Failed to open collection database:", err);
    showToast("Error opening collection database. See console for details.");
    throw err;
  });

  const firstRun = await isFirstRun();
  await collectionStore.ensureDefaultFolder();

  if (firstRun) {
    showToast(
      "No existing collection found. Use Import to load a saved database.",
    );
  }

  // Note: the service worker is registered automatically by vite-plugin-pwa
  // (injectRegister: "auto"), which uses the correct worker URL in both dev
  // and production.

  // Start the app
  new App();
  renderFooter();
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
