# Usage Workflow

## Collections

A user is able to create collections of cards.
A collection is a group of cards that may be used to represent a box, binder or something else in the player's collection.
Users can add cards to collections, check the contents of collections, and view collections in a structured manner.

### Terminology

Staging list - A temporary list of cards that a user is working with. Cards can be added to a staging list from the scanner or manual entry.
Check-in card(s) - Adding cards to a collection from a staging list.
Check-out card(s) - Removing cards from a collection using the scanner or manual entry.

### Scanner Mode

The scanner has a mode dropdown with three options: **Add**, **Remove**, **Move**.

- **Add** - the default mode. Scanned cards are staged, then checked in to the folder selected in "Add to".
- **Remove** - scanned cards are staged, then checked out of the folder selected in "Remove from". Each staged card is matched against the folder's contents (exact printing first, falling back to any printing of the same illustration); cards with no match are skipped and reported in the confirmation summary.
- **Move** - scanned cards are staged, then moved from the "Move from" folder to a second "To" folder. Uses the same matching/skip behavior as Remove. This is a direct folder reassignment for the matched card entry, not a check-out+check-in of new entries.

In all modes, the staging review screen lets the user adjust the quantity of each staged card (+/-) or remove it entirely before confirming.

### Merge Viewer

Confirming a staging review (Add/Remove/Move) or a collection-view "Move
selected" opens the **Merge Viewer** — a diff-style preview shown before
anything is written to a collection, so the user can see exactly what will
change first. It shows:

- A plain **staging** panel: the cards about to be applied (no diff
  coloring — it's not a collection yet, just what you're about to apply).
- One diffed panel per **real collection** touched by the operation: Add →
  destination folder only; Remove → source folder only; Move (scanner or
  collection-view) → both source and destination folders. Each panel shows
  the folder's current contents with the pending change applied: full
  additions and removals are highlighted as whole rows (green/red); quantity
  changes highlight just the new number (green for increases, red for
  decreases); unchanged cards render plain, for context.
- A single ordering control (name, set + collector number, quantity, mana
  value, color, or rarity) that applies to every panel at once. Matching
  cards are aligned to the same row position across the staging panel and
  every target panel (not just the same sort order), and scrolling any panel
  scrolls the others in sync.
- Each target panel shows at most 2 unchanged cards of context on either
  side of a change; longer unchanged runs collapse into a single "..." row
  to keep panels compact.
- Any scanned cards that couldn't be matched to a folder entry (Remove/Move)
  are called out with a skipped-count note.

Confirm/Cancel in the merge viewer replaces the previous direct-commit
behavior — nothing is written to a collection until the user confirms here.

### Checking-In Cards to Collections

When a user wants to save the cards in their staging list to a collection, they can check-in the cards to a collection.
The user can select which collection to check-in the cards to, and the cards will be added to that collection.

### Checking-Out Cards from Collections

When a user wants to remove cards from a collection, they can check-out the cards from that collection.
This can be done from a staging list or manually one by one.
The user can select which collection to check-out the cards from, and the cards will be removed from that collection.

### Checking Cards from One Collection to Another

When a user wants to move cards from one collection to another, they can select the "Move" scanner mode:
scanned cards are staged, then directly reassigned from the source collection to the destination collection.
