/**
 * App entrypoint.
 * Responsibilities:
 * - bootstrap dependencies
 * - wire Telegram command/callback handlers
 * - start the runner loop
 */
import { bootstrapRunner } from "./bootstrap/bootstrapRunner.js";
import { TelegramCommandRouter } from "./core/services/telegramCommandRouter.js";

async function main(): Promise<void> {
  const app = await bootstrapRunner();

  const commandRouter = new TelegramCommandRouter({
    runnerName: app.runnerName,
    exchange: "bybit",
    timezone: app.config.runner.timezone,
    notifier: app.notifier,
    runner: app.runner,
    runtimeStore: app.runtimeStore,
  });

  const pollingEnabled = (process.env.TELEGRAM_ENABLE_POLLING ?? "true").toLowerCase() !== "false";
  if (pollingEnabled) {
    app.notifier.startPolling(
      async (command) => {
        await commandRouter.handleCommand(command);
      },
      async (callback) => {
        await commandRouter.handleCallback(callback);
      }
    );
  }

  await app.runner.start();
}

main().catch((error: unknown) => {
  process.stderr.write(`[fatal] ${String(error)}\n`);
  process.exitCode = 1;
});
