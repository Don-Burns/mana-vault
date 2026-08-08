// Baked in at build time by vite.config.ts's `define`.
declare const __COMMIT_HASH__: string;
declare const __COMMIT_DATE__: string;

const REPO_URL = "https://github.com/Don-Burns/mana-vault";

export function renderFooter(): void {
  const footer = document.createElement("footer");
  footer.id = "app-footer";

  const hash = __COMMIT_HASH__;
  const shortHash = hash.slice(0, 7);
  const publishedAt = new Date(__COMMIT_DATE__).toLocaleString();

  footer.innerHTML = `
    <a href="${REPO_URL}/commit/${hash}" target="_blank" rel="noopener noreferrer">
      version ${shortHash}
    </a>
    <span>published ${publishedAt}</span>
  `;

  document.getElementById("app")!.appendChild(footer);
}
