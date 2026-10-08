import { describe, expect, it } from "vitest";
import {
  paperclipWakeCommentsArePromptOwned,
  selectPaperclipPromptSections as selectSections,
} from "./server-utils.js";

function context(reason = "issue_commented") {
  return {
    paperclipTaskMarkdown: "Legacy brief must not shadow assignment",
    paperclipTaskMarkdownCompact: "Legacy compact must not shadow assignment",
    paperclipTaskMarkdownAssignment: "Authoritative assignment: synthetic description",
    paperclipTaskMarkdownAssignmentCompact: "Compact assignment",
    paperclipTaskCommunicationGuidance: "Initial communication guidance",
    paperclipFreshSessionHandoffMarkdown: "Fresh-session handoff",
    paperclipWake: {
      reason,
      issue: { id: "issue-fixture", identifier: "FIX-1", title: "Synthetic task",
        description: "synthetic description", status: "in_progress" },
      comments: [{ id: "comment-fixture", body: "New synthetic event", authorType: "user" }],
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
    },
  };
}

describe("upstream Paperclip prompt section selection (AgentFleet)", () => {
  it("selects the authoritative brief and initial guidance on fresh attempts", () => {
    const value = context();
    const sections = selectSections(value);
    expect(sections.taskContextNote).toContain(value.paperclipTaskMarkdownAssignment);
    expect(sections.taskContextNote).toContain(value.paperclipTaskCommunicationGuidance);
    expect(sections.taskContextNote).toContain(value.paperclipFreshSessionHandoffMarkdown);
    expect(sections.taskContextNote).not.toContain("Legacy brief");
    expect(sections.wakePrompt).toContain("New synthetic event");
    expect(sections.wakePrompt).not.toContain("synthetic description");
  });

  it("selects the compact brief on ordinary resume and restores bootstrap on a fresh attempt", () => {
    const value = context();
    const resumed = selectSections(value, { resumedSession: true, includeExecutionContract: false });
    expect(resumed.taskContextNote).toBe(value.paperclipTaskMarkdownAssignmentCompact);
    expect(resumed.wakePrompt).not.toContain("Execution contract:");
    const fresh = selectSections(value, { resumedSession: false });
    expect(fresh.taskContextNote).toContain(value.paperclipTaskMarkdownAssignment);
    expect(fresh.taskContextNote).toContain(value.paperclipTaskCommunicationGuidance);
  });

  it.each(["issue_assigned", "issue_reopened_via_comment", "issue_recovery_action_restored", "issue_tree_restored"])(
    "retains the full assignment for %s even on resume", (reason) => {
      const value = context(reason);
      expect(selectSections(value, { resumedSession: true }).taskContextNote)
        .toBe(value.paperclipTaskMarkdownAssignment);
    },
  );

  it("retains the full brief for a recovery wake", () => {
    const value = { ...context("source_scoped_recovery_action"), paperclipWake: {
      ...context().paperclipWake,
      reason: "source_scoped_recovery_action",
      recovery: { cause: "process_lost" },
    } };
    expect(selectSections(value, { resumedSession: true }).taskContextNote)
      .toBe(value.paperclipTaskMarkdownAssignment);
  });

  it("allows a carrier to own initial communication guidance separately", () => {
    const value = context();
    expect(selectSections(value, { includeCommunicationGuidance: false }).taskContextNote)
      .toBe(value.paperclipTaskMarkdownAssignment);
  });

  it("keeps legacy task fields and the wake description when there is no assignment", () => {
    expect(selectSections({ paperclipTaskMarkdown: "Legacy assignment" }).taskContextNote)
      .toBe("Legacy assignment");
    const value = context();
    const sections = selectSections({ paperclipWake: value.paperclipWake });
    expect(sections.taskContextNote).toBe("");
    expect(sections.wakePrompt).toContain("synthetic description");
    expect(selectSections(null)).toEqual({ taskContextNote: "", wakePrompt: "" });
  });

  it.each([false, true])("keeps chat policy free from the generic execution contract (resume=%s)", (resumedSession) => {
    const sections = selectSections({ ...context(), conversationMode: true }, { resumedSession });
    expect(sections.wakePrompt).not.toContain("Execution contract:");
  });

  it.each([
    [undefined, false],
    [{ version: 1, events: { owner: "wake_prompt" } }, true],
    [{ version: 2, events: { owner: "wake_prompt" } }, false],
    [{ version: 1, events: { owner: "other" } }, false],
  ])("recognizes only the upstream v1 wake-event ownership marker %j", (paperclipTurnContext, expected) => {
    expect(paperclipWakeCommentsArePromptOwned({ paperclipTurnContext })).toBe(expected);
  });
});
