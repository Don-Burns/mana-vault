/**
 * Scan Dedup Tracker
 *
 * Prevents the same physical card sitting in view from being re-added to
 * staging on every capture cycle. A duplicate is only allowed through once
 * the camera has seen no card at all for `gapMs` (the card was removed and
 * something — possibly the same card again — was re-shown).
 */
export class ScanDedupTracker {
  private emptySince: number | null = null;
  private hadGap = false;

  constructor(private readonly gapMs = 500) {}

  /** Call when a card is detected in the current frame. */
  onFound(): void {
    this.emptySince = null;
  }

  /** Call when no card is detected in the current frame. */
  onNotFound(now: number): void {
    if (this.emptySince === null) this.emptySince = now;
    if (now - this.emptySince >= this.gapMs) this.hadGap = true;
  }

  /**
   * True if `candidateScryfallId` should be treated as a duplicate of the
   * last staged card and skipped (not added again).
   */
  shouldSkip(
    candidateScryfallId: string,
    lastStagedScryfallId: string | undefined,
  ): boolean {
    return !this.hadGap && candidateScryfallId === lastStagedScryfallId;
  }

  /** Call after a card is actually added to staging. */
  recordCapture(): void {
    this.hadGap = false;
  }
}
