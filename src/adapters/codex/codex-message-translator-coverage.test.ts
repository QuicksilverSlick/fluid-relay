/**
 * Additional branch coverage tests for codex-message-translator.
 *
 * Targets the three uncovered lines:
 *   - Line 111: default branch in translateCodexEvent (unknown event type)
 *   - Line 225: null return in translateItemAdded (item type is not message/function_call)
 *   - Line 276: null return in translateItemDone   (item type is not function_call_output/function_call/message)
 */

import { describe, expect, it } from "vitest";
import type { CodexTurnEvent } from "./codex-message-translator.js";
import { translateCodexEvent } from "./codex-message-translator.js";

describe("codex-message-translator – uncovered branches", () => {
  // -------------------------------------------------------------------------
  // Line 111: default case in translateCodexEvent switch
  // -------------------------------------------------------------------------
  describe("translateCodexEvent – unknown / unrecognised event type (line 111)", () => {
    it("returns null for an event type that is not handled by the switch", () => {
      // Cast through unknown so TypeScript accepts an out-of-spec event type.
      const unknownEvent = {
        type: "response.something_new",
      } as unknown as CodexTurnEvent;

      const result = translateCodexEvent(unknownEvent);
      expect(result).toBeNull();
    });

    it("returns null for an empty-string event type", () => {
      const unknownEvent = {
        type: "",
      } as unknown as CodexTurnEvent;

      expect(translateCodexEvent(unknownEvent)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Line 225: null return in translateItemAdded
  // Reached when item.type is neither "message" nor "function_call".
  // "function_call_output" is the realistic out-of-spec value here.
  // -------------------------------------------------------------------------
  describe("translateCodexEvent – response.output_item.added with unhandled item type (line 225)", () => {
    it("returns null when the added item type is function_call_output", () => {
      const event: CodexTurnEvent = {
        type: "response.output_item.added",
        item: {
          type: "function_call_output",
          id: "fco-99",
          call_id: "call-99",
          output: "some output",
          status: "completed",
        },
        output_index: 0,
      };

      const result = translateCodexEvent(event);
      expect(result).toBeNull();
    });

    it("returns null when the added item has an unknown type (cast)", () => {
      const event = {
        type: "response.output_item.added",
        item: {
          type: "unknown_item_type",
          id: "x-1",
        },
        output_index: 0,
      } as unknown as CodexTurnEvent;

      expect(translateCodexEvent(event)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Line 276: null return in translateItemDone
  // Reached when item.type is not function_call_output, function_call, or message.
  // -------------------------------------------------------------------------
  describe("translateCodexEvent – response.output_item.done with unhandled item type (line 276)", () => {
    it("returns null when the done item has an unknown type (cast)", () => {
      const event = {
        type: "response.output_item.done",
        item: {
          type: "unknown_item_type",
          id: "x-2",
        },
        output_index: 0,
      } as unknown as CodexTurnEvent;

      const result = translateCodexEvent(event);
      expect(result).toBeNull();
    });

    it("returns null for a second distinct unknown done-item type", () => {
      const event = {
        type: "response.output_item.done",
        item: {
          type: "future_item_kind",
          id: "x-3",
        },
        output_index: 1,
      } as unknown as CodexTurnEvent;

      expect(translateCodexEvent(event)).toBeNull();
    });
  });
});
