import type { ExtensionAPI, ExtensionCommandContext, TUI, Theme } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";

import { createPermissionSystemCommandHandler, PERMISSION_SYSTEM_COMMAND_DESCRIPTION } from "./common.js";
import type { PermissionSystemExtensionConfig } from "./extension-config.js";
import { ZellijModal, ZellijSettingsModal } from "./zellij-modal.js";

interface PermissionSystemConfigController {
  getConfig(): PermissionSystemExtensionConfig;
  setConfig(next: PermissionSystemExtensionConfig, ctx: ExtensionCommandContext): void;
  getConfigPath(): string;
}

interface SettingValueSyncTarget {
  updateValue(id: string, value: string): void;
}

const ON_OFF = ["on", "off"];

function toOnOff(value: boolean): string {
  return value ? "on" : "off";
}

function buildSettingItems(config: PermissionSystemExtensionConfig): SettingItem[] {
  return [
    {
      id: "debug",
      label: "Debug logging",
      description: "Write diagnostics and permission review entries to the extension debug file",
      currentValue: toOnOff(config.debug),
      values: ON_OFF,
    },
    {
      id: "yoloMode",
      label: "YOLO mode",
      description: "Auto-approve ask-state permission checks, including subagent approval forwarding",
      currentValue: toOnOff(config.yoloMode),
      values: ON_OFF,
    },
  ];
}

function applySetting(
  config: PermissionSystemExtensionConfig,
  id: string,
  value: string,
): PermissionSystemExtensionConfig {
  switch (id) {
    case "debug":
      return { ...config, debug: value === "on" };
    case "yoloMode":
      return { ...config, yoloMode: value === "on" };
    default:
      return config;
  }
}

function syncSettingValues(settingsList: SettingValueSyncTarget, config: PermissionSystemExtensionConfig): void {
  settingsList.updateValue("debug", toOnOff(config.debug));
  settingsList.updateValue("yoloMode", toOnOff(config.yoloMode));
}

export async function openPermissionSystemSettingsModal(ctx: ExtensionCommandContext, controller: PermissionSystemConfigController): Promise<void> {
  const overlayOptions = { anchor: "center" as const, width: 82, maxHeight: "85%" as const, margin: 1 };

  await ctx.ui.custom<void>(
    (tui: TUI, theme: Theme, _keybindings: unknown, done: (result?: void) => void) => {
      let current = controller.getConfig();
      let settingsModal: ZellijSettingsModal | null = null;

      settingsModal = new ZellijSettingsModal(
        {
          title: "Permission System Settings",
          description: "Local extension options for debug logging and auto-approval behavior",
          settings: buildSettingItems(current),
          onChange: (id: string, newValue: string) => {
            current = applySetting(current, id, newValue);
            controller.setConfig(current, ctx);
            current = controller.getConfig();
            if (settingsModal) {
              syncSettingValues(settingsModal, current);
            }
          },
          onClose: () => done(),
          helpText: `Config file: ${controller.getConfigPath()}`,
          enableSearch: true,
        },
        theme,
      );

      const modal = new ZellijModal(
        settingsModal,
        {
          borderStyle: "rounded",
          titleBar: {
            left: "Permission System Settings",
            right: "pi-permission-system",
          },
          helpUndertitle: {
            text: "Esc: close | ↑↓: navigate | Space: toggle",
            color: "dim",
          },
          overlay: overlayOptions,
        },
        theme,
      );

      return {
        render: (width: number): string[] => {
          return modal.renderModal(width).lines;
        },
        invalidate: (): void => {
          modal.invalidate();
        },
        handleInput: (data: string): void => {
          modal.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions },
  );
}

export function registerPermissionSystemCommand(pi: ExtensionAPI, controller: PermissionSystemConfigController): void {
  pi.registerCommand("permission-system", {
    description: PERMISSION_SYSTEM_COMMAND_DESCRIPTION,
    handler: createPermissionSystemCommandHandler((ctx) => openPermissionSystemSettingsModal(ctx, controller)),
  });
}
