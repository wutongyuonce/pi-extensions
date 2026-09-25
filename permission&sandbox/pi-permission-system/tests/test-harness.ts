export function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

export async function runAsyncTest(name: string, testFn: () => Promise<void>): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

export interface MockContextOptions {
  sessionId?: string;
  hasUI?: boolean;
  selectResponse?: string;
  inputResponse?: string | undefined;
  activeAgentName?: string | null;
  notifications?: Array<{ message: string; level: string }>;
  statusUpdates?: Array<{ key: string; value: string | undefined }>;
}

export function createMockContext(
  cwd: string,
  prompts: string[],
  options: MockContextOptions = {},
): Record<string, unknown> {
  return {
    cwd,
    hasUI: options.hasUI === true,
    sessionManager: {
      getEntries: (): unknown[] => options.activeAgentName === undefined || options.activeAgentName === null
        ? []
        : [{ type: "custom", customType: "active_agent", data: { name: options.activeAgentName } }],
      getSessionId: (): string => options.sessionId ?? "test-session",
      getSessionDir: (): string => cwd,
    },
    ui: {
      notify: (message: string, level: string): void => {
        options.notifications?.push({ message, level });
      },
      setStatus: (key: string, value: string | undefined): void => {
        options.statusUpdates?.push({ key, value });
      },
      select: async (title: string): Promise<string | undefined> => {
        prompts.push(title);
        return options.selectResponse ?? "Allow Once";
      },
      input: async (): Promise<string | undefined> => options.inputResponse,
    },
  };
}
