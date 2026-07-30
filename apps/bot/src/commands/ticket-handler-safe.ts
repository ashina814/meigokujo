import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { Services } from "../services.js";
import { handleTicketButton as handleTicketButtonBase } from "./tickets.js";

const CLOSE_CONFIRM_PREFIX = "ticket:close-confirm:";
const CLOSE_FAILED_MESSAGE = "クローズ処理に失敗しました。もう一度お試しください。";

type UpdatePayload = Parameters<ButtonInteraction["update"]>[0];

function payloadContent(payload: UpdatePayload): string | undefined {
  return typeof payload.content === "string" ? payload.content : undefined;
}

function normalizeCloseRace(
  interaction: ButtonInteraction,
  services: Services,
  payload: UpdatePayload,
): UpdatePayload {
  if (!interaction.customId.startsWith(CLOSE_CONFIRM_PREFIX)) return payload;
  if (payloadContent(payload) !== CLOSE_FAILED_MESSAGE) return payload;
  if (services.tickets.get(interaction.channelId)?.status !== "closed") return payload;
  return {
    ...payload,
    content: "このチケットは既にクローズされています。",
    components: [],
  };
}

/**
 * チケット操作のDiscord表示を復旧可能にする薄いラッパー。
 *
 * - 担当登録後に interaction.update() が失敗した場合、元メッセージを直接編集する
 * - クローズ完了応答が失敗しても例外を飲み込み、呼び出し元のロック・アーカイブ処理を継続する
 * - 原子的クローズの競合負けを「失敗」ではなく「既にクローズ済み」と表示する
 */
export async function handleTicketButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const wrapped = new Proxy(interaction, {
    get(target, property) {
      if (property === "update") {
        return async (payload: UpdatePayload) => {
          const normalized = normalizeCloseRace(target, services, payload);
          try {
            return await target.update(normalized);
          } catch (error) {
            if (target.customId === "ticket:claim") {
              try {
                const edited = await target.message.edit(normalized as never);
                await target
                  .reply({
                    content: "対応者として登録し、表示を更新しました。",
                    flags: MessageFlags.Ephemeral,
                  })
                  .catch(() => undefined);
                return edited as never;
              } catch (editError) {
                console.warn("[ticket] 対応状態の直接メッセージ編集にも失敗", editError);
                throw error;
              }
            }

            const content = payloadContent(normalized);
            if (target.customId.startsWith(CLOSE_CONFIRM_PREFIX) && content?.startsWith("🔒 ")) {
              console.warn("[ticket] クローズ完了応答に失敗しましたが、スレッドのロック処理を継続します", error);
              return target.message as never;
            }
            throw error;
          }
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  await handleTicketButtonBase(wrapped as ButtonInteraction, services);
}
