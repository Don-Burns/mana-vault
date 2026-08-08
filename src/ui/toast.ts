/**
 * Minimal, dependency-free toast notification.
 */
export function showToast(message: string, durationMs = 5000): void {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}
