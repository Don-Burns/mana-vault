/**
 * Staging List
 *
 * Manages the temporary list of scanned cards during a scan session.
 * Cards are held in staging until the user reviews and confirms them.
 */

import { type CardCondition } from "./store.ts";

export interface StagedCard {
  id: string; // Temporary ID for this staging entry
  illustrationId: string;
  scryfallId: string;
  oracleId: string;
  name: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  quantity: number;
  condition: CardCondition;
  confidence: number; // Match confidence (0-100)
  alternativePrintings?: AlternativePrinting[]; // Other printings of same illustration
  scannedAt: string;
}

export interface AlternativePrinting {
  scryfallId: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  lang: string;
}

export class StagingList {
  private items: StagedCard[] = [];
  private listeners: Set<() => void> = new Set();

  /**
   * Add a scanned card to the staging list.
   */
  add(card: Omit<StagedCard, "id" | "scannedAt">): StagedCard {
    const staged: StagedCard = {
      ...card,
      id: crypto.randomUUID(),
      scannedAt: new Date().toISOString(),
    };

    // Check if same printing already in staging — increment quantity
    const existing = this.items.find((i) => i.scryfallId === card.scryfallId);
    if (existing) {
      existing.quantity += card.quantity;
      this.notify();
      return existing;
    }

    this.items.push(staged);
    this.notify();
    return staged;
  }

  /**
   * Remove a card from the staging list.
   */
  remove(id: string): void {
    this.items = this.items.filter((i) => i.id !== id);
    this.notify();
  }

  /**
   * Update a staged card (e.g., change the selected printing).
   */
  update(id: string, updates: Partial<StagedCard>): void {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      Object.assign(item, updates);
      this.notify();
    }
  }

  /**
   * Change the selected printing for a staged card.
   */
  changePrinting(id: string, printing: AlternativePrinting): void {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.scryfallId = printing.scryfallId;
      item.setCode = printing.setCode;
      item.setName = printing.setName;
      item.collectorNumber = printing.collectorNumber;
      this.notify();
    }
  }

  /**
   * Update quantity for a staged card.
   */
  setQuantity(id: string, quantity: number): void {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.quantity = Math.max(1, quantity);
      this.notify();
    }
  }

  /**
   * Get all staged cards.
   */
  getAll(): readonly StagedCard[] {
    return this.items;
  }

  /**
   * Get the number of unique entries in staging.
   */
  get count(): number {
    return this.items.length;
  }

  /**
   * Get total quantity across all staged items.
   */
  get totalQuantity(): number {
    return this.items.reduce((sum, i) => sum + i.quantity, 0);
  }

  /**
   * Clear all staged cards.
   */
  clear(): void {
    this.items = [];
    this.notify();
  }

  /**
   * Subscribe to changes in the staging list.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
