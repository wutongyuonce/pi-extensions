import { appendFile } from "node:fs/promises";

import {
  EXTENSION_ID,
  ensurePermissionSystemLogsDirectory,
  getPermissionSystemDebugPath,
  type PermissionSystemExtensionConfig,
} from "./extension-config.js";

export function safeJsonStringify(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, currentValue: unknown) => {
    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack,
      };
    }

    if (typeof currentValue === "bigint") {
      return currentValue.toString();
    }

    if (typeof currentValue === "object" && currentValue !== null) {
      const obj = currentValue as object;
      if (seen.has(obj)) {
        return "[Circular]";
      }
      seen.add(obj);
    }

    return currentValue;
  });
}

export interface PermissionSystemLogger {
  debug: (event: string, details?: Record<string, unknown>) => string | undefined;
  review: (event: string, details?: Record<string, unknown>) => string | undefined;
  flush: () => Promise<void>;
}

interface PermissionSystemLoggerOptions {
  getConfig: () => PermissionSystemExtensionConfig;
  debugPath?: string;
  ensureLogsDirectory?: () => string | undefined;
}

export function createPermissionSystemLogger(options: PermissionSystemLoggerOptions): PermissionSystemLogger {
  const getDebugPath = (): string => options.debugPath ?? getPermissionSystemDebugPath();
  const ensureLogsDirectory = options.ensureLogsDirectory ?? (() => ensurePermissionSystemLogsDirectory());
  let writeQueue: Promise<void> = Promise.resolve();

  const enqueueAppend = (path: string, line: string): void => {
    writeQueue = writeQueue.then(
      () => appendFile(path, `${line}\n`, "utf-8"),
      () => appendFile(path, `${line}\n`, "utf-8"),
    );
    void writeQueue.catch(() => {
      // Permission-system logging must never write to stdout/stderr or interrupt permission handling.
    });
  };

  const writeLine = (stream: "debug" | "review", event: string, details: Record<string, unknown>): string | undefined => {
    const path = getDebugPath();
    const directoryError = ensureLogsDirectory();
    if (directoryError) {
      return directoryError;
    }

    try {
      const line = safeJsonStringify({
        timestamp: new Date().toISOString(),
        extension: EXTENSION_ID,
        stream,
        event,
        ...details,
      });
      if (!line) {
        return `Failed to write permission-system ${stream} entry '${path}': event could not be serialized.`;
      }
      enqueueAppend(path, line);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to write permission-system ${stream} entry '${path}': ${message}`;
    }
  };

  const debug = (event: string, details: Record<string, unknown> = {}): string | undefined => {
    if (!options.getConfig().debug) {
      return undefined;
    }

    return writeLine("debug", event, details);
  };

  const review = (event: string, details: Record<string, unknown> = {}): string | undefined => {
    return writeLine("review", event, details);
  };

  const flush = (): Promise<void> => writeQueue.catch(() => undefined);

  return { debug, review, flush };
}
