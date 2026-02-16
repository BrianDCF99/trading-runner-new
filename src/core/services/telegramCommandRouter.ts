/**
 * Telegram command/callback routing for runtime control-plane commands.
 */
import type { BotCallback, BotCommand, RuntimeSetupSnapshot } from "../domain/types.js";
import type { NotifierPort, RunnerPort, RuntimeStorePort } from "../ports/interfaces.js";

function formatTimestamp(value: string | null, timezone: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatHoursUntil(targetMs: number): string {
  const deltaMs = targetMs - Date.now();
  if (deltaMs <= 0) return "0:00";
  const totalMinutes = Math.floor(deltaMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function parseExecutionDecisionData(data: string): { decisionId: string; decision: "filled" | "not_filled" } | null {
  const match = data.match(/^exec:([0-9a-fA-F-]{36}):(filled|not_filled)$/);
  if (!match) return null;
  return {
    decisionId: match[1] ?? "",
    decision: (match[2] ?? "") as "filled" | "not_filled",
  };
}

function resolveWatchingKind(token?: string): "new" | "funding" | "long25" | null {
  if (!token) return null;
  const normalized = token.trim().toLowerCase();
  const newAliases = new Set(["new", "new-listing", "listing", "vfinal"]);
  const fundingAliases = new Set(["funding", "funding-v7", "rule-i"]);
  const long25Aliases = new Set(["long25", "long", "v_vol25_min1", "v-vol25-min1", "vol25"]);
  if (newAliases.has(normalized)) return "new";
  if (fundingAliases.has(normalized)) return "funding";
  if (long25Aliases.has(normalized)) return "long25";
  return null;
}

function resolveSetupActionLabel(setup: RuntimeSetupSnapshot): string {
  const payloadAction = setup.payload.action;
  if (typeof payloadAction === "string" && payloadAction.trim().length > 0) {
    return payloadAction.trim();
  }
  const payloadSide = setup.payload.side;
  if (typeof payloadSide === "string" && payloadSide.toUpperCase() === "LONG") {
    return "OPEN LONG";
  }
  return "OPEN SHORT";
}

function resolveNextAlertLabel(setup: RuntimeSetupSnapshot): string {
  if (setup.strategyId === "bybit:funding:rule-i:v7" || setup.strategyId === "bybit:funding-rule-i:v7") {
    const closeDueAtMs = setup.payload.closeDueAtMs;
    if (setup.phase === "READY" && typeof closeDueAtMs === "number") {
      return `8h close checkpoint in ${formatHoursUntil(closeDueAtMs)}`;
    }
    if (setup.phase === "READY") return "entry confirmation pending";
    if (setup.phase === "CLOSED") return "none (closed)";
    return "normalization watch active";
  }

  if (setup.strategyId.startsWith("bybit:new-listing:")) {
    const launchTimeMs = setup.payload.launchTimeMs;
    if (typeof launchTimeMs === "number" && setup.phase === "WATCHING") {
      return `4h/8h checkpoints pending`;
    }
    if (setup.phase.startsWith("READY_")) return "entry confirmation pending";
    if (setup.phase === "CLOSED") return "none (closed)";
    return "watching";
  }

  if (setup.strategyId === "bybit:long25:v1" || setup.strategyId === "bybit:long25-suite:v1") {
    if (setup.phase === "READY") return "volume watchdog active";
    if (setup.phase === "CLOSED") return "none (closed)";
    return "watching";
  }

  return "unknown";
}

function formatReadyPromptMessage(setup: RuntimeSetupSnapshot, reason: string): string {
  return [
    `✅ <b>${setup.phase} | READY</b>`,
    "",
    `<b>${setup.symbol}</b>`,
    `Action: <b>${resolveSetupActionLabel(setup)}</b>`,
    `Reason: ${reason}`,
    `Strategy: <b>${setup.strategyName}</b>`,
    "",
    "Confirm execution result:",
  ].join("\n");
}

export class TelegramCommandRouter {
  constructor(
    private readonly options: {
      runnerName: string;
      exchange: "bybit";
      timezone: string;
      notifier: NotifierPort;
      runner: RunnerPort;
      runtimeStore: RuntimeStorePort;
    }
  ) {}

  async handleCommand(command: BotCommand): Promise<void> {
    switch (command.command) {
      case "ping":
        await this.options.notifier.sendMessage("🏓 pong", { chatId: command.chatId });
        return;

      case "status": {
        const status = await this.options.runtimeStore.getStatus(this.options.exchange, this.options.runnerName);
        const text = [
          `📡 <b>Runner Status</b>`,
          `Runner: <b>${status.runnerName}</b>`,
          `Exchange: <b>${status.exchange.toUpperCase()}</b>`,
          `State: <b>${status.state}</b>`,
          `Last heartbeat (${this.options.timezone}): ${formatTimestamp(status.lastHeartbeat, this.options.timezone)}`,
          `Last run (${this.options.timezone}): ${formatTimestamp(status.lastRunAt, this.options.timezone)}`,
          `Last duration: ${status.lastRunDurationMs ?? "-"} ms`,
          `Setups tracked: <b>${status.setupCount}</b>`,
          `Setups ready: <b>${status.readySetupCount}</b>`,
          `Error: ${status.lastError ?? "none"}`,
        ].join("\n");
        await this.options.notifier.sendMessage(text, { chatId: command.chatId });
        return;
      }

      case "ready": {
        const ready = await this.options.runtimeStore.getReadySetups(this.options.exchange, 10);
        if (ready.length === 0) {
          await this.options.notifier.sendMessage("No READY setups at the moment.", { chatId: command.chatId });
          return;
        }

        const lines = ready.map(
          (setup, index) =>
            `${index + 1}. <b>${setup.symbol}</b> - ${setup.strategyName} - ${setup.phase} (${setup.score.toFixed(0)}%)`
        );
        await this.options.notifier.sendMessage(`✅ <b>Top READY setups</b>\n${lines.join("\n")}`, {
          chatId: command.chatId,
        });
        return;
      }

      case "scan": {
        await this.options.notifier.sendMessage("Manual scan requested. Running now...", { chatId: command.chatId });
        const result = await this.options.runner.runOnce("manual");
        if (!result.executed) {
          await this.options.notifier.sendMessage("Manual scan skipped because another cycle is still running.", {
            chatId: command.chatId,
          });
          return;
        }
        if (result.error) {
          await this.options.notifier.sendMessage(`Manual scan failed: ${result.error}`, {
            chatId: command.chatId,
          });
          return;
        }
        await this.options.notifier.sendMessage(
          `Manual scan complete. Signals: <b>${result.signalCount}</b>, ready: <b>${result.readyCount}</b>, duration: <b>${result.durationMs}ms</b>`,
          { chatId: command.chatId }
        );
        return;
      }

      case "new": {
        const text = await this.options.runner.getWatchingSnapshot("new");
        await this.options.notifier.sendMessage(text, { chatId: command.chatId });
        return;
      }

      case "funding": {
        const text = await this.options.runner.getWatchingSnapshot("funding");
        await this.options.notifier.sendMessage(text, { chatId: command.chatId });
        return;
      }

      case "long25": {
        const text = await this.options.runner.getWatchingSnapshot("long25");
        await this.options.notifier.sendMessage(text, { chatId: command.chatId });
        return;
      }

      case "watching": {
        const requested = command.args[0];
        if (!requested) {
          await this.options.notifier.sendMessage(
            ["Use dedicated commands for watching snapshots:", "/new", "/funding", "/long25", "", "Legacy alias: /watching <new|funding|long25>"].join(
              "\n"
            ),
            { chatId: command.chatId }
          );
          return;
        }

        const kind = resolveWatchingKind(requested);
        if (!kind) {
          await this.options.notifier.sendMessage(
            `Unknown watching scope "${requested}". Use /watching new, /watching funding, or /watching long25.`,
            { chatId: command.chatId }
          );
          return;
        }

        const text = await this.options.runner.getWatchingSnapshot(kind);
        await this.options.notifier.sendMessage(text, { chatId: command.chatId });
        return;
      }

      case "positions": {
        const positions = await this.options.runtimeStore.getPositionsForMember({
          exchange: this.options.exchange,
          chatId: command.chatId,
          userId: command.fromUserId,
          limit: 25,
        });
        if (positions.length === 0) {
          await this.options.notifier.sendMessage("No active positions found for your member id in this chat.", {
            chatId: command.chatId,
          });
          return;
        }

        const lines = positions.map(
          (setup, index) => `${index + 1}. <b>${setup.symbol}</b> | ${setup.phase} | ${resolveNextAlertLabel(setup)}`
        );
        await this.options.notifier.sendMessage(
          [
            `📌 <b>Your Positions</b>`,
            `Chat: <code>${command.chatId}</code>`,
            `Member: <code>${command.fromUserId}</code>`,
            `Count: <b>${positions.length}</b>`,
            "",
            ...lines,
          ].join("\n"),
          { chatId: command.chatId }
        );
        return;
      }

      case "refresh": {
        const pending = await this.options.runtimeStore.getPendingExecutionPrompts(this.options.exchange, 10);
        if (pending.length === 0) {
          await this.options.notifier.sendMessage(
            "No refreshable READY setups pending confirmation right now.",
            { chatId: command.chatId }
          );
          return;
        }

        await this.options.notifier.sendMessage(`Refreshing ${pending.length} pending setup confirmation prompt(s)...`, {
          chatId: command.chatId,
        });

        for (const item of pending) {
          await this.options.notifier.sendMessage(
            formatReadyPromptMessage(item.setup, "REFRESH_PENDING_CONFIRMATION"),
            {
              chatId: command.chatId,
              inlineKeyboard: [
                [
                  { text: "Filled", callbackData: `exec:${item.decisionId}:filled` },
                  { text: "Not Filled", callbackData: `exec:${item.decisionId}:not_filled` },
                ],
              ],
            }
          );
        }
        return;
      }

      default:
        await this.options.notifier.sendMessage(
          ["Available commands:", "/ping", "/status", "/ready", "/new", "/funding", "/long25", "/watching", "/positions", "/scan", "/refresh"].join(
            "\n"
          ),
          { chatId: command.chatId }
        );
    }
  }

  async handleCallback(callback: BotCallback): Promise<void> {
    const parsed = parseExecutionDecisionData(callback.data);
    if (!parsed) {
      await this.options.notifier.answerCallbackQuery(callback.callbackQueryId, "Unknown action");
      return;
    }

    const updated = await this.options.runtimeStore.updateExecutionDecision({
      decisionId: parsed.decisionId,
      decision: parsed.decision,
      telegramChatId: callback.chatId,
      telegramMessageId: callback.messageId,
      telegramUserId: callback.fromUserId,
    });

    if (!updated) {
      await this.options.notifier.answerCallbackQuery(callback.callbackQueryId, "Decision not found");
      return;
    }

    await this.options.notifier.answerCallbackQuery(
      callback.callbackQueryId,
      parsed.decision === "filled" ? "Marked as filled" : "Marked as not filled"
    );
  }
}
