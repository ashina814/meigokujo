import { describe, expect, it, vi } from "vitest";
import { INTERACTION_ERROR_MESSAGE, respondInteractionError } from "../src/interaction-errors.js";

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    isRepliable: () => true,
    replied: false,
    deferred: false,
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("Interaction共通エラー応答", () => {
  it("未返信ならreplyする", async () => {
    const interaction = makeInteraction();
    await respondInteractionError(interaction as any);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: INTERACTION_ERROR_MESSAGE }));
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("defer済みならeditReplyする", async () => {
    const interaction = makeInteraction({ deferred: true });
    await respondInteractionError(interaction as any);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: INTERACTION_ERROR_MESSAGE });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("返信済みならfollowUpし、失敗しても再throwしない", async () => {
    const interaction = makeInteraction({
      replied: true,
      followUp: vi.fn(async () => {
        throw new Error("token expired");
      }),
    });

    await expect(respondInteractionError(interaction as any)).resolves.toBeUndefined();
    expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: INTERACTION_ERROR_MESSAGE }));
  });
});
