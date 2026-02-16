/**
 * Console logger with structured JSON context.
 */
import type { LoggerPort } from "../../core/ports/interfaces.js";

function stamp(): string {
  return new Date().toISOString();
}

function print(level: string, message: string, context?: Record<string, unknown>): void {
  if (context && Object.keys(context).length > 0) {
    process.stdout.write(`[${stamp()}] [${level}] ${message} ${JSON.stringify(context)}\n`);
    return;
  }
  process.stdout.write(`[${stamp()}] [${level}] ${message}\n`);
}

export class ConsoleLogger implements LoggerPort {
  info(message: string, context?: Record<string, unknown>): void {
    print("INFO", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    print("WARN", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    print("ERROR", message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    print("DEBUG", message, context);
  }
}
