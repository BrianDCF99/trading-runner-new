/**
 * Telegram notifier with command/callback polling and interactive message support.
 */
import type { InlineKeyboardButton, NotifierPort } from "../../core/ports/interfaces.js";

interface TelegramNotifierOptions {
  enabled: boolean;
  botToken: string | null;
  chatId: string | null;
  parseMode: "HTML" | "Markdown" | "MarkdownV2";
  sendDelayMs: number;
}

export interface TelegramCommand {
  chatId: string;
  fromUserId: number;
  text: string;
  command: string;
  args: string[];
  updateId: number;
}

export interface TelegramCallback {
  callbackQueryId: string;
  chatId: string;
  messageId: number;
  data: string;
  fromUserId: number;
  updateId: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat?: { id?: number | string };
    from?: { id?: number };
    text?: string;
  };
  callback_query?: {
    id?: string;
    from?: { id?: number };
    data?: string;
    message?: {
      message_id?: number;
      chat?: { id?: number | string };
    };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export class TelegramNotifier implements NotifierPort {
  private polling = false;
  private updateOffset = 0;

  constructor(private readonly options: TelegramNotifierOptions) {}

  get enabled(): boolean {
    return Boolean(this.options.enabled && this.options.botToken);
  }

  async notify(lines: string[]): Promise<number> {
    if (!this.enabled || !this.options.chatId) return 0;

    let sent = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const messageId = await this.sendMessage(line);
      if (messageId !== null) sent += 1;
      if (this.options.sendDelayMs > 0) {
        await sleep(this.options.sendDelayMs);
      }
    }
    return sent;
  }

  async sendMessage(
    text: string,
    options?: {
      chatId?: string;
      inlineKeyboard?: InlineKeyboardButton[][];
    }
  ): Promise<number | null> {
    if (!this.enabled) return null;

    const targetChat = options?.chatId ?? this.options.chatId;
    if (!targetChat) return null;

    const payload: Record<string, unknown> = {
      chat_id: targetChat,
      text,
      parse_mode: this.options.parseMode,
      disable_web_page_preview: true,
    };

    if (options?.inlineKeyboard && options.inlineKeyboard.length > 0) {
      payload.reply_markup = {
        inline_keyboard: options.inlineKeyboard.map((row) =>
          row.map((button) => ({
            text: button.text,
            callback_data: button.callbackData,
          }))
        ),
      };
    }

    const result = await this.callTelegram<{ message_id?: number }>("/sendMessage", payload, true);
    return result?.message_id ?? null;
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.enabled) return;
    await this.callTelegram("/answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  startPolling(
    onCommand: (command: TelegramCommand) => Promise<void> | void,
    onCallback?: (callback: TelegramCallback) => Promise<void> | void
  ): () => void {
    if (!this.enabled) return () => {};

    this.polling = true;
    const loop = async (): Promise<void> => {
      if (!this.polling) return;
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);

          const callbackData = update.callback_query?.data?.trim();
          const callbackId = update.callback_query?.id ?? "";
          const callbackChatId = String(update.callback_query?.message?.chat?.id ?? "");
          const callbackMessageId = Number(update.callback_query?.message?.message_id ?? 0);
          if (onCallback && callbackData && callbackId && callbackChatId && callbackMessageId > 0) {
            await onCallback({
              callbackQueryId: callbackId,
              chatId: callbackChatId,
              messageId: callbackMessageId,
              data: callbackData,
              fromUserId: Number(update.callback_query?.from?.id ?? 0),
              updateId: update.update_id,
            });
          }

          const rawText = update.message?.text?.trim();
          if (!rawText || !rawText.startsWith("/")) continue;
          const [rawCommand, ...args] = rawText.split(/\s+/);
          const commandToken = rawCommand.replace(/^\//, "").toLowerCase();
          const command = commandToken.split("@")[0] ?? "";
          if (!command) continue;
          const chatId = String(update.message?.chat?.id ?? "");
          if (!chatId) continue;

          await onCommand({
            chatId,
            fromUserId: Number(update.message?.from?.id ?? 0),
            text: rawText,
            command,
            args,
            updateId: update.update_id,
          });
        }
      } catch {
        // Keep polling on transient Telegram/API/network errors.
      } finally {
        if (this.polling) setTimeout(loop, 1_500);
      }
    };

    void loop();
    return () => {
      this.polling = false;
    };
  }

  private apiUrl(path: string): string {
    return `https://api.telegram.org/bot${this.options.botToken}${path}`;
  }

  private async callTelegram<T>(
    path: string,
    payload: Record<string, unknown>,
    retryRateLimit = false
  ): Promise<T | null> {
    const attempts = retryRateLimit ? 4 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await fetch(this.apiUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const rawBody = await response.text();
      let body:
        | {
            ok?: boolean;
            result?: T;
            description?: string;
            parameters?: { retry_after?: number };
          }
        | null = null;
      try {
        body = JSON.parse(rawBody) as {
          ok?: boolean;
          result?: T;
          description?: string;
          parameters?: { retry_after?: number };
        };
      } catch {
        body = null;
      }

      if (response.ok && body?.ok) {
        return body.result ?? null;
      }

      if (retryRateLimit && response.status === 429 && attempt < attempts) {
        const retryAfterSec = Number(body?.parameters?.retry_after ?? 3);
        const waitMs = Math.max(1_000, (Number.isFinite(retryAfterSec) ? retryAfterSec : 3) * 1_000 + 250);
        await sleep(waitMs);
        continue;
      }

      return null;
    }

    return null;
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    if (!this.options.botToken) return [];

    const params = new URLSearchParams({
      timeout: "20",
      offset: String(this.updateOffset),
      allowed_updates: JSON.stringify(["message", "callback_query"]),
    });

    const url = `${this.apiUrl("/getUpdates")}?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) return [];

    const body = (await response.json()) as {
      ok?: boolean;
      result?: TelegramUpdate[];
    };

    if (!body.ok || !Array.isArray(body.result)) return [];
    return body.result;
  }
}
