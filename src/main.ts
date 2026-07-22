import { ScannerView } from "./ui/scanner-view.ts";
import { CollectionView } from "./ui/collection-view.ts";
import { collectionStore } from "./collection/store.ts";

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

// Boot the app
async function boot() {
  // Initialize the database
  await collectionStore.open();
  await collectionStore.ensureDefaultFolder();

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
