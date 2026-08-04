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
