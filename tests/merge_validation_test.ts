/// <reference lib="deno.ns" />
import { assertEquals } from "@std/assert";
import { validateMergeSelection } from "../src/collection/merge-validation.ts";

Deno.test("add mode: no destination fails", () => {
  assertEquals(
    validateMergeSelection("add", null, null),
    "Select a folder before continuing.",
  );
});

Deno.test("add mode: destination set passes", () => {
  assertEquals(validateMergeSelection("add", "f1", null), null);
});

Deno.test("remove mode: no destination fails", () => {
  assertEquals(
    validateMergeSelection("remove", null, null),
    "Select a folder before continuing.",
  );
});

Deno.test("remove mode: destination set passes", () => {
  assertEquals(validateMergeSelection("remove", "f1", null), null);
});

Deno.test("move mode: no destination fails", () => {
  assertEquals(
    validateMergeSelection("move", null, null),
    "Select a folder before continuing.",
  );
});

Deno.test("move mode: destination set, no secondary fails", () => {
  assertEquals(
    validateMergeSelection("move", "f1", null),
    "Select a destination folder to move to.",
  );
});

Deno.test("move mode: identical folders fails", () => {
  assertEquals(
    validateMergeSelection("move", "f1", "f1"),
    "Choose two different folders to move between.",
  );
});

Deno.test("move mode: distinct folders passes", () => {
  assertEquals(validateMergeSelection("move", "f1", "f2"), null);
});
