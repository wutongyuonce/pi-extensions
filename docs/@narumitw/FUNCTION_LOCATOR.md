# 全量符号定位索引

本页列出每个源码文件中可命名的函数、方法、类与箭头函数的定义行。它与各项目解析的“源码地图”配套使用：先在项目页确认模块职责，再按这里的精确行号进入函数；对象字面量中的 `execute`/`handler` 等宿主回调已在对应项目页的 tools/commands 行段中说明。

## pi-btw

### src/btw.ts

- [function `normalizeBtwSettings`](../pi-btw/src/btw.ts#L72) — 第 72 行
- [function `parseBtwModelReference`](../pi-btw/src/btw.ts#L89) — 第 89 行
- [function `resolveBtwModel`](../pi-btw/src/btw.ts#L98) — 第 98 行
- [function `hasRequestAuth`](../pi-btw/src/btw.ts#L148) — 第 148 行
- [function `readBtwSettings`](../pi-btw/src/btw.ts#L156) — 第 156 行
- [function `loadBtwThinkingLevel`](../pi-btw/src/btw.ts#L176) — 第 176 行
- [function `isBtwThinkingLevel`](../pi-btw/src/btw.ts#L192) — 第 192 行
- [function `isNodeError`](../pi-btw/src/btw.ts#L196) — 第 196 行
- [function `formatError`](../pi-btw/src/btw.ts#L200) — 第 200 行
- [function `btw`](../pi-btw/src/btw.ts#L204) — 第 204 行
- [function `loadSettingsForCommand`](../pi-btw/src/btw.ts#L235) — 第 235 行
- [function `resolveBtwModelWithLoader`](../pi-btw/src/btw.ts#L249) — 第 249 行
- [function `runBtwThread`](../pi-btw/src/btw.ts#L298) — 第 298 行
- [function `askThreadQuestion`](../pi-btw/src/btw.ts#L334) — 第 334 行
- [function `showThreadComposer`](../pi-btw/src/btw.ts#L367) — 第 367 行
- [function `sanitizeSingleLine`](../pi-btw/src/btw.ts#L378) — 第 378 行
- [function `buildConversationContext`](../pi-btw/src/btw.ts#L408) — 第 408 行
- [function `extractContentLines`](../pi-btw/src/btw.ts#L431) — 第 431 行
- [function `formatJson`](../pi-btw/src/btw.ts#L450) — 第 450 行
- [function `truncateFromStart`](../pi-btw/src/btw.ts#L459) — 第 459 行

### src/index.ts

- 无具名函数定义（仅 re-export、类型或常量）。

### src/side-thread.ts

- [function `hasCompleteSimple`](../pi-btw/src/side-thread.ts#L37) — 第 37 行
- [function `loadCompleteSimple`](../pi-btw/src/side-thread.ts#L45) — 第 45 行
- [function `createSideThread`](../pi-btw/src/side-thread.ts#L83) — 第 83 行
- [function `buildSideThreadMessages`](../pi-btw/src/side-thread.ts#L87) — 第 87 行
- [function `completeSideThreadTurn`](../pi-btw/src/side-thread.ts#L125) — 第 125 行
- [function `completeSideQuestion`](../pi-btw/src/side-thread.ts#L167) — 第 167 行
- [function `extractAssistantText`](../pi-btw/src/side-thread.ts#L186) — 第 186 行
- [function `buildUserPrompt`](../pi-btw/src/side-thread.ts#L194) — 第 194 行
- [function `buildFollowUpPrompt`](../pi-btw/src/side-thread.ts#L208) — 第 208 行
- [function `createUserMessage`](../pi-btw/src/side-thread.ts#L218) — 第 218 行
- [function `buildStreamOptions`](../pi-btw/src/side-thread.ts#L226) — 第 226 行
- [function `formatError`](../pi-btw/src/side-thread.ts#L241) — 第 241 行

### src/transcript-pager.ts

- [class `BtwTranscriptPager`](../pi-btw/src/transcript-pager.ts#L30) — 第 30 行
- [method `constructor`](../pi-btw/src/transcript-pager.ts#L41) — 第 41 行
- [method `render`](../pi-btw/src/transcript-pager.ts#L84) — 第 84 行
- [method `handleInput`](../pi-btw/src/transcript-pager.ts#L107) — 第 107 行
- [method `invalidate`](../pi-btw/src/transcript-pager.ts#L131) — 第 131 行
- [method `renderFooter`](../pi-btw/src/transcript-pager.ts#L136) — 第 136 行
- [method `scrollBy`](../pi-btw/src/transcript-pager.ts#L159) — 第 159 行
- [method `clampScrollOffset`](../pi-btw/src/transcript-pager.ts#L164) — 第 164 行
- [method `getMaxScrollOffset`](../pi-btw/src/transcript-pager.ts#L168) — 第 168 行
- [class `BtwAnsweringView`](../pi-btw/src/transcript-pager.ts#L173) — 第 173 行
- [method `constructor`](../pi-btw/src/transcript-pager.ts#L183) — 第 183 行
- [method `render`](../pi-btw/src/transcript-pager.ts#L203) — 第 203 行
- [method `handleInput`](../pi-btw/src/transcript-pager.ts#L223) — 第 223 行
- [method `invalidate`](../pi-btw/src/transcript-pager.ts#L244) — 第 244 行
- [method `finish`](../pi-btw/src/transcript-pager.ts#L249) — 第 249 行
- [method `dispose`](../pi-btw/src/transcript-pager.ts#L254) — 第 254 行
- [method `scrollBy`](../pi-btw/src/transcript-pager.ts#L259) — 第 259 行
- [method `clampScrollOffset`](../pi-btw/src/transcript-pager.ts#L264) — 第 264 行
- [method `getMaxScrollOffset`](../pi-btw/src/transcript-pager.ts#L268) — 第 268 行
- [function `formatSideTranscript`](../pi-btw/src/transcript-pager.ts#L273) — 第 273 行
- [function `buildTranscriptComponents`](../pi-btw/src/transcript-pager.ts#L284) — 第 284 行
- [function `renderTranscriptLines`](../pi-btw/src/transcript-pager.ts#L321) — 第 321 行
- [function `renderSideThreadHeader`](../pi-btw/src/transcript-pager.ts#L327) — 第 327 行
- [function `fitComposerLayout`](../pi-btw/src/transcript-pager.ts#L333) — 第 333 行
- [function `fitEditorLines`](../pi-btw/src/transcript-pager.ts#L347) — 第 347 行
- [function `fitWithFixedHeader`](../pi-btw/src/transcript-pager.ts#L356) — 第 356 行
- [function `stripShellIntegrationMarkers`](../pi-btw/src/transcript-pager.ts#L362) — 第 362 行
- [function `escapeTerminalControls`](../pi-btw/src/transcript-pager.ts#L366) — 第 366 行

## pi-chrome-devtools

### src/browser-manager.ts

- [function `formatError`](../pi-chrome-devtools/src/browser-manager.ts#L21) — 第 21 行
- [function `isNodeError`](../pi-chrome-devtools/src/browser-manager.ts#L25) — 第 25 行
- [function `normalizePathForComparison`](../pi-chrome-devtools/src/browser-manager.ts#L29) — 第 29 行
- [function `ensureDevToolsEndpoint`](../pi-chrome-devtools/src/browser-manager.ts#L33) — 第 33 行
- [function `ensureManagedBrowserLaunched`](../pi-chrome-devtools/src/browser-manager.ts#L55) — 第 55 行
- [function `launchManagedBrowser`](../pi-chrome-devtools/src/browser-manager.ts#L69) — 第 69 行
- [function `launchBrowserCandidate`](../pi-chrome-devtools/src/browser-manager.ts#L116) — 第 116 行
- [function `waitForBrowserSpawn`](../pi-chrome-devtools/src/browser-manager.ts#L159) — 第 159 行
- [callback `settle`](../pi-chrome-devtools/src/browser-manager.ts#L162) — 第 162 行
- [callback `onError`](../pi-chrome-devtools/src/browser-manager.ts#L169) — 第 169 行
- [callback `onSpawn`](../pi-chrome-devtools/src/browser-manager.ts#L170) — 第 170 行
- [function `readManagedBrowserPort`](../pi-chrome-devtools/src/browser-manager.ts#L176) — 第 176 行
- [function `waitForDevToolsEndpoint`](../pi-chrome-devtools/src/browser-manager.ts#L208) — 第 208 行
- [function `throwIfManagedBrowserExited`](../pi-chrome-devtools/src/browser-manager.ts#L233) — 第 233 行
- [function `throwIfBrowserLaunchCancelled`](../pi-chrome-devtools/src/browser-manager.ts#L238) — 第 238 行
- [function `shutdownManagedBrowser`](../pi-chrome-devtools/src/browser-manager.ts#L243) — 第 243 行
- [function `killManagedBrowserProcess`](../pi-chrome-devtools/src/browser-manager.ts#L265) — 第 265 行
- [function `waitForManagedBrowserExit`](../pi-chrome-devtools/src/browser-manager.ts#L273) — 第 273 行
- [callback `settle`](../pi-chrome-devtools/src/browser-manager.ts#L276) — 第 276 行
- [callback `onExitOrClose`](../pi-chrome-devtools/src/browser-manager.ts#L282) — 第 282 行
- [function `fetchDevToolsJson`](../pi-chrome-devtools/src/browser-manager.ts#L295) — 第 295 行
- [function `withEndpointRetry`](../pi-chrome-devtools/src/browser-manager.ts#L334) — 第 334 行
- [function `isRetryableEndpointError`](../pi-chrome-devtools/src/browser-manager.ts#L350) — 第 350 行
- [function `isLaunchableEndpointError`](../pi-chrome-devtools/src/browser-manager.ts#L354) — 第 354 行
- [function `shouldAutoLaunchAfterEndpointError`](../pi-chrome-devtools/src/browser-manager.ts#L358) — 第 358 行
- [function `canAutoLaunchBrowser`](../pi-chrome-devtools/src/browser-manager.ts#L367) — 第 367 行
- [function `endpointConnectionErrorMessage`](../pi-chrome-devtools/src/browser-manager.ts#L371) — 第 371 行
- [function `isTimeoutError`](../pi-chrome-devtools/src/browser-manager.ts#L380) — 第 380 行
- [function `devToolsEndpoint`](../pi-chrome-devtools/src/browser-manager.ts#L384) — 第 384 行
- [function `formatHostForUrl`](../pi-chrome-devtools/src/browser-manager.ts#L388) — 第 388 行
- [function `endpointSourceLabel`](../pi-chrome-devtools/src/browser-manager.ts#L393) — 第 393 行
- [function `launchModeLabel`](../pi-chrome-devtools/src/browser-manager.ts#L399) — 第 399 行
- [function `launchAttemptLines`](../pi-chrome-devtools/src/browser-manager.ts#L408) — 第 408 行
- [function `launchHint`](../pi-chrome-devtools/src/browser-manager.ts#L426) — 第 426 行
- [function `browserCandidateHint`](../pi-chrome-devtools/src/browser-manager.ts#L437) — 第 437 行
- [function `chromeLaunchCommand`](../pi-chrome-devtools/src/browser-manager.ts#L441) — 第 441 行
- [function `defaultManualBrowserExecutable`](../pi-chrome-devtools/src/browser-manager.ts#L448) — 第 448 行
- [function `quoteCommandPart`](../pi-chrome-devtools/src/browser-manager.ts#L456) — 第 456 行
- [function `endpointConfigHint`](../pi-chrome-devtools/src/browser-manager.ts#L460) — 第 460 行
- [function `isLocalDevToolsHost`](../pi-chrome-devtools/src/browser-manager.ts#L464) — 第 464 行
- [function `browserCandidateDefinitions`](../pi-chrome-devtools/src/browser-manager.ts#L469) — 第 469 行
- [function `explicitBrowserCandidateDefinition`](../pi-chrome-devtools/src/browser-manager.ts#L476) — 第 476 行
- [function `platformBrowserCandidateDefinitions`](../pi-chrome-devtools/src/browser-manager.ts#L481) — 第 481 行
- [function `windowsBrowserCandidateDefinitions`](../pi-chrome-devtools/src/browser-manager.ts#L523) — 第 523 行
- [function `browserLabelFromExecutable`](../pi-chrome-devtools/src/browser-manager.ts#L548) — 第 548 行
- [function `uniqueBrowserCandidates`](../pi-chrome-devtools/src/browser-manager.ts#L558) — 第 558 行
- [function `resolveBrowserCandidates`](../pi-chrome-devtools/src/browser-manager.ts#L568) — 第 568 行
- [function `uniqueBrowserCandidatesByResolvedPath`](../pi-chrome-devtools/src/browser-manager.ts#L578) — 第 578 行
- [function `resolveBrowserExecutable`](../pi-chrome-devtools/src/browser-manager.ts#L588) — 第 588 行
- [function `hasPathSeparator`](../pi-chrome-devtools/src/browser-manager.ts#L603) — 第 603 行
- [function `executableSearchPath`](../pi-chrome-devtools/src/browser-manager.ts#L607) — 第 607 行
- [function `executableSearchNames`](../pi-chrome-devtools/src/browser-manager.ts#L611) — 第 611 行
- [function `canAccessExecutable`](../pi-chrome-devtools/src/browser-manager.ts#L616) — 第 616 行
- [function `formatBrowserCandidate`](../pi-chrome-devtools/src/browser-manager.ts#L625) — 第 625 行
- [function `formatBrowserCandidateDefinition`](../pi-chrome-devtools/src/browser-manager.ts#L629) — 第 629 行
- [function `noBrowserCandidateMessage`](../pi-chrome-devtools/src/browser-manager.ts#L633) — 第 633 行
- [function `formatPageListItem`](../pi-chrome-devtools/src/browser-manager.ts#L641) — 第 641 行
- [function `sleep`](../pi-chrome-devtools/src/browser-manager.ts#L645) — 第 645 行
- [class `DevToolsEndpointError`](../pi-chrome-devtools/src/browser-manager.ts#L649) — 第 649 行
- [method `constructor`](../pi-chrome-devtools/src/browser-manager.ts#L653) — 第 653 行

### src/cdp-client.ts

- [function `listPages`](../pi-chrome-devtools/src/cdp-client.ts#L22) — 第 22 行
- [function `getPage`](../pi-chrome-devtools/src/cdp-client.ts#L31) — 第 31 行
- [function `resolvePage`](../pi-chrome-devtools/src/cdp-client.ts#L36) — 第 36 行
- [function `resolvePageForNavigation`](../pi-chrome-devtools/src/cdp-client.ts#L54) — 第 54 行
- [function `resolveDefaultPage`](../pi-chrome-devtools/src/cdp-client.ts#L64) — 第 64 行
- [function `requirePage`](../pi-chrome-devtools/src/cdp-client.ts#L74) — 第 74 行
- [function `createPage`](../pi-chrome-devtools/src/cdp-client.ts#L89) — 第 89 行
- [function `formatPage`](../pi-chrome-devtools/src/cdp-client.ts#L106) — 第 106 行
- [function `textResult`](../pi-chrome-devtools/src/cdp-client.ts#L115) — 第 115 行
- [function `withCdp`](../pi-chrome-devtools/src/cdp-client.ts#L122) — 第 122 行
- [class `CdpClient`](../pi-chrome-devtools/src/cdp-client.ts#L133) — 第 133 行
- [method `constructor`](../pi-chrome-devtools/src/cdp-client.ts#L145) — 第 145 行
- [method `connect`](../pi-chrome-devtools/src/cdp-client.ts#L173) — 第 173 行
- [method `send`](../pi-chrome-devtools/src/cdp-client.ts#L193) — 第 193 行
- [method `close`](../pi-chrome-devtools/src/cdp-client.ts#L208) — 第 208 行
- [method `rejectAll`](../pi-chrome-devtools/src/cdp-client.ts#L212) — 第 212 行

### src/chrome-devtools.ts

- [function `chromeDevtools`](../pi-chrome-devtools/src/chrome-devtools.ts#L44) — 第 44 行
- [function `handleChromeDevtoolsCommand`](../pi-chrome-devtools/src/chrome-devtools.ts#L81) — 第 81 行
- [function `showMenu`](../pi-chrome-devtools/src/chrome-devtools.ts#L112) — 第 112 行
- [function `parseCommand`](../pi-chrome-devtools/src/chrome-devtools.ts#L143) — 第 143 行
- [function `commandCompletions`](../pi-chrome-devtools/src/chrome-devtools.ts#L155) — 第 155 行

### src/index.ts

- 无具名函数定义（仅 re-export、类型或常量）。

### src/render.ts

- [function `renderToolCall`](../pi-chrome-devtools/src/render.ts#L19) — 第 19 行
- [function `renderTextResult`](../pi-chrome-devtools/src/render.ts#L23) — 第 23 行
- [function `renderScreenshotResult`](../pi-chrome-devtools/src/render.ts#L32) — 第 32 行
- [function `textContent`](../pi-chrome-devtools/src/render.ts#L41) — 第 41 行
- [function `screenshotTextContent`](../pi-chrome-devtools/src/render.ts#L47) — 第 47 行
- [function `formatCollapsibleOutput`](../pi-chrome-devtools/src/render.ts#L57) — 第 57 行
- [class `PiTextComponent`](../pi-chrome-devtools/src/render.ts#L67) — 第 67 行
- [method `constructor`](../pi-chrome-devtools/src/render.ts#L72) — 第 72 行
- [method `setText`](../pi-chrome-devtools/src/render.ts#L78) — 第 78 行
- [method `invalidate`](../pi-chrome-devtools/src/render.ts#L82) — 第 82 行
- [method `render`](../pi-chrome-devtools/src/render.ts#L86) — 第 86 行
- [function `truncateLine`](../pi-chrome-devtools/src/render.ts#L100) — 第 100 行
- [function `withStatus`](../pi-chrome-devtools/src/render.ts#L104) — 第 104 行

### src/runtime.ts

- [function `parseConfiguredPort`](../pi-chrome-devtools/src/runtime.ts#L63) — 第 63 行

### src/screenshot.ts

- [function `unique`](../pi-chrome-devtools/src/screenshot.ts#L8) — 第 8 行
- [function `isNodeError`](../pi-chrome-devtools/src/screenshot.ts#L12) — 第 12 行
- [function `saveScreenshot`](../pi-chrome-devtools/src/screenshot.ts#L27) — 第 27 行
- [function `resolveScreenshotPath`](../pi-chrome-devtools/src/screenshot.ts#L50) — 第 50 行
- [function `stripLeadingAtPath`](../pi-chrome-devtools/src/screenshot.ts#L85) — 第 85 行
- [function `hasParentPathSegment`](../pi-chrome-devtools/src/screenshot.ts#L89) — 第 89 行
- [function `ensureSafeScreenshotParent`](../pi-chrome-devtools/src/screenshot.ts#L93) — 第 93 行
- [function `selectAllowedRoot`](../pi-chrome-devtools/src/screenshot.ts#L114) — 第 114 行
- [function `ensureSafeDirectorySegment`](../pi-chrome-devtools/src/screenshot.ts#L124) — 第 124 行
- [function `assertSafeScreenshotTargetPath`](../pi-chrome-devtools/src/screenshot.ts#L142) — 第 142 行
- [function `assertPathWithinRealRoot`](../pi-chrome-devtools/src/screenshot.ts#L167) — 第 167 行
- [function `writeScreenshotFileSafely`](../pi-chrome-devtools/src/screenshot.ts#L176) — 第 176 行
- [function `replaceScreenshotFile`](../pi-chrome-devtools/src/screenshot.ts#L195) — 第 195 行
- [function `shouldRetryRenameAfterRemovingDestination`](../pi-chrome-devtools/src/screenshot.ts#L215) — 第 215 行
- [function `realpathOrResolvedPath`](../pi-chrome-devtools/src/screenshot.ts#L223) — 第 223 行
- [function `isPathInsideRoot`](../pi-chrome-devtools/src/screenshot.ts#L227) — 第 227 行
- [function `normalizePathForComparison`](../pi-chrome-devtools/src/screenshot.ts#L235) — 第 235 行
- [function `throwIfAborted`](../pi-chrome-devtools/src/screenshot.ts#L239) — 第 239 行
- [function `formatScreenshotText`](../pi-chrome-devtools/src/screenshot.ts#L244) — 第 244 行

### src/settings.ts

- [function `loadSettings`](../pi-chrome-devtools/src/settings.ts#L28) — 第 28 行
- [function `readSettingsFile`](../pi-chrome-devtools/src/settings.ts#L55) — 第 55 行
- [function `withLegacyIgnoredNotice`](../pi-chrome-devtools/src/settings.ts#L77) — 第 77 行
- [function `installSettingsFileExclusively`](../pi-chrome-devtools/src/settings.ts#L85) — 第 85 行
- [function `migrateLegacySettings`](../pi-chrome-devtools/src/settings.ts#L96) — 第 96 行
- [function `fileExists`](../pi-chrome-devtools/src/settings.ts#L128) — 第 128 行
- [function `normalizeChromeDevtoolsSettings`](../pi-chrome-devtools/src/settings.ts#L137) — 第 137 行
- [function `isChromeDevtoolsToolName`](../pi-chrome-devtools/src/settings.ts#L152) — 第 152 行
- [function `orderedUniqueChromeDevtoolsTools`](../pi-chrome-devtools/src/settings.ts#L156) — 第 156 行
- [function `saveSettings`](../pi-chrome-devtools/src/settings.ts#L161) — 第 161 行
- [function `settingsFilePath`](../pi-chrome-devtools/src/settings.ts#L174) — 第 174 行
- [function `legacySettingsFilePath`](../pi-chrome-devtools/src/settings.ts#L178) — 第 178 行
- [function `agentDir`](../pi-chrome-devtools/src/settings.ts#L182) — 第 182 行
- [function `isNodeError`](../pi-chrome-devtools/src/settings.ts#L186) — 第 186 行
- [function `formatError`](../pi-chrome-devtools/src/settings.ts#L190) — 第 190 行
- [function `unique`](../pi-chrome-devtools/src/settings.ts#L194) — 第 194 行

### src/tool-names.ts

- 无具名函数定义（仅 re-export、类型或常量）。

### src/tool-selector.ts

- [function `unique`](../pi-chrome-devtools/src/tool-selector.ts#L27) — 第 27 行
- [function `recordSettingsNotice`](../pi-chrome-devtools/src/tool-selector.ts#L31) — 第 31 行
- [function `formatError`](../pi-chrome-devtools/src/tool-selector.ts#L35) — 第 35 行
- [function `showToolSelector`](../pi-chrome-devtools/src/tool-selector.ts#L45) — 第 45 行
- [callback `commitSelectedTools`](../pi-chrome-devtools/src/tool-selector.ts#L58) — 第 58 行
- [callback `moveSelection`](../pi-chrome-devtools/src/tool-selector.ts#L68) — 第 68 行
- [callback `activateSelectedRow`](../pi-chrome-devtools/src/tool-selector.ts#L71) — 第 71 行
- [method `invalidate`](../pi-chrome-devtools/src/tool-selector.ts#L97) — 第 97 行
- [method `render`](../pi-chrome-devtools/src/tool-selector.ts#L98) — 第 98 行
- [method `handleInput`](../pi-chrome-devtools/src/tool-selector.ts#L113) — 第 113 行
- [function `showDialogToolSelector`](../pi-chrome-devtools/src/tool-selector.ts#L156) — 第 156 行
- [function `updateChromeDevtoolsTools`](../pi-chrome-devtools/src/tool-selector.ts#L183) — 第 183 行
- [function `setSelectedChromeDevtoolsTools`](../pi-chrome-devtools/src/tool-selector.ts#L195) — 第 195 行
- [function `applyChromeDevtoolsTools`](../pi-chrome-devtools/src/tool-selector.ts#L204) — 第 204 行
- [function `getToolStatusSummary`](../pi-chrome-devtools/src/tool-selector.ts#L214) — 第 214 行
- [function `buildToolStatusMessage`](../pi-chrome-devtools/src/tool-selector.ts#L233) — 第 233 行
- [function `buildQuickstartMessage`](../pi-chrome-devtools/src/tool-selector.ts#L249) — 第 249 行
- [function `buildCommandGuide`](../pi-chrome-devtools/src/tool-selector.ts#L261) — 第 261 行
- [function `toolSelectorTitle`](../pi-chrome-devtools/src/tool-selector.ts#L275) — 第 275 行
- [function `chromeDevtoolsToolSelectorRows`](../pi-chrome-devtools/src/tool-selector.ts#L279) — 第 279 行
- [function `formatToolSelectorRow`](../pi-chrome-devtools/src/tool-selector.ts#L288) — 第 288 行
- [function `getActiveChromeDevtoolsTools`](../pi-chrome-devtools/src/tool-selector.ts#L296) — 第 296 行
- [function `allChromeDevtoolsTools`](../pi-chrome-devtools/src/tool-selector.ts#L301) — 第 301 行
- [function `orderedChromeDevtoolsTools`](../pi-chrome-devtools/src/tool-selector.ts#L305) — 第 305 行
- [function `formatRuntimeStatus`](../pi-chrome-devtools/src/tool-selector.ts#L309) — 第 309 行
- [function `persistedSettingLabel`](../pi-chrome-devtools/src/tool-selector.ts#L313) — 第 313 行
- [function `formatPersistedSelection`](../pi-chrome-devtools/src/tool-selector.ts#L323) — 第 323 行
- [function `persistSettings`](../pi-chrome-devtools/src/tool-selector.ts#L331) — 第 331 行

### src/tools.ts

- [method `execute`](../pi-chrome-devtools/src/tools.ts#L25) — 第 25 行
- [method `execute`](../pi-chrome-devtools/src/tools.ts#L43) — 第 43 行
- [method `execute`](../pi-chrome-devtools/src/tools.ts#L68) — 第 68 行
- [method `execute`](../pi-chrome-devtools/src/tools.ts#L103) — 第 103 行
- [method `execute`](../pi-chrome-devtools/src/tools.ts#L141) — 第 141 行

## pi-firecrawl

### src/client.ts

- [function `configuredApiUrl`](../pi-firecrawl/src/client.ts#L8) — 第 8 行
- [function `resetConfiguredApiUrl`](../pi-firecrawl/src/client.ts#L12) — 第 12 行
- [function `firecrawlRequest`](../pi-firecrawl/src/client.ts#L16) — 第 16 行
- [function `getApiKey`](../pi-firecrawl/src/client.ts#L40) — 第 40 行
- [function `hasApiKey`](../pi-firecrawl/src/client.ts#L50) — 第 50 行
- [function `normalizeApiUrl`](../pi-firecrawl/src/client.ts#L54) — 第 54 行
- [function `parseResponseBody`](../pi-firecrawl/src/client.ts#L58) — 第 58 行
- [function `formatPayload`](../pi-firecrawl/src/client.ts#L67) — 第 67 行
- [function `jsonResult`](../pi-firecrawl/src/client.ts#L71) — 第 71 行
- [function `withStatus`](../pi-firecrawl/src/client.ts#L78) — 第 78 行
- [function `cleanObject`](../pi-firecrawl/src/client.ts#L91) — 第 91 行

### src/firecrawl.ts

- [function `firecrawl`](../pi-firecrawl/src/firecrawl.ts#L54) — 第 54 行
- [function `handleFirecrawlCommand`](../pi-firecrawl/src/firecrawl.ts#L89) — 第 89 行
- [function `showMenu`](../pi-firecrawl/src/firecrawl.ts#L119) — 第 119 行
- [function `parseCommand`](../pi-firecrawl/src/firecrawl.ts#L148) — 第 148 行
- [function `commandCompletions`](../pi-firecrawl/src/firecrawl.ts#L161) — 第 161 行

### src/index.ts

- 无具名函数定义（仅 re-export、类型或常量）。

### src/settings.ts

- [function `loadSettings`](../pi-firecrawl/src/settings.ts#L26) — 第 26 行
- [function `readSettingsFile`](../pi-firecrawl/src/settings.ts#L53) — 第 53 行
- [function `withLegacyIgnoredNotice`](../pi-firecrawl/src/settings.ts#L75) — 第 75 行
- [function `installSettingsFileExclusively`](../pi-firecrawl/src/settings.ts#L83) — 第 83 行
- [function `migrateLegacySettings`](../pi-firecrawl/src/settings.ts#L94) — 第 94 行
- [function `fileExists`](../pi-firecrawl/src/settings.ts#L126) — 第 126 行
- [function `normalizeFirecrawlSettings`](../pi-firecrawl/src/settings.ts#L135) — 第 135 行
- [function `isFirecrawlToolName`](../pi-firecrawl/src/settings.ts#L144) — 第 144 行
- [function `orderedUniqueFirecrawlTools`](../pi-firecrawl/src/settings.ts#L148) — 第 148 行
- [function `saveSettings`](../pi-firecrawl/src/settings.ts#L153) — 第 153 行
- [function `settingsFilePath`](../pi-firecrawl/src/settings.ts#L166) — 第 166 行
- [function `legacySettingsFilePath`](../pi-firecrawl/src/settings.ts#L170) — 第 170 行
- [function `agentDir`](../pi-firecrawl/src/settings.ts#L174) — 第 174 行
- [function `isNodeError`](../pi-firecrawl/src/settings.ts#L178) — 第 178 行
- [function `formatError`](../pi-firecrawl/src/settings.ts#L182) — 第 182 行
- [function `unique`](../pi-firecrawl/src/settings.ts#L186) — 第 186 行

### src/tool-selector.ts

- [function `clearSettingsNotice`](../pi-firecrawl/src/tool-selector.ts#L24) — 第 24 行
- [function `recordSettingsNotice`](../pi-firecrawl/src/tool-selector.ts#L28) — 第 28 行
- [function `showToolSelector`](../pi-firecrawl/src/tool-selector.ts#L32) — 第 32 行
- [callback `commitSelectedTools`](../pi-firecrawl/src/tool-selector.ts#L43) — 第 43 行
- [callback `moveSelection`](../pi-firecrawl/src/tool-selector.ts#L53) — 第 53 行
- [callback `activateSelectedRow`](../pi-firecrawl/src/tool-selector.ts#L56) — 第 56 行
- [method `invalidate`](../pi-firecrawl/src/tool-selector.ts#L82) — 第 82 行
- [method `render`](../pi-firecrawl/src/tool-selector.ts#L83) — 第 83 行
- [method `handleInput`](../pi-firecrawl/src/tool-selector.ts#L98) — 第 98 行
- [function `showDialogToolSelector`](../pi-firecrawl/src/tool-selector.ts#L141) — 第 141 行
- [function `updateFirecrawlTools`](../pi-firecrawl/src/tool-selector.ts#L168) — 第 168 行
- [function `setSelectedFirecrawlTools`](../pi-firecrawl/src/tool-selector.ts#L181) — 第 181 行
- [function `applyFirecrawlTools`](../pi-firecrawl/src/tool-selector.ts#L190) — 第 190 行
- [function `getToolStatusSummary`](../pi-firecrawl/src/tool-selector.ts#L199) — 第 199 行
- [function `buildStatusMessage`](../pi-firecrawl/src/tool-selector.ts#L218) — 第 218 行
- [function `buildConfigMessage`](../pi-firecrawl/src/tool-selector.ts#L232) — 第 232 行
- [function `buildCommandGuide`](../pi-firecrawl/src/tool-selector.ts#L242) — 第 242 行
- [function `toolSelectorTitle`](../pi-firecrawl/src/tool-selector.ts#L257) — 第 257 行
- [function `firecrawlToolSelectorRows`](../pi-firecrawl/src/tool-selector.ts#L261) — 第 261 行
- [function `formatToolSelectorRow`](../pi-firecrawl/src/tool-selector.ts#L270) — 第 270 行
- [function `getActiveFirecrawlTools`](../pi-firecrawl/src/tool-selector.ts#L278) — 第 278 行
- [function `allFirecrawlTools`](../pi-firecrawl/src/tool-selector.ts#L283) — 第 283 行
- [function `unique`](../pi-firecrawl/src/tool-selector.ts#L287) — 第 287 行
- [function `orderedFirecrawlTools`](../pi-firecrawl/src/tool-selector.ts#L291) — 第 291 行
- [function `formatRuntimeStatus`](../pi-firecrawl/src/tool-selector.ts#L295) — 第 295 行
- [function `persistedSettingLabel`](../pi-firecrawl/src/tool-selector.ts#L299) — 第 299 行
- [function `formatPersistedSelection`](../pi-firecrawl/src/tool-selector.ts#L309) — 第 309 行
- [function `formatError`](../pi-firecrawl/src/tool-selector.ts#L317) — 第 317 行
- [function `persistSettings`](../pi-firecrawl/src/tool-selector.ts#L321) — 第 321 行

### src/tools.ts

- [method `execute`](../pi-firecrawl/src/tools.ts#L70) — 第 70 行
- [method `execute`](../pi-firecrawl/src/tools.ts#L108) — 第 108 行
- [method `execute`](../pi-firecrawl/src/tools.ts#L124) — 第 124 行
- [method `execute`](../pi-firecrawl/src/tools.ts#L156) — 第 156 行
- [method `execute`](../pi-firecrawl/src/tools.ts#L180) — 第 180 行

## pi-goal

### src/accounting.ts

- [function `checkpointGoalActiveTime`](../pi-goal/src/accounting.ts#L21) — 第 21 行
- [function `updateGoalUsage`](../pi-goal/src/accounting.ts#L36) — 第 36 行
- [function `formatDuration`](../pi-goal/src/accounting.ts#L49) — 第 49 行
- [function `formatTokenCount`](../pi-goal/src/accounting.ts#L58) — 第 58 行
- [function `isNonNegativeFiniteNumber`](../pi-goal/src/accounting.ts#L66) — 第 66 行
- [function `nonNegativeFiniteNumber`](../pi-goal/src/accounting.ts#L70) — 第 70 行
- [function `normalizeTokenBudget`](../pi-goal/src/accounting.ts#L74) — 第 74 行
- [function `assistantUsageTokens`](../pi-goal/src/accounting.ts#L80) — 第 80 行
- [function `cumulativeAssistantTokens`](../pi-goal/src/accounting.ts#L93) — 第 93 行
- [function `currentTokenTotal`](../pi-goal/src/accounting.ts#L105) — 第 105 行

### src/command.ts

- [function `completeGoalArguments`](../pi-goal/src/command.ts#L53) — 第 53 行
- [function `parseCommand`](../pi-goal/src/command.ts#L95) — 第 95 行
- [function `parseObjective`](../pi-goal/src/command.ts#L125) — 第 125 行
- [function `tokenize`](../pi-goal/src/command.ts#L150) — 第 150 行
- [function `parseTokenBudget`](../pi-goal/src/command.ts#L175) — 第 175 行
- [function `validateObjective`](../pi-goal/src/command.ts#L185) — 第 185 行
- [function `normalizeTokenBudget`](../pi-goal/src/command.ts#L194) — 第 194 行

### src/commands.ts

- [class `GoalCommandController`](../pi-goal/src/commands.ts#L34) — 第 34 行
- [method `constructor`](../pi-goal/src/commands.ts#L37) — 第 37 行
- [method `startGoal`](../pi-goal/src/commands.ts#L41) — 第 41 行
- [method `addGoal`](../pi-goal/src/commands.ts#L130) — 第 130 行
- [method `prioritizeGoal`](../pi-goal/src/commands.ts#L151) — 第 151 行
- [method `dropLastGoal`](../pi-goal/src/commands.ts#L171) — 第 171 行
- [method `skipGoal`](../pi-goal/src/commands.ts#L188) — 第 188 行
- [method `dispatchPendingQueueActionIfSettled`](../pi-goal/src/commands.ts#L217) — 第 217 行
- [method `notifyFrozenQueue`](../pi-goal/src/commands.ts#L311) — 第 311 行
- [method `pauseGoal`](../pi-goal/src/commands.ts#L318) — 第 318 行
- [method `resumeGoal`](../pi-goal/src/commands.ts#L341) — 第 341 行
- [method `clearGoal`](../pi-goal/src/commands.ts#L415) — 第 415 行
- [method `editGoal`](../pi-goal/src/commands.ts#L432) — 第 432 行
- [method `showGoal`](../pi-goal/src/commands.ts#L517) — 第 517 行
- [method `activatePrioritizedGoal`](../pi-goal/src/commands.ts#L539) — 第 539 行

### src/errors.ts

- [function `formatError`](../pi-goal/src/errors.ts#L39) — 第 39 行
- [function `truncateNotification`](../pi-goal/src/errors.ts#L43) — 第 43 行
- [function `isUsageLimitedGoalInterruption`](../pi-goal/src/errors.ts#L47) — 第 47 行
- [function `isRetryableGoalInterruption`](../pi-goal/src/errors.ts#L56) — 第 56 行
- [function `isGoalContextOverflow`](../pi-goal/src/errors.ts#L71) — 第 71 行
- [function `findFinalAssistantMessage`](../pi-goal/src/errors.ts#L75) — 第 75 行
- [function `toPiAssistantMessage`](../pi-goal/src/errors.ts#L100) — 第 100 行
- [function `zeroUsage`](../pi-goal/src/errors.ts#L114) — 第 114 行
- [function `isAgentStopReason`](../pi-goal/src/errors.ts#L125) — 第 125 行
- [function `normalizeUsage`](../pi-goal/src/errors.ts#L129) — 第 129 行

### src/goal.ts

- [function `registerGoalRuntime`](../pi-goal/src/goal.ts#L63) — 第 63 行
- [callback `sendOwnedGoalPrompt`](../pi-goal/src/goal.ts#L106) — 第 106 行
- [method `execute`](../pi-goal/src/goal.ts#L139) — 第 139 行
- [method `execute`](../pi-goal/src/goal.ts#L320) — 第 320 行
- [callback `reject`](../pi-goal/src/goal.ts#L328) — 第 328 行
- [function `beginNonGoalFollowUp`](../pi-goal/src/goal.ts#L1041) — 第 1041 行
- [function `hasPendingSkipForGoal`](../pi-goal/src/goal.ts#L1051) — 第 1051 行
- [function `stopGoalAfterAgentEnd`](../pi-goal/src/goal.ts#L1059) — 第 1059 行
- [function `goal`](../pi-goal/src/goal.ts#L1101) — 第 1101 行

### src/index.ts

- 无具名函数定义（仅 re-export、类型或常量）。

### src/markers.ts

- [function `extractGoalPromptMarker`](../pi-goal/src/markers.ts#L11) — 第 11 行
- [function `extractContinuationMarker`](../pi-goal/src/markers.ts#L15) — 第 15 行
- [function `appendGoalPromptMarker`](../pi-goal/src/markers.ts#L19) — 第 19 行
- [function `escapeRegExpText`](../pi-goal/src/markers.ts#L23) — 第 23 行

### src/persistence.ts

- [function `serializeGoalState`](../pi-goal/src/persistence.ts#L80) — 第 80 行
- [function `loadGoalStateFromSession`](../pi-goal/src/persistence.ts#L92) — 第 92 行
- [function `loadGoalFromSession`](../pi-goal/src/persistence.ts#L107) — 第 107 行
- [function `loadCanonicalGoalState`](../pi-goal/src/persistence.ts#L113) — 第 113 行
- [function `loadLegacyGoalsState`](../pi-goal/src/persistence.ts#L140) — 第 140 行
- [function `normalizePendingQueueAction`](../pi-goal/src/persistence.ts#L166) — 第 166 行
- [function `normalizeLegacyPendingPrioritize`](../pi-goal/src/persistence.ts#L203) — 第 203 行
- [function `validObjective`](../pi-goal/src/persistence.ts#L212) — 第 212 行
- [function `normalizeQueuedGoal`](../pi-goal/src/persistence.ts#L216) — 第 216 行
- [function `normalizeLoadedGoal`](../pi-goal/src/persistence.ts#L223) — 第 223 行
- [function `normalizeSafetyCounter`](../pi-goal/src/persistence.ts#L243) — 第 243 行
- [function `normalizeOutputFingerprint`](../pi-goal/src/persistence.ts#L247) — 第 247 行
- [function `normalizeSafetyPauseCause`](../pi-goal/src/persistence.ts#L251) — 第 251 行
- [function `clearLegacyPersistedGoal`](../pi-goal/src/persistence.ts#L255) — 第 255 行
- [function `readState`](../pi-goal/src/persistence.ts#L263) — 第 263 行
- [function `isGoal`](../pi-goal/src/persistence.ts#L275) — 第 275 行
- [function `isQueueGoal`](../pi-goal/src/persistence.ts#L302) — 第 302 行
- [function `isRecord`](../pi-goal/src/persistence.ts#L306) — 第 306 行
- [function `emptyGoalState`](../pi-goal/src/persistence.ts#L310) — 第 310 行

### src/prompts.ts

- [function `buildGoalPrompt`](../pi-goal/src/prompts.ts#L26) — 第 26 行
- [function `buildObjectiveUpdatedPrompt`](../pi-goal/src/prompts.ts#L32) — 第 32 行
- [function `buildResumePrompt`](../pi-goal/src/prompts.ts#L38) — 第 38 行
- [function `buildGoalSystemPrompt`](../pi-goal/src/prompts.ts#L44) — 第 44 行
- [function `buildContinuePrompt`](../pi-goal/src/prompts.ts#L52) — 第 52 行
- [function `goalContextBlock`](../pi-goal/src/prompts.ts#L56) — 第 56 行
- [function `goalObjectiveTrustBoundary`](../pi-goal/src/prompts.ts#L60) — 第 60 行
- [function `goalObjectiveBlock`](../pi-goal/src/prompts.ts#L64) — 第 64 行
- [function `goalCompletionGuardBlock`](../pi-goal/src/prompts.ts#L68) — 第 68 行
- [function `goalModeRules`](../pi-goal/src/prompts.ts#L72) — 第 72 行
- [function `formatBudget`](../pi-goal/src/prompts.ts#L89) — 第 89 行
- [function `stoppedStatusLabel`](../pi-goal/src/prompts.ts#L93) — 第 93 行
- [function `continuationMarkerComment`](../pi-goal/src/prompts.ts#L99) — 第 99 行
- [function `escapeXmlText`](../pi-goal/src/prompts.ts#L103) — 第 103 行

### src/queue.ts

- [function `createQueuedGoal`](../pi-goal/src/queue.ts#L15) — 第 15 行
- [function `appendGoal`](../pi-goal/src/queue.ts#L36) — 第 36 行
- [function `prioritizeGoal`](../pi-goal/src/queue.ts#L40) — 第 40 行
- [function `dropLastGoal`](../pi-goal/src/queue.ts#L52) — 第 52 行
- [function `skipGoal`](../pi-goal/src/queue.ts#L66) — 第 66 行
- [function `shelveGoal`](../pi-goal/src/queue.ts#L70) — 第 70 行
- [function `activateQueuedGoal`](../pi-goal/src/queue.ts#L77) — 第 77 行

### src/rpc.ts

- [function `rpcReplyChannel`](../pi-goal/src/rpc.ts#L34) — 第 34 行
- [function `parseRpcStartPayload`](../pi-goal/src/rpc.ts#L38) — 第 38 行
- [class `GoalRpcController`](../pi-goal/src/rpc.ts#L61) — 第 61 行
- [method `constructor`](../pi-goal/src/rpc.ts#L67) — 第 67 行
- [method `register`](../pi-goal/src/rpc.ts#L72) — 第 72 行
- [method `bindSession`](../pi-goal/src/rpc.ts#L81) — 第 81 行
- [method `unbindSession`](../pi-goal/src/rpc.ts#L86) — 第 86 行
- [method `handleStart`](../pi-goal/src/rpc.ts#L91) — 第 91 行
- [callback `reply`](../pi-goal/src/rpc.ts#L96) — 第 96 行
- [method `handlePause`](../pi-goal/src/rpc.ts#L152) — 第 152 行
- [method `clearOwnership`](../pi-goal/src/rpc.ts#L180) — 第 180 行

### src/runtime.ts

- [function `isTerminalGoalStatus`](../pi-goal/src/runtime.ts#L98) — 第 98 行
- [function `buildGoalStateEvent`](../pi-goal/src/runtime.ts#L106) — 第 106 行
- [class `GoalRuntime`](../pi-goal/src/runtime.ts#L149) — 第 149 行
- [method `constructor`](../pi-goal/src/runtime.ts#L180) — 第 180 行
- [method `canRecordGoalUsage`](../pi-goal/src/runtime.ts#L184) — 第 184 行
- [method `hasActiveBudgetWrapUp`](../pi-goal/src/runtime.ts#L197) — 第 197 行
- [method `hasActiveGoalRecovery`](../pi-goal/src/runtime.ts#L205) — 第 205 行
- [method `beginAgentRun`](../pi-goal/src/runtime.ts#L209) — 第 209 行
- [method `beginRecoveryRunIfNeeded`](../pi-goal/src/runtime.ts#L215) — 第 215 行
- [method `markAgentToolAttempted`](../pi-goal/src/runtime.ts#L222) — 第 222 行
- [method `finishAgentRun`](../pi-goal/src/runtime.ts#L226) — 第 226 行
- [method `clearAgentRun`](../pi-goal/src/runtime.ts#L236) — 第 236 行
- [method `reclassifyAgentRunAsManual`](../pi-goal/src/runtime.ts#L242) — 第 242 行
- [method `isAutomaticRunForGoal`](../pi-goal/src/runtime.ts#L246) — 第 246 行
- [method `recordGoalUsage`](../pi-goal/src/runtime.ts#L250) — 第 250 行
- [method `requestContinuation`](../pi-goal/src/runtime.ts#L260) — 第 260 行
- [method `dispatchContinuationIfSettled`](../pi-goal/src/runtime.ts#L272) — 第 272 行
- [method `hasContinuationWorkForGoal`](../pi-goal/src/runtime.ts#L309) — 第 309 行
- [method `updateStatus`](../pi-goal/src/runtime.ts#L315) — 第 315 行
- [method `blockStaleGoalToolCalls`](../pi-goal/src/runtime.ts#L320) — 第 320 行
- [method `clearStaleGoalToolCallBlock`](../pi-goal/src/runtime.ts#L324) — 第 324 行
- [method `clearGoalRecovery`](../pi-goal/src/runtime.ts#L328) — 第 328 行
- [method `clearBudgetWrapUp`](../pi-goal/src/runtime.ts#L332) — 第 332 行
- [method `setCompletionSummary`](../pi-goal/src/runtime.ts#L336) — 第 336 行
- [method `setTerminalReason`](../pi-goal/src/runtime.ts#L340) — 第 340 行
- [method `clearTerminalDetails`](../pi-goal/src/runtime.ts#L344) — 第 344 行
- [method `isActiveBudgetWrapUpMessage`](../pi-goal/src/runtime.ts#L348) — 第 348 行
- [method `keepBudgetWrapUpMessage`](../pi-goal/src/runtime.ts#L364) — 第 364 行
- [method `queueBudgetWrapUp`](../pi-goal/src/runtime.ts#L373) — 第 373 行
- [method `limitActiveGoalForBudget`](../pi-goal/src/runtime.ts#L397) — 第 397 行
- [method `recordAutomaticTurn`](../pi-goal/src/runtime.ts#L422) — 第 422 行
- [method `recordAutomaticRunProgress`](../pi-goal/src/runtime.ts#L437) — 第 437 行
- [method `enforceAutomaticTurnLimit`](../pi-goal/src/runtime.ts#L455) — 第 455 行
- [method `enforceNoProgressLimit`](../pi-goal/src/runtime.ts#L464) — 第 464 行
- [method `pauseGoalForSafety`](../pi-goal/src/runtime.ts#L473) — 第 473 行
- [method `resetActiveSafetyEpoch`](../pi-goal/src/runtime.ts#L502) — 第 502 行
- [method `finalizeSettledRecovery`](../pi-goal/src/runtime.ts#L512) — 第 512 行
- [method `clearSettledSafetyTracking`](../pi-goal/src/runtime.ts#L533) — 第 533 行
- [method `clearGoalRecoveryForGoal`](../pi-goal/src/runtime.ts#L541) — 第 541 行
- [method `isPiOwnedCompactionRetry`](../pi-goal/src/runtime.ts#L545) — 第 545 行
- [method `clearContinuationTracking`](../pi-goal/src/runtime.ts#L555) — 第 555 行
- [method `clearPendingGoalPrompts`](../pi-goal/src/runtime.ts#L562) — 第 562 行
- [method `sendOwnedGoalPrompt`](../pi-goal/src/runtime.ts#L568) — 第 568 行
- [method `cancelContinuationWork`](../pi-goal/src/runtime.ts#L580) — 第 580 行
- [method `consumeCancelledContinuationPrompt`](../pi-goal/src/runtime.ts#L588) — 第 588 行
- [method `hasPendingOwnedGoalPrompt`](../pi-goal/src/runtime.ts#L593) — 第 593 行
- [method `hasOwnedPromptBoundary`](../pi-goal/src/runtime.ts#L598) — 第 598 行
- [method `consumeStaleOwnedGoalPrompt`](../pi-goal/src/runtime.ts#L615) — 第 615 行
- [method `noteQueuedNonGoalInput`](../pi-goal/src/runtime.ts#L632) — 第 632 行
- [method `consumeQueuedNonGoalInput`](../pi-goal/src/runtime.ts#L643) — 第 643 行
- [method `consumeQueuedNonGoalFollowUpForAgentStart`](../pi-goal/src/runtime.ts#L674) — 第 674 行
- [method `markContinuationStarted`](../pi-goal/src/runtime.ts#L684) — 第 684 行
- [method `persistGoal`](../pi-goal/src/runtime.ts#L700) — 第 700 行
- [method `clearPersistedGoal`](../pi-goal/src/runtime.ts#L714) — 第 714 行
- [method `clearActiveGoal`](../pi-goal/src/runtime.ts#L727) — 第 727 行
- [method `isGoalToolName`](../pi-goal/src/runtime.ts#L744) — 第 744 行
- [method `goalToolsAvailable`](../pi-goal/src/runtime.ts#L748) — 第 748 行
- [method `hideGoalToolsIfLocked`](../pi-goal/src/runtime.ts#L753) — 第 753 行
- [method `restoreGoalToolsHiddenByPolicy`](../pi-goal/src/runtime.ts#L762) — 第 762 行
- [method `assertGoalToolsAvailable`](../pi-goal/src/runtime.ts#L785) — 第 785 行
- [method `ensureGoalToolsVisible`](../pi-goal/src/runtime.ts#L792) — 第 792 行
- [method `prepareGoalToolsForActivation`](../pi-goal/src/runtime.ts#L800) — 第 800 行
- [method `revealGoalTools`](../pi-goal/src/runtime.ts#L812) — 第 812 行
- [method `snapshotGoalToolVisibility`](../pi-goal/src/runtime.ts#L826) — 第 826 行
- [method `restoreGoalToolVisibility`](../pi-goal/src/runtime.ts#L834) — 第 834 行
- [method `pauseGoalForUnavailableTools`](../pi-goal/src/runtime.ts#L843) — 第 843 行
- [method `showCompletionStatus`](../pi-goal/src/runtime.ts#L866) — 第 866 行
- [method `clearCompletionStatusTimer`](../pi-goal/src/runtime.ts#L880) — 第 880 行
- [method `rememberPendingGoalPrompt`](../pi-goal/src/runtime.ts#L886) — 第 886 行
- [method `consumePendingGoalPrompt`](../pi-goal/src/runtime.ts#L896) — 第 896 行
- [method `rememberClaimedGoalPromptMarker`](../pi-goal/src/runtime.ts#L905) — 第 905 行
- [method `rememberClaimedContinuationMarker`](../pi-goal/src/runtime.ts#L912) — 第 912 行
- [method `consumeOwnedGoalPrompt`](../pi-goal/src/runtime.ts#L919) — 第 919 行
- [method `rememberCancelledContinuationMarker`](../pi-goal/src/runtime.ts#L923) — 第 923 行
- [function `createGoal`](../pi-goal/src/runtime.ts#L931) — 第 931 行
- [function `transitionGoal`](../pi-goal/src/runtime.ts#L954) — 第 954 行
- [function `nextGoalInstance`](../pi-goal/src/runtime.ts#L967) — 第 967 行
- [function `editedGoalStatus`](../pi-goal/src/runtime.ts#L971) — 第 971 行
- [function `incrementGoal`](../pi-goal/src/runtime.ts#L976) — 第 976 行
- [function `formatStatus`](../pi-goal/src/runtime.ts#L980) — 第 980 行
- [function `formatBudget`](../pi-goal/src/runtime.ts#L992) — 第 992 行
- [function `goalSummary`](../pi-goal/src/runtime.ts#L996) — 第 996 行
- [function `hasPendingMessages`](../pi-goal/src/runtime.ts#L1034) — 第 1034 行
- [function `abortCurrentTurn`](../pi-goal/src/runtime.ts#L1038) — 第 1038 行
- [function `blocksStaleGoalToolCalls`](../pi-goal/src/runtime.ts#L1046) — 第 1046 行
- [function `isResumableGoalStatus`](../pi-goal/src/runtime.ts#L1050) — 第 1050 行
- [function `stoppedStatusLabel`](../pi-goal/src/runtime.ts#L1054) — 第 1054 行
- [function `isContradictoryCompletionSummary`](../pi-goal/src/runtime.ts#L1060) — 第 1060 行
- [function `goalIdRejectionReason`](../pi-goal/src/runtime.ts#L1064) — 第 1064 行
- [function `inputFingerprint`](../pi-goal/src/runtime.ts#L1070) — 第 1070 行
- [function `sendPrompt`](../pi-goal/src/runtime.ts#L1074) — 第 1074 行
- [function `goalCommandHint`](../pi-goal/src/runtime.ts#L1084) — 第 1084 行
- [function `continuationMarker`](../pi-goal/src/runtime.ts#L1097) — 第 1097 行

### src/safety.ts

- [function `queueGoalSafetyReset`](../pi-goal/src/safety.ts#L9) — 第 9 行
- [function `resetGoalSafetyEpoch`](../pi-goal/src/safety.ts#L13) — 第 13 行
- [function `nextToolFreeRepeatState`](../pi-goal/src/safety.ts#L24) — 第 24 行
- [function `hasAssistantToolCall`](../pi-goal/src/safety.ts#L40) — 第 40 行
- [function `fingerprintVisibleAssistantOutput`](../pi-goal/src/safety.ts#L50) — 第 50 行
- [function `normalizeVisibleAssistantOutput`](../pi-goal/src/safety.ts#L55) — 第 55 行
- [function `isRecord`](../pi-goal/src/safety.ts#L76) — 第 76 行

### src/settings.ts

- [function `normalizeGoalSettings`](../pi-goal/src/settings.ts#L47) — 第 47 行
- [function `normalizeContinuationLimit`](../pi-goal/src/settings.ts#L103) — 第 103 行
- [function `loadOrCreateGoalSettings`](../pi-goal/src/settings.ts#L112) — 第 112 行
- [function `readGoalSettings`](../pi-goal/src/settings.ts#L157) — 第 157 行
- [function `isNodeError`](../pi-goal/src/settings.ts#L178) — 第 178 行
- [function `isAlreadyExistsError`](../pi-goal/src/settings.ts#L182) — 第 182 行
- [function `formatError`](../pi-goal/src/settings.ts#L186) — 第 186 行

## pi-lsp

### src/adapters.ts

- [function `loadRuntime`](../pi-lsp/src/adapters.ts#L223) — 第 223 行
- [function `loadConfig`](../pi-lsp/src/adapters.ts#L231) — 第 231 行
- [function `loadConfiguredConfig`](../pi-lsp/src/adapters.ts#L242) — 第 242 行
- [function `installFileExclusively`](../pi-lsp/src/adapters.ts#L309) — 第 309 行
- [function `removeFileIfIdentityMatches`](../pi-lsp/src/adapters.ts#L326) — 第 326 行
- [function `fileContentsEqual`](../pi-lsp/src/adapters.ts#L342) — 第 342 行
- [function `consumeLspConfigNotice`](../pi-lsp/src/adapters.ts#L350) — 第 350 行
- [function `formatError`](../pi-lsp/src/adapters.ts#L356) — 第 356 行
- [function `parseConfigSource`](../pi-lsp/src/adapters.ts#L360) — 第 360 行
- [function `parseConfigFile`](../pi-lsp/src/adapters.ts#L369) — 第 369 行
- [function `normalizeConfig`](../pi-lsp/src/adapters.ts#L373) — 第 373 行
- [function `normalizeServerMap`](../pi-lsp/src/adapters.ts#L403) — 第 403 行
- [function `isServerEntry`](../pi-lsp/src/adapters.ts#L409) — 第 409 行
- [function `normalizeServer`](../pi-lsp/src/adapters.ts#L413) — 第 413 行
- [function `normalizeTimeout`](../pi-lsp/src/adapters.ts#L428) — 第 428 行
- [function `configToAdapter`](../pi-lsp/src/adapters.ts#L436) — 第 436 行
- [function `languageIdFor`](../pi-lsp/src/adapters.ts#L456) — 第 456 行
- [function `commandFromEnvName`](../pi-lsp/src/adapters.ts#L531) — 第 531 行
- [function `envName`](../pi-lsp/src/adapters.ts#L538) — 第 538 行
- [function `normalizeExtension`](../pi-lsp/src/adapters.ts#L542) — 第 542 行
- [function `stringArrayField`](../pi-lsp/src/adapters.ts#L546) — 第 546 行
- [function `optionalPositiveNumberField`](../pi-lsp/src/adapters.ts#L554) — 第 554 行
- [function `optionalStringRecordField`](../pi-lsp/src/adapters.ts#L563) — 第 563 行
- [function `optionalRecordField`](../pi-lsp/src/adapters.ts#L575) — 第 575 行
- [function `optionalDirectoryNamesField`](../pi-lsp/src/adapters.ts#L584) — 第 584 行
- [function `expandHome`](../pi-lsp/src/adapters.ts#L603) — 第 603 行
- [function `isRecord`](../pi-lsp/src/adapters.ts#L611) — 第 611 行

### src/command.ts

- [function `commandFromEnv`](../pi-lsp/src/command.ts#L6) — 第 6 行
- [function `commandExists`](../pi-lsp/src/command.ts#L16) — 第 16 行
- [function `commandPathValue`](../pi-lsp/src/command.ts#L24) — 第 24 行
- [function `mergeEnvironment`](../pi-lsp/src/command.ts#L33) — 第 33 行
- [function `environmentValue`](../pi-lsp/src/command.ts#L49) — 第 49 行
- [function `resolveCommandPath`](../pi-lsp/src/command.ts#L62) — 第 62 行
- [function `resolveRunnableFile`](../pi-lsp/src/command.ts#L86) — 第 86 行
- [function `isRunnableFile`](../pi-lsp/src/command.ts#L94) — 第 94 行
- [function `splitCommand`](../pi-lsp/src/command.ts#L105) — 第 105 行
- [function `shouldEscapeNextCharacter`](../pi-lsp/src/command.ts#L145) — 第 145 行

### src/files.ts

- [function `resolveRoot`](../pi-lsp/src/files.ts#L7) — 第 7 行
- [function `directoryUri`](../pi-lsp/src/files.ts#L16) — 第 16 行
- [function `resolveSupportedFile`](../pi-lsp/src/files.ts#L20) — 第 20 行
- [function `collectSupportedFiles`](../pi-lsp/src/files.ts#L33) — 第 33 行
- [function `collectPath`](../pi-lsp/src/files.ts#L59) — 第 59 行
- [function `resolveWorkspacePath`](../pi-lsp/src/files.ts#L95) — 第 95 行
- [function `isInsidePath`](../pi-lsp/src/files.ts#L116) — 第 116 行

### src/index.ts

- 无具名函数定义（仅 re-export、类型或常量）。

### src/lsp-client.ts

- [function `resolveSpawnCommand`](../pi-lsp/src/lsp-client.ts#L15) — 第 15 行
- [class `LspClient`](../pi-lsp/src/lsp-client.ts#L30) — 第 30 行
- [method `constructor`](../pi-lsp/src/lsp-client.ts#L58) — 第 58 行
- [method `start`](../pi-lsp/src/lsp-client.ts#L65) — 第 65 行
- [method `initialize`](../pi-lsp/src/lsp-client.ts#L122) — 第 122 行
- [method `didOpen`](../pi-lsp/src/lsp-client.ts#L158) — 第 158 行
- [method `didClose`](../pi-lsp/src/lsp-client.ts#L164) — 第 164 行
- [method `diagnostics`](../pi-lsp/src/lsp-client.ts#L172) — 第 172 行
- [method `codeActions`](../pi-lsp/src/lsp-client.ts#L186) — 第 186 行
- [method `resolveActions`](../pi-lsp/src/lsp-client.ts#L195) — 第 195 行
- [method `shutdown`](../pi-lsp/src/lsp-client.ts#L218) — 第 218 行
- [method `close`](../pi-lsp/src/lsp-client.ts#L231) — 第 231 行
- [method `#rejectPending`](../pi-lsp/src/lsp-client.ts#L238) — 第 238 行
- [method `#fail`](../pi-lsp/src/lsp-client.ts#L252) — 第 252 行
- [method `request`](../pi-lsp/src/lsp-client.ts#L258) — 第 258 行
- [method `notify`](../pi-lsp/src/lsp-client.ts#L282) — 第 282 行
- [method `#send`](../pi-lsp/src/lsp-client.ts#L288) — 第 288 行
- [method `#onData`](../pi-lsp/src/lsp-client.ts#L303) — 第 303 行
- [method `#handleMessage`](../pi-lsp/src/lsp-client.ts#L324) — 第 324 行
- [method `#waitForPublishedDiagnostics`](../pi-lsp/src/lsp-client.ts#L357) — 第 357 行
- [callback `dispose`](../pi-lsp/src/lsp-client.ts#L363) — 第 363 行
- [callback `settleWith`](../pi-lsp/src/lsp-client.ts#L370) — 第 370 行
- [callback `fail`](../pi-lsp/src/lsp-client.ts#L374) — 第 374 行
- [callback `onPublish`](../pi-lsp/src/lsp-client.ts#L378) — 第 378 行
- [method `#respondToServerRequest`](../pi-lsp/src/lsp-client.ts#L408) — 第 408 行
- [method `#configurationValue`](../pi-lsp/src/lsp-client.ts#L444) — 第 444 行
- [method `#formatStderr`](../pi-lsp/src/lsp-client.ts#L449) — 第 449 行
- [function `formatErrorMessage`](../pi-lsp/src/lsp-client.ts#L455) — 第 455 行

### src/pi-lsp.ts

- [method `execute`](../pi-lsp/src/pi-lsp.ts#L60) — 第 60 行
- [method `execute`](../pi-lsp/src/pi-lsp.ts#L126) — 第 126 行
- [function `lsp`](../pi-lsp/src/pi-lsp.ts#L141) — 第 141 行
- [function `formatError`](../pi-lsp/src/pi-lsp.ts#L175) — 第 175 行
- [function `textFromResult`](../pi-lsp/src/pi-lsp.ts#L179) — 第 179 行
- [function `buildStatusMessage`](../pi-lsp/src/pi-lsp.ts#L183) — 第 183 行
- [function `statusLevel`](../pi-lsp/src/pi-lsp.ts#L199) — 第 199 行

### src/routes.ts

- [function `selectDiagnosticRoutes`](../pi-lsp/src/routes.ts#L35) — 第 35 行
- [function `selectFixRoute`](../pi-lsp/src/routes.ts#L74) — 第 74 行
- [function `diagnosticFilePolicyKey`](../pi-lsp/src/routes.ts#L97) — 第 97 行
- [function `filterAdapters`](../pi-lsp/src/routes.ts#L104) — 第 104 行
- [function `unsupportedFileError`](../pi-lsp/src/routes.ts#L122) — 第 122 行

### src/runner.ts

- [function `runDiagnostics`](../pi-lsp/src/runner.ts#L18) — 第 18 行
- [callback `abort`](../pi-lsp/src/runner.ts#L41) — 第 41 行
- [function `runFix`](../pi-lsp/src/runner.ts#L83) — 第 83 行
- [callback `abort`](../pi-lsp/src/runner.ts#L97) — 第 97 行
- [function `selectCodeActions`](../pi-lsp/src/runner.ts#L155) — 第 155 行
- [function `formatDiagnostics`](../pi-lsp/src/runner.ts#L161) — 第 161 行
- [function `formatEditSummary`](../pi-lsp/src/runner.ts#L183) — 第 183 行
- [function `summarize`](../pi-lsp/src/runner.ts#L199) — 第 199 行
- [function `severityName`](../pi-lsp/src/runner.ts#L206) — 第 206 行
- [function `throwIfAborted`](../pi-lsp/src/runner.ts#L214) — 第 214 行
- [function `textResult`](../pi-lsp/src/runner.ts#L218) — 第 218 行

### src/text-edits.ts

- [function `positionAt`](../pi-lsp/src/text-edits.ts#L3) — 第 3 行
- [function `offsetAt`](../pi-lsp/src/text-edits.ts#L18) — 第 18 行
- [function `applyTextEdits`](../pi-lsp/src/text-edits.ts#L36) — 第 36 行
- [function `hasOverlappingTextEdits`](../pi-lsp/src/text-edits.ts#L51) — 第 51 行
- [function `positionTextEdits`](../pi-lsp/src/text-edits.ts#L63) — 第 63 行
- [function `textEditRangesConflict`](../pi-lsp/src/text-edits.ts#L72) — 第 72 行
- [function `collectWorkspaceEdits`](../pi-lsp/src/text-edits.ts#L87) — 第 87 行

### src/types.ts

- 无具名函数定义（仅 re-export、类型或常量）。

## pi-plan-mode

### src/completion-tool.ts

- [function `normalizePlanModeCompletion`](../pi-plan-mode/src/completion-tool.ts#L29) — 第 29 行
- [function `planFromCompletionDetails`](../pi-plan-mode/src/completion-tool.ts#L44) — 第 44 行
- [function `planModeCompleted`](../pi-plan-mode/src/completion-tool.ts#L56) — 第 56 行
- [function `isRecord`](../pi-plan-mode/src/completion-tool.ts#L68) — 第 68 行

### src/index.ts

- 无具名函数定义（仅 re-export、类型或常量）。

### src/message-transform.ts

- [function `parseProposedPlan`](../pi-plan-mode/src/message-transform.ts#L30) — 第 30 行
- [function `extractProposedPlan`](../pi-plan-mode/src/message-transform.ts#L44) — 第 44 行
- [function `latestAssistantText`](../pi-plan-mode/src/message-transform.ts#L49) — 第 49 行
- [function `messageContainsLegacyPlanModeContextArtifact`](../pi-plan-mode/src/message-transform.ts#L60) — 第 60 行
- [function `messageContainsInactivePlanModeArtifact`](../pi-plan-mode/src/message-transform.ts#L64) — 第 64 行
- [function `messageContainsPlanModeImplementationHandoff`](../pi-plan-mode/src/message-transform.ts#L72) — 第 72 行
- [function `stripProposedPlanBlocksFromMessage`](../pi-plan-mode/src/message-transform.ts#L80) — 第 80 行
- [function `stripPlanModeCompletionCallsFromMessage`](../pi-plan-mode/src/message-transform.ts#L84) — 第 84 行
- [function `isEmptyAssistantMessage`](../pi-plan-mode/src/message-transform.ts#L95) — 第 95 行
- [function `replaceAssistantContent`](../pi-plan-mode/src/message-transform.ts#L104) — 第 104 行
- [function `unwrapSessionMessage`](../pi-plan-mode/src/message-transform.ts#L117) — 第 117 行
- [function `isSessionMessageEntry`](../pi-plan-mode/src/message-transform.ts#L127) — 第 127 行
- [function `stripProposedPlanBlocksFromContent`](../pi-plan-mode/src/message-transform.ts#L131) — 第 131 行
- [function `stripProposedPlanBlocks`](../pi-plan-mode/src/message-transform.ts#L149) — 第 149 行
- [function `messageText`](../pi-plan-mode/src/message-transform.ts#L153) — 第 153 行
- [function `contentText`](../pi-plan-mode/src/message-transform.ts#L157) — 第 157 行

### src/plan-mode.ts

- [function `onAgentSettled`](../pi-plan-mode/src/plan-mode.ts#L55) — 第 55 行
- [function `setPlanThinkingLevel`](../pi-plan-mode/src/plan-mode.ts#L63) — 第 63 行
- [function `planMode`](../pi-plan-mode/src/plan-mode.ts#L92) — 第 92 行
- [method `execute`](../pi-plan-mode/src/plan-mode.ts#L115) — 第 115 行
- [method `execute`](../pi-plan-mode/src/plan-mode.ts#L160) — 第 160 行
- [function `enterPlanMode`](../pi-plan-mode/src/plan-mode.ts#L381) — 第 381 行
- [function `enterPlanModeWithPrompt`](../pi-plan-mode/src/plan-mode.ts#L390) — 第 390 行
- [function `exitPlanMode`](../pi-plan-mode/src/plan-mode.ts#L399) — 第 399 行
- [function `sendPlanModeUserMessage`](../pi-plan-mode/src/plan-mode.ts#L419) — 第 419 行
- [function `acceptCompletedPlan`](../pi-plan-mode/src/plan-mode.ts#L431) — 第 431 行
- [function `completedPlanIsCurrent`](../pi-plan-mode/src/plan-mode.ts#L455) — 第 455 行
- [function `readyPresentationIsCurrent`](../pi-plan-mode/src/plan-mode.ts#L464) — 第 464 行
- [function `showStoredPlan`](../pi-plan-mode/src/plan-mode.ts#L468) — 第 468 行
- [function `requestFinalPlan`](../pi-plan-mode/src/plan-mode.ts#L492) — 第 492 行
- [function `startImplementation`](../pi-plan-mode/src/plan-mode.ts#L503) — 第 503 行
- [function `showPlanMenu`](../pi-plan-mode/src/plan-mode.ts#L525) — 第 525 行
- [function `showPlanReadyMenu`](../pi-plan-mode/src/plan-mode.ts#L565) — 第 565 行
- [function `showToolSelector`](../pi-plan-mode/src/plan-mode.ts#L581) — 第 581 行
- [function `showDialogToolSelector`](../pi-plan-mode/src/plan-mode.ts#L636) — 第 636 行
- [function `togglePlanModeTool`](../pi-plan-mode/src/plan-mode.ts#L679) — 第 679 行
- [function `activatePlanModeTools`](../pi-plan-mode/src/plan-mode.ts#L692) — 第 692 行
- [function `applyPlanModeTools`](../pi-plan-mode/src/plan-mode.ts#L697) — 第 697 行
- [function `planModeToolNames`](../pi-plan-mode/src/plan-mode.ts#L701) — 第 701 行
- [function `planModeSelectedNames`](../pi-plan-mode/src/plan-mode.ts#L720) — 第 720 行
- [function `defaultPlanModeToolNames`](../pi-plan-mode/src/plan-mode.ts#L732) — 第 732 行
- [function `migrateSelectedToolKeys`](../pi-plan-mode/src/plan-mode.ts#L741) — 第 741 行
- [function `filterAvailableSelectedNames`](../pi-plan-mode/src/plan-mode.ts#L748) — 第 748 行
- [function `selectableTools`](../pi-plan-mode/src/plan-mode.ts#L753) — 第 753 行
- [function `toolSelectorPageCount`](../pi-plan-mode/src/plan-mode.ts#L762) — 第 762 行
- [function `safeGetAllTools`](../pi-plan-mode/src/plan-mode.ts#L766) — 第 766 行
- [function `restoreTools`](../pi-plan-mode/src/plan-mode.ts#L774) — 第 774 行
- [function `applyPlanThinkingLevel`](../pi-plan-mode/src/plan-mode.ts#L780) — 第 780 行
- [function `captureManualThinkingLevel`](../pi-plan-mode/src/plan-mode.ts#L802) — 第 802 行
- [function `restoreThinkingLevel`](../pi-plan-mode/src/plan-mode.ts#L814) — 第 814 行
- [function `deactivatePlanModeQuestionTool`](../pi-plan-mode/src/plan-mode.ts#L827) — 第 827 行
- [function `safeGetActiveTools`](../pi-plan-mode/src/plan-mode.ts#L835) — 第 835 行
- [function `persistState`](../pi-plan-mode/src/plan-mode.ts#L843) — 第 843 行
- [function `restoreState`](../pi-plan-mode/src/plan-mode.ts#L847) — 第 847 行
- [function `updateUi`](../pi-plan-mode/src/plan-mode.ts#L851) — 第 851 行
- [function `formatStatus`](../pi-plan-mode/src/plan-mode.ts#L869) — 第 869 行
- [function `clearUi`](../pi-plan-mode/src/plan-mode.ts#L875) — 第 875 行
- [function `planStatusText`](../pi-plan-mode/src/plan-mode.ts#L880) — 第 880 行
- [function `formatToolSummary`](../pi-plan-mode/src/plan-mode.ts#L887) — 第 887 行
- [function `toolByName`](../pi-plan-mode/src/plan-mode.ts#L892) — 第 892 行
- [function `completePlanArguments`](../pi-plan-mode/src/plan-mode.ts#L897) — 第 897 行
- [function `toolNameFromLegacyKey`](../pi-plan-mode/src/plan-mode.ts#L906) — 第 906 行
- [function `compareTools`](../pi-plan-mode/src/plan-mode.ts#L913) — 第 913 行
- [function `formatToolChoice`](../pi-plan-mode/src/plan-mode.ts#L920) — 第 920 行
- [function `toolPolicyLabel`](../pi-plan-mode/src/plan-mode.ts#L925) — 第 925 行
- [function `toolSourceLabel`](../pi-plan-mode/src/plan-mode.ts#L933) — 第 933 行
- [function `unique`](../pi-plan-mode/src/plan-mode.ts#L939) — 第 939 行
- [function `isStaleExtensionContextError`](../pi-plan-mode/src/plan-mode.ts#L943) — 第 943 行
- [function `withRequiredPlanModeTools`](../pi-plan-mode/src/plan-mode.ts#L951) — 第 951 行
- [function `withoutPlanModeQuestionTool`](../pi-plan-mode/src/plan-mode.ts#L959) — 第 959 行
- [function `withoutRequiredPlanModeTools`](../pi-plan-mode/src/plan-mode.ts#L963) — 第 963 行
- [function `invalidPlanMessage`](../pi-plan-mode/src/plan-mode.ts#L970) — 第 970 行

### src/prompt.ts

- [function `buildPlanModePrompt`](../pi-plan-mode/src/prompt.ts#L3) — 第 3 行

### src/question-tool.ts

- [function `normalizePlanModeQuestionParams`](../pi-plan-mode/src/question-tool.ts#L82) — 第 82 行
- [function `askPlanModeQuestions`](../pi-plan-mode/src/question-tool.ts#L133) — 第 133 行
- [function `formatPlanModeQuestionChoice`](../pi-plan-mode/src/question-tool.ts#L170) — 第 170 行
- [function `planModeQuestionAnswered`](../pi-plan-mode/src/question-tool.ts#L174) — 第 174 行
- [function `planModeQuestionCancelled`](../pi-plan-mode/src/question-tool.ts#L181) — 第 181 行
- [function `formatPlanModeQuestionPayload`](../pi-plan-mode/src/question-tool.ts#L192) — 第 192 行
- [function `isRecord`](../pi-plan-mode/src/question-tool.ts#L201) — 第 201 行
- [function `stringField`](../pi-plan-mode/src/question-tool.ts#L205) — 第 205 行

### src/selector-ui.ts

- [function `showPersistentSelector`](../pi-plan-mode/src/selector-ui.ts#L16) — 第 16 行
- [callback `currentView`](../pi-plan-mode/src/selector-ui.ts#L23) — 第 23 行
- [callback `moveSelection`](../pi-plan-mode/src/selector-ui.ts#L28) — 第 28 行
- [callback `activateSelectedRow`](../pi-plan-mode/src/selector-ui.ts#L33) — 第 33 行
- [method `invalidate`](../pi-plan-mode/src/selector-ui.ts#L42) — 第 42 行
- [method `render`](../pi-plan-mode/src/selector-ui.ts#L43) — 第 43 行
- [method `handleInput`](../pi-plan-mode/src/selector-ui.ts#L60) — 第 60 行
- [function `clipLine`](../pi-plan-mode/src/selector-ui.ts#L93) — 第 93 行

### src/settings.ts

- [function `normalizePlanModeSettings`](../pi-plan-mode/src/settings.ts#L39) — 第 39 行
- [function `normalizeToolNames`](../pi-plan-mode/src/settings.ts#L68) — 第 68 行
- [function `normalizeSafeSubcommands`](../pi-plan-mode/src/settings.ts#L78) — 第 78 行
- [function `normalizeKnownValues`](../pi-plan-mode/src/settings.ts#L96) — 第 96 行
- [function `readPlanModeSettings`](../pi-plan-mode/src/settings.ts#L106) — 第 106 行
- [function `installFileExclusively`](../pi-plan-mode/src/settings.ts#L172) — 第 172 行
- [function `removeFileIfIdentityMatches`](../pi-plan-mode/src/settings.ts#L184) — 第 184 行
- [function `readSettingsFile`](../pi-plan-mode/src/settings.ts#L200) — 第 200 行
- [function `readSettingsSnapshot`](../pi-plan-mode/src/settings.ts#L204) — 第 204 行
- [function `configuredThinkingLevel`](../pi-plan-mode/src/settings.ts#L228) — 第 228 行
- [function `fileContentsEqual`](../pi-plan-mode/src/settings.ts#L234) — 第 234 行
- [function `exists`](../pi-plan-mode/src/settings.ts#L242) — 第 242 行
- [function `isNodeError`](../pi-plan-mode/src/settings.ts#L251) — 第 251 行
- [function `formatError`](../pi-plan-mode/src/settings.ts#L255) — 第 255 行

### src/state.ts

- [function `restorePlanModeState`](../pi-plan-mode/src/state.ts#L38) — 第 38 行
- [function `normalizePersistedPlan`](../pi-plan-mode/src/state.ts#L85) — 第 85 行
- [function `latestCompletionPlan`](../pi-plan-mode/src/state.ts#L94) — 第 94 行
- [function `planCompletionSource`](../pi-plan-mode/src/state.ts#L106) — 第 106 行
- [function `fixedThinkingLevel`](../pi-plan-mode/src/state.ts#L112) — 第 112 行
- [function `stringArray`](../pi-plan-mode/src/state.ts#L120) — 第 120 行
- [function `isRecord`](../pi-plan-mode/src/state.ts#L126) — 第 126 行

### src/subagent-policy.ts

- [function `enforcePlanSubagentAllowlist`](../pi-plan-mode/src/subagent-policy.ts#L8) — 第 8 行
- [function `readSpawnRoleNames`](../pi-plan-mode/src/subagent-policy.ts#L35) — 第 35 行
- [function `readBlockingRoleNames`](../pi-plan-mode/src/subagent-policy.ts#L41) — 第 41 行
- [function `readRoleArray`](../pi-plan-mode/src/subagent-policy.ts#L70) — 第 70 行
- [function `readRoleName`](../pi-plan-mode/src/subagent-policy.ts#L82) — 第 82 行
- [function `isRecord`](../pi-plan-mode/src/subagent-policy.ts#L86) — 第 86 行
- [function `formatAllowedRoles`](../pi-plan-mode/src/subagent-policy.ts#L90) — 第 90 行
- [function `unique`](../pi-plan-mode/src/subagent-policy.ts#L96) — 第 96 行

### src/tool-policy.ts

- [function `isBuiltinTool`](../pi-plan-mode/src/tool-policy.ts#L104) — 第 104 行
- [function `classifyPlanModeTool`](../pi-plan-mode/src/tool-policy.ts#L108) — 第 108 行
- [function `canSelectToolInPlanMode`](../pi-plan-mode/src/tool-policy.ts#L115) — 第 115 行
- [function `readCommand`](../pi-plan-mode/src/tool-policy.ts#L119) — 第 119 行
- [function `isSafeCommand`](../pi-plan-mode/src/tool-policy.ts#L124) — 第 124 行
- [function `splitShellSegments`](../pi-plan-mode/src/tool-policy.ts#L133) — 第 133 行
- [function `isSafeSegment`](../pi-plan-mode/src/tool-policy.ts#L186) — 第 186 行
- [function `hasShellExpansion`](../pi-plan-mode/src/tool-policy.ts#L200) — 第 200 行
- [function `shellWords`](../pi-plan-mode/src/tool-policy.ts#L226) — 第 226 行
- [function `hasSafeArguments`](../pi-plan-mode/src/tool-policy.ts#L257) — 第 257 行
- [callback `allowReadOnlyArguments`](../pi-plan-mode/src/tool-policy.ts#L344) — 第 344 行
- [function `isSafeStructuredCommand`](../pi-plan-mode/src/tool-policy.ts#L370) — 第 370 行
- [function `isSafeGitCommand`](../pi-plan-mode/src/tool-policy.ts#L424) — 第 424 行
- [function `hasSafeGitArguments`](../pi-plan-mode/src/tool-policy.ts#L445) — 第 445 行
- [function `isSafeGitCatFileArguments`](../pi-plan-mode/src/tool-policy.ts#L465) — 第 465 行
- [function `isSafeGitGrepArguments`](../pi-plan-mode/src/tool-policy.ts#L473) — 第 473 行
- [function `matchesLongOptionPrefix`](../pi-plan-mode/src/tool-policy.ts#L482) — 第 482 行
- [function `isSafeGitDiffArguments`](../pi-plan-mode/src/tool-policy.ts#L487) — 第 487 行
- [function `isSafeGitLogArguments`](../pi-plan-mode/src/tool-policy.ts#L493) — 第 493 行
- [function `requiresTextconvGuardForGitLog`](../pi-plan-mode/src/tool-policy.ts#L498) — 第 498 行
- [function `requiresNoTextconv`](../pi-plan-mode/src/tool-policy.ts#L520) — 第 520 行
- [function `isSafeGitBranchArguments`](../pi-plan-mode/src/tool-policy.ts#L524) — 第 524 行
- [function `isSafeGitRemoteArguments`](../pi-plan-mode/src/tool-policy.ts#L539) — 第 539 行
- [function `isSafeGhCommand`](../pi-plan-mode/src/tool-policy.ts#L552) — 第 552 行
- [function `isSafeGhReadArguments`](../pi-plan-mode/src/tool-policy.ts#L562) — 第 562 行
- [function `isUnsafeGhReadArgument`](../pi-plan-mode/src/tool-policy.ts#L566) — 第 566 行
- [function `hasGhJsonOutput`](../pi-plan-mode/src/tool-policy.ts#L581) — 第 581 行

## pi-statusline

### src/ansi.ts

- [function `ansiStyle`](../pi-statusline/src/ansi.ts#L1) — 第 1 行
- [function `ansiFg`](../pi-statusline/src/ansi.ts#L10) — 第 10 行
- [function `truecolorCode`](../pi-statusline/src/ansi.ts#L14) — 第 14 行
- [function `hexToRgb`](../pi-statusline/src/ansi.ts#L19) — 第 19 行

### src/commands.ts

- [function `registerStatuslineCommand`](../pi-statusline/src/commands.ts#L22) — 第 22 行
- [method `getArgumentCompletions`](../pi-statusline/src/commands.ts#L25) — 第 25 行
- [function `editSettings`](../pi-statusline/src/commands.ts#L51) — 第 51 行
- [function `showStatus`](../pi-statusline/src/commands.ts#L75) — 第 75 行
- [function `showHelp`](../pi-statusline/src/commands.ts#L96) — 第 96 行
- [function `canNotify`](../pi-statusline/src/commands.ts#L112) — 第 112 行
- [function `formatError`](../pi-statusline/src/commands.ts#L116) — 第 116 行

### src/extension-status.ts

- [function `extensionStatusSeparator`](../pi-statusline/src/extension-status.ts#L18) — 第 18 行
- [function `formatExtensionStatuses`](../pi-statusline/src/extension-status.ts#L22) — 第 22 行
- [function `formatExtensionStatus`](../pi-statusline/src/extension-status.ts#L44) — 第 44 行
- [function `extensionStatusIcon`](../pi-statusline/src/extension-status.ts#L65) — 第 65 行
- [function `extensionStatusAliasesForKey`](../pi-statusline/src/extension-status.ts#L78) — 第 78 行
- [function `statusKeyMatchesStatusBase`](../pi-statusline/src/extension-status.ts#L88) — 第 88 行
- [function `wrapExtensionStatusline`](../pi-statusline/src/extension-status.ts#L92) — 第 92 行
- [function `formatDuplicateExtensionStatus`](../pi-statusline/src/extension-status.ts#L97) — 第 97 行
- [function `splitExtensionStatusIcon`](../pi-statusline/src/extension-status.ts#L105) — 第 105 行
- [function `isEmojiOnlyToken`](../pi-statusline/src/extension-status.ts#L114) — 第 114 行
- [function `extensionColor`](../pi-statusline/src/extension-status.ts#L120) — 第 120 行
- [function `stripExtensionStatusPrefix`](../pi-statusline/src/extension-status.ts#L128) — 第 128 行
- [function `simplifyExtensionStatusText`](../pi-statusline/src/extension-status.ts#L132) — 第 132 行
- [function `escapeRegExp`](../pi-statusline/src/extension-status.ts#L142) — 第 142 行
- [function `readInstalledExtensionPackages`](../pi-statusline/src/extension-status.ts#L152) — 第 152 行
- [function `extensionSettingsFiles`](../pi-statusline/src/extension-status.ts#L170) — 第 170 行
- [function `findDuplicateExtensions`](../pi-statusline/src/extension-status.ts#L177) — 第 177 行
- [function `buildExtensionStatusIconAliases`](../pi-statusline/src/extension-status.ts#L193) — 第 193 行
- [function `extensionStatusIconAliasCandidate`](../pi-statusline/src/extension-status.ts#L222) — 第 222 行
- [function `packageBaseName`](../pi-statusline/src/extension-status.ts#L237) — 第 237 行
- [function `statusBaseFromPackageBase`](../pi-statusline/src/extension-status.ts#L242) — 第 242 行
- [function `uniqueStrings`](../pi-statusline/src/extension-status.ts#L248) — 第 248 行
- [function `readPackageSources`](../pi-statusline/src/extension-status.ts#L252) — 第 252 行
- [function `packageNameForSource`](../pi-statusline/src/extension-status.ts#L273) — 第 273 行
- [function `npmPackageName`](../pi-statusline/src/extension-status.ts#L284) — 第 284 行
- [function `sourceIdentity`](../pi-statusline/src/extension-status.ts#L290) — 第 290 行
- [function `resolveSourcePath`](../pi-statusline/src/extension-status.ts#L295) — 第 295 行

### src/git-status.ts

- [function `readGitStatus`](../pi-statusline/src/git-status.ts#L14) — 第 14 行
- [function `parseGitStatusPorcelain`](../pi-statusline/src/git-status.ts#L27) — 第 27 行
- [function `isConflictStatus`](../pi-statusline/src/git-status.ts#L61) — 第 61 行
- [function `isChangedStatus`](../pi-statusline/src/git-status.ts#L70) — 第 70 行
- [function `formatGitStatusSummary`](../pi-statusline/src/git-status.ts#L74) — 第 74 行
- [function `formatGitBranchValue`](../pi-statusline/src/git-status.ts#L90) — 第 90 行
- [function `formatGitBranchText`](../pi-statusline/src/git-status.ts#L100) — 第 100 行
- [function `gitStatusSummaryEqual`](../pi-statusline/src/git-status.ts#L108) — 第 108 行
- [function `formatCount`](../pi-statusline/src/git-status.ts#L123) — 第 123 行

### src/index.ts

- 无具名函数定义（仅 re-export、类型或常量）。

### src/render.ts

- [function `renderStatusline`](../pi-statusline/src/render.ts#L43) — 第 43 行
- [function `renderExtensionStatusline`](../pi-statusline/src/render.ts#L68) — 第 68 行
- [function `buildSegment`](../pi-statusline/src/render.ts#L89) — 第 89 行
- [function `segment`](../pi-statusline/src/render.ts#L159) — 第 159 行
- [function `formatConfiguredSegment`](../pi-statusline/src/render.ts#L170) — 第 170 行
- [function `thinkingColor`](../pi-statusline/src/render.ts#L179) — 第 179 行
- [function `contextColor`](../pi-statusline/src/render.ts#L200) — 第 200 行
- [function `formatToolActivity`](../pi-statusline/src/render.ts#L207) — 第 207 行
- [function `prLinkFromStatuses`](../pi-statusline/src/render.ts#L220) — 第 220 行
- [function `prContextFromStatuses`](../pi-statusline/src/render.ts#L233) — 第 233 行
- [function `compactPrState`](../pi-statusline/src/render.ts#L242) — 第 242 行
- [function `getTokenTotals`](../pi-statusline/src/render.ts#L260) — 第 260 行
- [function `formatCount`](../pi-statusline/src/render.ts#L282) — 第 282 行
- [function `formatTime`](../pi-statusline/src/render.ts#L288) — 第 288 行
- [function `shortenModel`](../pi-statusline/src/render.ts#L295) — 第 295 行

### src/settings.ts

- [function `settingsFilePath`](../pi-statusline/src/settings.ts#L111) — 第 111 行
- [function `createDefaultConfig`](../pi-statusline/src/settings.ts#L115) — 第 115 行
- [function `normalizeStatuslineConfig`](../pi-statusline/src/settings.ts#L119) — 第 119 行
- [function `loadStatuslineSettings`](../pi-statusline/src/settings.ts#L247) — 第 247 行
- [function `loadOrCreateStatuslineSettings`](../pi-statusline/src/settings.ts#L281) — 第 281 行
- [function `createInitialSettings`](../pi-statusline/src/settings.ts#L298) — 第 298 行
- [function `migrateLegacySettings`](../pi-statusline/src/settings.ts#L326) — 第 326 行
- [function `saveStatuslineSettingsDocument`](../pi-statusline/src/settings.ts#L365) — 第 365 行
- [function `consumeStatuslineSettingsNotice`](../pi-statusline/src/settings.ts#L400) — 第 400 行
- [function `readStatuslineSettings`](../pi-statusline/src/settings.ts#L406) — 第 406 行
- [function `normalizeStatuslineSettings`](../pi-statusline/src/settings.ts#L412) — 第 412 行
- [function `normalizeEnum`](../pi-statusline/src/settings.ts#L416) — 第 416 行
- [function `cloneConfig`](../pi-statusline/src/settings.ts#L437) — 第 437 行
- [function `builtInSettings`](../pi-statusline/src/settings.ts#L448) — 第 448 行
- [function `hasControlCharacter`](../pi-statusline/src/settings.ts#L460) — 第 460 行
- [function `isRecord`](../pi-statusline/src/settings.ts#L468) — 第 468 行
- [function `isConfigSegmentName`](../pi-statusline/src/settings.ts#L472) — 第 472 行
- [function `isSegmentName`](../pi-statusline/src/settings.ts#L476) — 第 476 行
- [function `blockingDiagnostics`](../pi-statusline/src/settings.ts#L480) — 第 480 行
- [function `unknownDiagnostic`](../pi-statusline/src/settings.ts#L486) — 第 486 行
- [function `invalidDiagnostic`](../pi-statusline/src/settings.ts#L490) — 第 490 行
- [function `diagnostic`](../pi-statusline/src/settings.ts#L498) — 第 498 行
- [function `temporarySettingsPath`](../pi-statusline/src/settings.ts#L507) — 第 507 行
- [function `removeTemporaryFile`](../pi-statusline/src/settings.ts#L511) — 第 511 行
- [function `installFileExclusively`](../pi-statusline/src/settings.ts#L521) — 第 521 行
- [function `removeFileIfIdentityMatches`](../pi-statusline/src/settings.ts#L534) — 第 534 行
- [function `fileContentsEqual`](../pi-statusline/src/settings.ts#L550) — 第 550 行
- [function `pathExists`](../pi-statusline/src/settings.ts#L558) — 第 558 行
- [function `isAlreadyExistsError`](../pi-statusline/src/settings.ts#L567) — 第 567 行
- [function `formatError`](../pi-statusline/src/settings.ts#L571) — 第 571 行

### src/statusline.ts

- [function `statusline`](../pi-statusline/src/statusline.ts#L28) — 第 28 行
- [callback `refresh`](../pi-statusline/src/statusline.ts#L46) — 第 46 行
- [callback `setGitStatus`](../pi-statusline/src/statusline.ts#L48) — 第 48 行
- [callback `clearGitStatusDebounce`](../pi-statusline/src/statusline.ts#L54) — 第 54 行
- [callback `isActiveGitStatusTarget`](../pi-statusline/src/statusline.ts#L60) — 第 60 行
- [callback `isCurrentGitStatusRequest`](../pi-statusline/src/statusline.ts#L65) — 第 65 行
- [callback `runGitStatusRefresh`](../pi-statusline/src/statusline.ts#L68) — 第 68 行
- [callback `refreshGitStatus`](../pi-statusline/src/statusline.ts#L91) — 第 91 行
- [callback `scheduleGitStatusRefresh`](../pi-statusline/src/statusline.ts#L96) — 第 96 行
- [callback `scheduleGitStatusRefreshForContext`](../pi-statusline/src/statusline.ts#L106) — 第 106 行
- [callback `installFooter`](../pi-statusline/src/statusline.ts#L111) — 第 111 行
- [callback `refreshFooterGitStatus`](../pi-statusline/src/statusline.ts#L127) — 第 127 行
- [method `dispose`](../pi-statusline/src/statusline.ts#L141) — 第 141 行
- [method `invalidate`](../pi-statusline/src/statusline.ts#L154) — 第 154 行
- [method `render`](../pi-statusline/src/statusline.ts#L155) — 第 155 行
- [method `apply`](../pi-statusline/src/statusline.ts#L175) — 第 175 行
- [function `formatSettingsDiagnostics`](../pi-statusline/src/statusline.ts#L257) — 第 257 行

### src/tokyo-night.ts

- [function `renderTokyoNightStatusline`](../pi-statusline/src/tokyo-night.ts#L64) — 第 64 行
- [function `splitLines`](../pi-statusline/src/tokyo-night.ts#L79) — 第 79 行
- [function `tokyoNightExtensionSeparator`](../pi-statusline/src/tokyo-night.ts#L88) — 第 88 行
- [function `joinTokyoNightSegments`](../pi-statusline/src/tokyo-night.ts#L95) — 第 95 行
- [function `contiguousBlocks`](../pi-statusline/src/tokyo-night.ts#L115) — 第 115 行
- [function `formatBlockText`](../pi-statusline/src/tokyo-night.ts#L125) — 第 125 行
- [function `formatSegmentText`](../pi-statusline/src/tokyo-night.ts#L136) — 第 136 行
- [function `separatorText`](../pi-statusline/src/tokyo-night.ts#L140) — 第 140 行
- [function `resolvePalette`](../pi-statusline/src/tokyo-night.ts#L156) — 第 156 行
- [function `contrastColor`](../pi-statusline/src/tokyo-night.ts#L174) — 第 174 行

### src/types.ts

- 无具名函数定义（仅 re-export、类型或常量）。

## pi-subagents

### src/agents.ts

- [function `isThinkingLevel`](../pi-subagents/src/agents.ts#L21) — 第 21 行
- [function `workerSystemPrompt`](../pi-subagents/src/agents.ts#L133) — 第 133 行
- [function `loadAgentsFromDir`](../pi-subagents/src/agents.ts#L146) — 第 146 行
- [function `isDirectory`](../pi-subagents/src/agents.ts#L198) — 第 198 行
- [function `findNearestProjectAgentsDir`](../pi-subagents/src/agents.ts#L206) — 第 206 行
- [function `hasOwn`](../pi-subagents/src/agents.ts#L218) — 第 218 行
- [function `discoverAgents`](../pi-subagents/src/agents.ts#L222) — 第 222 行
- [function `formatAgentList`](../pi-subagents/src/agents.ts#L272) — 第 272 行

### src/config-ui.ts

- [class `ToolToggleList`](../pi-subagents/src/config-ui.ts#L43) — 第 43 行
- [method `constructor`](../pi-subagents/src/config-ui.ts#L51) — 第 51 行
- [method `getSelectedNames`](../pi-subagents/src/config-ui.ts#L59) — 第 59 行
- [method `handleInput`](../pi-subagents/src/config-ui.ts#L63) — 第 63 行
- [method `render`](../pi-subagents/src/config-ui.ts#L86) — 第 86 行
- [method `invalidate`](../pi-subagents/src/config-ui.ts#L97) — 第 97 行
- [function `registerSubagentConfigCommand`](../pi-subagents/src/config-ui.ts#L103) — 第 103 行
- [function `showSubagentToolSettings`](../pi-subagents/src/config-ui.ts#L113) — 第 113 行
- [function `registerSubagentPrimaryCommand`](../pi-subagents/src/config-ui.ts#L298) — 第 298 行
- [method `getArgumentCompletions`](../pi-subagents/src/config-ui.ts#L301) — 第 301 行
- [method `handler`](../pi-subagents/src/config-ui.ts#L306) — 第 306 行
- [function `showSubagentManager`](../pi-subagents/src/config-ui.ts#L331) — 第 331 行
- [function `selectManagerAction`](../pi-subagents/src/config-ui.ts#L363) — 第 363 行
- [method `handleInput`](../pi-subagents/src/config-ui.ts#L410) — 第 410 行
- [function `showCurrentSessionAgents`](../pi-subagents/src/config-ui.ts#L418) — 第 418 行
- [method `handleInput`](../pi-subagents/src/config-ui.ts#L472) — 第 472 行
- [function `showSubagentSettings`](../pi-subagents/src/config-ui.ts#L493) — 第 493 行
- [method `handleInput`](../pi-subagents/src/config-ui.ts#L565) — 第 565 行
- [function `showSubagentStatus`](../pi-subagents/src/config-ui.ts#L573) — 第 573 行
- [function `showSubagentHelp`](../pi-subagents/src/config-ui.ts#L582) — 第 582 行
- [function `formatManagerSummary`](../pi-subagents/src/config-ui.ts#L602) — 第 602 行
- [function `formatStatus`](../pi-subagents/src/config-ui.ts#L620) — 第 620 行
- [function `formatEmptyRuntime`](../pi-subagents/src/config-ui.ts#L641) — 第 641 行
- [function `safeTerminalText`](../pi-subagents/src/config-ui.ts#L647) — 第 647 行
- [function `formatError`](../pi-subagents/src/config-ui.ts#L652) — 第 652 行

### src/context.ts

- [function `textParts`](../pi-subagents/src/context.ts#L17) — 第 17 行
- [function `redactPrivateText`](../pi-subagents/src/context.ts#L33) — 第 33 行
- [function `buildContextSnapshot`](../pi-subagents/src/context.ts#L59) — 第 59 行

### src/execution.ts

- [function `parsePositiveInteger`](../pi-subagents/src/execution.ts#L30) — 第 30 行
- [function `resolveDefaultSubagentTimeoutMs`](../pi-subagents/src/execution.ts#L36) — 第 36 行
- [function `assertSubagentDepthAllowed`](../pi-subagents/src/execution.ts#L40) — 第 40 行
- [function `startSubagentStatus`](../pi-subagents/src/execution.ts#L52) — 第 52 行
- [callback `update`](../pi-subagents/src/execution.ts#L55) — 第 55 行
- [method `clear`](../pi-subagents/src/execution.ts#L65) — 第 65 行
- [function `publishSubagentStatus`](../pi-subagents/src/execution.ts#L74) — 第 74 行
- [function `singleStatus`](../pi-subagents/src/execution.ts#L85) — 第 85 行
- [function `chainStatus`](../pi-subagents/src/execution.ts#L89) — 第 89 行
- [function `parallelStatus`](../pi-subagents/src/execution.ts#L93) — 第 93 行
- [function `fanInStatus`](../pi-subagents/src/execution.ts#L97) — 第 97 行
- [function `executeSubagent`](../pi-subagents/src/execution.ts#L101) — 第 101 行
- [callback `resolveTimeoutMs`](../pi-subagents/src/execution.ts#L114) — 第 114 行
- [callback `resolveThinkingLevel`](../pi-subagents/src/execution.ts#L119) — 第 119 行
- [callback `makeDetails`](../pi-subagents/src/execution.ts#L127) — 第 127 行
- [callback `emitParallelUpdate`](../pi-subagents/src/execution.ts#L286) — 第 286 行

### src/in-process-transport.ts

- [class `InProcessTransport`](../pi-subagents/src/in-process-transport.ts#L95) — 第 95 行
- [method `constructor`](../pi-subagents/src/in-process-transport.ts#L103) — 第 103 行
- [method `runTurn`](../pi-subagents/src/in-process-transport.ts#L115) — 第 115 行
- [method `release`](../pi-subagents/src/in-process-transport.ts#L193) — 第 193 行
- [method `shutdown`](../pi-subagents/src/in-process-transport.ts#L197) — 第 197 行
- [method `releaseById`](../pi-subagents/src/in-process-transport.ts#L211) — 第 211 行
- [method `getOrCreate`](../pi-subagents/src/in-process-transport.ts#L239) — 第 239 行
- [method `runPrompt`](../pi-subagents/src/in-process-transport.ts#L281) — 第 281 行
- [method `discardRecord`](../pi-subagents/src/in-process-transport.ts#L311) — 第 311 行
- [function `validateInProcessTools`](../pi-subagents/src/in-process-transport.ts#L322) — 第 322 行
- [function `createSdkChildSession`](../pi-subagents/src/in-process-transport.ts#L334) — 第 334 行
- [function `createChildModelRuntime`](../pi-subagents/src/in-process-transport.ts#L399) — 第 399 行
- [function `copyRegisteredProviders`](../pi-subagents/src/in-process-transport.ts#L420) — 第 420 行
- [function `resolveChildModel`](../pi-subagents/src/in-process-transport.ts#L435) — 第 435 行
- [function `parseModelRequest`](../pi-subagents/src/in-process-transport.ts#L459) — 第 459 行
- [function `resolveConfiguredModel`](../pi-subagents/src/in-process-transport.ts#L474) — 第 474 行
- [function `createInProcessResourceLoader`](../pi-subagents/src/in-process-transport.ts#L505) — 第 505 行
- [function `seedChildSessionManager`](../pi-subagents/src/in-process-transport.ts#L524) — 第 524 行
- [function `buildCurrentTurnPrompt`](../pi-subagents/src/in-process-transport.ts#L563) — 第 563 行
- [function `latestAssistant`](../pi-subagents/src/in-process-transport.ts#L578) — 第 578 行
- [function `eventMessage`](../pi-subagents/src/in-process-transport.ts#L597) — 第 597 行
- [function `assistantText`](../pi-subagents/src/in-process-transport.ts#L605) — 第 605 行
- [function `interruptedOutcome`](../pi-subagents/src/in-process-transport.ts#L623) — 第 623 行
- [function `inProcessPolicy`](../pi-subagents/src/in-process-transport.ts#L627) — 第 627 行
- [function `settleWithin`](../pi-subagents/src/in-process-transport.ts#L642) — 第 642 行
- [function `completesWithin`](../pi-subagents/src/in-process-transport.ts#L649) — 第 649 行
- [function `errorMessage`](../pi-subagents/src/in-process-transport.ts#L663) — 第 663 行

### src/index.ts

- 无具名函数定义（仅 re-export、类型或常量）。

### src/limits.ts

- [function `normalizeByteLimit`](../pi-subagents/src/limits.ts#L14) — 第 14 行
- [function `truncateUtf8`](../pi-subagents/src/limits.ts#L20) — 第 20 行
- [function `truncateUtf8Tail`](../pi-subagents/src/limits.ts#L38) — 第 38 行
- [function `appendBounded`](../pi-subagents/src/limits.ts#L60) — 第 60 行

### src/params.ts

- 无具名函数定义（仅 re-export、类型或常量）。

### src/persistence.ts

- [class `AgentPersistence`](../pi-subagents/src/persistence.ts#L24) — 第 24 行
- [method `constructor`](../pi-subagents/src/persistence.ts#L29) — 第 29 行
- [method `load`](../pi-subagents/src/persistence.ts#L49) — 第 49 行
- [method `save`](../pi-subagents/src/persistence.ts#L67) — 第 67 行
- [method `delete`](../pi-subagents/src/persistence.ts#L88) — 第 88 行
- [method `quarantine`](../pi-subagents/src/persistence.ts#L94) — 第 94 行
- [function `selectAgentsForPersistence`](../pi-subagents/src/persistence.ts#L103) — 第 103 行
- [function `sanitizeAgent`](../pi-subagents/src/persistence.ts#L127) — 第 127 行
- [function `isStoredState`](../pi-subagents/src/persistence.ts#L151) — 第 151 行
- [function `isAgentTurn`](../pi-subagents/src/persistence.ts#L181) — 第 181 行
- [function `isMailboxMessage`](../pi-subagents/src/persistence.ts#L196) — 第 196 行

### src/protocol.ts

- [class `JsonLineDecoder`](../pi-subagents/src/protocol.ts#L13) — 第 13 行
- [method `constructor`](../pi-subagents/src/protocol.ts#L19) — 第 19 行
- [method `push`](../pi-subagents/src/protocol.ts#L27) — 第 27 行
- [method `finish`](../pi-subagents/src/protocol.ts#L32) — 第 32 行
- [method `drain`](../pi-subagents/src/protocol.ts#L39) — 第 39 行
- [method `processLine`](../pi-subagents/src/protocol.ts#L63) — 第 63 行

### src/registry.ts

- [function `positiveInteger`](../pi-subagents/src/registry.ts#L90) — 第 90 行
- [function `nonNegativeInteger`](../pi-subagents/src/registry.ts#L97) — 第 97 行
- [function `waitAbortError`](../pi-subagents/src/registry.ts#L104) — 第 104 行
- [class `AgentRegistry`](../pi-subagents/src/registry.ts#L110) — 第 110 行
- [method `constructor`](../pi-subagents/src/registry.ts#L133) — 第 133 行
- [method `restore`](../pi-subagents/src/registry.ts#L166) — 第 166 行
- [method `spawn`](../pi-subagents/src/registry.ts#L213) — 第 213 行
- [method `followUp`](../pi-subagents/src/registry.ts#L277) — 第 277 行
- [method `sendMessage`](../pi-subagents/src/registry.ts#L292) — 第 292 行
- [method `readMessages`](../pi-subagents/src/registry.ts#L318) — 第 318 行
- [method `wait`](../pi-subagents/src/registry.ts#L336) — 第 336 行
- [method `interruptTree`](../pi-subagents/src/registry.ts#L366) — 第 366 行
- [method `interrupt`](../pi-subagents/src/registry.ts#L377) — 第 377 行
- [method `closeTree`](../pi-subagents/src/registry.ts#L407) — 第 407 行
- [method `close`](../pi-subagents/src/registry.ts#L427) — 第 427 行
- [method `closeAll`](../pi-subagents/src/registry.ts#L463) — 第 463 行
- [method `shutdown`](../pi-subagents/src/registry.ts#L476) — 第 476 行
- [method `list`](../pi-subagents/src/registry.ts#L503) — 第 503 行
- [method `get`](../pi-subagents/src/registry.ts#L511) — 第 511 行
- [method `sweepExpired`](../pi-subagents/src/registry.ts#L516) — 第 516 行
- [method `startTurn`](../pi-subagents/src/registry.ts#L529) — 第 529 行
- [method `pumpQueue`](../pi-subagents/src/registry.ts#L544) — 第 544 行
- [method `runQueuedTurn`](../pi-subagents/src/registry.ts#L552) — 第 552 行
- [method `enqueueMessage`](../pi-subagents/src/registry.ts#L637) — 第 637 行
- [method `descendants`](../pi-subagents/src/registry.ts#L664) — 第 664 行
- [callback `visit`](../pi-subagents/src/registry.ts#L667) — 第 667 行
- [method `require`](../pi-subagents/src/registry.ts#L678) — 第 678 行
- [method `retainedCount`](../pi-subagents/src/registry.ts#L684) — 第 684 行
- [method `evictExpired`](../pi-subagents/src/registry.ts#L688) — 第 688 行
- [method `releaseAgents`](../pi-subagents/src/registry.ts#L714) — 第 714 行
- [method `pruneClosedAgents`](../pi-subagents/src/registry.ts#L730) — 第 730 行
- [method `notifyTurnComplete`](../pi-subagents/src/registry.ts#L737) — 第 737 行
- [method `changed`](../pi-subagents/src/registry.ts#L745) — 第 745 行
- [method `copy`](../pi-subagents/src/registry.ts#L758) — 第 758 行

### src/render.ts

- [function `formatTokens`](../pi-subagents/src/render.ts#L22) — 第 22 行
- [function `formatUsageStats`](../pi-subagents/src/render.ts#L29) — 第 29 行
- [function `formatResultUsageStats`](../pi-subagents/src/render.ts#L62) — 第 62 行
- [function `formatToolCall`](../pi-subagents/src/render.ts#L72) — 第 72 行
- [callback `shortenPath`](../pi-subagents/src/render.ts#L77) — 第 77 行
- [function `getDisplayItems`](../pi-subagents/src/render.ts#L148) — 第 148 行
- [function `getCollapsedDisplayItems`](../pi-subagents/src/render.ts#L164) — 第 164 行
- [function `renderSubagentCall`](../pi-subagents/src/render.ts#L175) — 第 175 行
- [function `renderSubagentResult`](../pi-subagents/src/render.ts#L235) — 第 235 行
- [callback `renderDisplayItems`](../pi-subagents/src/render.ts#L248) — 第 248 行
- [callback `aggregateUsage`](../pi-subagents/src/render.ts#L332) — 第 332 行
- [callback `resultIsRunning`](../pi-subagents/src/render.ts#L458) — 第 458 行

### src/runner.ts

- [function `getFinalOutput`](../pi-subagents/src/runner.ts#L77) — 第 77 行
- [function `getResultFinalOutput`](../pi-subagents/src/runner.ts#L91) — 第 91 行
- [function `isResultError`](../pi-subagents/src/runner.ts#L95) — 第 95 行
- [function `formatResultFailure`](../pi-subagents/src/runner.ts#L105) — 第 105 行
- [function `boundMessageText`](../pi-subagents/src/runner.ts#L113) — 第 113 行
- [callback `bounded`](../pi-subagents/src/runner.ts#L127) — 第 127 行
- [callback `fits`](../pi-subagents/src/runner.ts#L128) — 第 128 行
- [callback `addText`](../pi-subagents/src/runner.ts#L129) — 第 129 行
- [callback `addToolCall`](../pi-subagents/src/runner.ts#L149) — 第 149 行
- [function `compactRecentActivityArguments`](../pi-subagents/src/runner.ts#L186) — 第 186 行
- [function `appendRecentActivity`](../pi-subagents/src/runner.ts#L198) — 第 198 行
- [callback `append`](../pi-subagents/src/runner.ts#L200) — 第 200 行
- [function `buildFanInContext`](../pi-subagents/src/runner.ts#L227) — 第 227 行
- [function `mapWithConcurrencyLimit`](../pi-subagents/src/runner.ts#L252) — 第 252 行
- [function `writePromptToTempFile`](../pi-subagents/src/runner.ts#L278) — 第 278 行
- [function `buildPiArgs`](../pi-subagents/src/runner.ts#L291) — 第 291 行
- [function `getPiInvocation`](../pi-subagents/src/runner.ts#L310) — 第 310 行
- [function `signalProcess`](../pi-subagents/src/runner.ts#L326) — 第 326 行
- [function `terminateProcess`](../pi-subagents/src/runner.ts#L342) — 第 342 行
- [callback `onClose`](../pi-subagents/src/runner.ts#L351) — 第 351 行
- [function `runSingleAgent`](../pi-subagents/src/runner.ts#L368) — 第 368 行
- [callback `selectedAssistantOutput`](../pi-subagents/src/runner.ts#L435) — 第 435 行
- [callback `setErrorMessage`](../pi-subagents/src/runner.ts#L439) — 第 439 行
- [callback `emitUpdate`](../pi-subagents/src/runner.ts#L446) — 第 446 行
- [callback `finish`](../pi-subagents/src/runner.ts#L505) — 第 505 行
- [callback `addMessage`](../pi-subagents/src/runner.ts#L535) — 第 535 行
- [callback `processEvent`](../pi-subagents/src/runner.ts#L561) — 第 561 行

### src/settings.ts

- [function `hasOwn`](../pi-subagents/src/settings.ts#L14) — 第 14 行
- [function `isPlainObject`](../pi-subagents/src/settings.ts#L18) — 第 18 行
- [function `isStringArray`](../pi-subagents/src/settings.ts#L22) — 第 22 行
- [function `isPositiveNumber`](../pi-subagents/src/settings.ts#L26) — 第 26 行
- [function `isPositiveInteger`](../pi-subagents/src/settings.ts#L30) — 第 30 行
- [function `isNonNegativeInteger`](../pi-subagents/src/settings.ts#L34) — 第 34 行
- [function `normalizeAgentSettings`](../pi-subagents/src/settings.ts#L38) — 第 38 行
- [function `normalizeSubagentSettings`](../pi-subagents/src/settings.ts#L71) — 第 71 行
- [function `readSubagentSettings`](../pi-subagents/src/settings.ts#L137) — 第 137 行
- [function `installFileExclusively`](../pi-subagents/src/settings.ts#L194) — 第 194 行
- [function `removeFileIfIdentityMatches`](../pi-subagents/src/settings.ts#L210) — 第 210 行
- [function `fileContentsEqual`](../pi-subagents/src/settings.ts#L226) — 第 226 行
- [function `consumeSubagentSettingsNotice`](../pi-subagents/src/settings.ts#L234) — 第 234 行
- [function `saveSubagentConfig`](../pi-subagents/src/settings.ts#L240) — 第 240 行
- [function `subagentSettingsFilePath`](../pi-subagents/src/settings.ts#L251) — 第 251 行
- [function `inspectCompletionDeliverySettings`](../pi-subagents/src/settings.ts#L255) — 第 255 行
- [function `updateCompletionDeliverySetting`](../pi-subagents/src/settings.ts#L281) — 第 281 行
- [function `updateAgentToolsSetting`](../pi-subagents/src/settings.ts#L296) — 第 296 行
- [function `readSettingsObjectForUpdate`](../pi-subagents/src/settings.ts#L327) — 第 327 行
- [function `writeSettingsObject`](../pi-subagents/src/settings.ts#L342) — 第 342 行
- [function `readSettingsFile`](../pi-subagents/src/settings.ts#L362) — 第 362 行
- [function `readSettingsSnapshot`](../pi-subagents/src/settings.ts#L366) — 第 366 行
- [function `formatError`](../pi-subagents/src/settings.ts#L378) — 第 378 行
- [function `uniqueToolNames`](../pi-subagents/src/settings.ts#L382) — 第 382 行
- [function `sameToolSet`](../pi-subagents/src/settings.ts#L386) — 第 386 行
- [function `resolveSubagentThinkingLevel`](../pi-subagents/src/settings.ts#L393) — 第 393 行
- [function `hasAnyAgentOverride`](../pi-subagents/src/settings.ts#L406) — 第 406 行

### src/stateful-prompt.ts

- [function `buildStatefulTurnPrompt`](../pi-subagents/src/stateful-prompt.ts#L7) — 第 7 行
- [function `resolveStatefulTurnTimeout`](../pi-subagents/src/stateful-prompt.ts#L39) — 第 39 行

### src/stateful-tool-params.ts

- [function `validateManageParams`](../pi-subagents/src/stateful-tool-params.ts#L74) — 第 74 行
- [function `validateMailboxParams`](../pi-subagents/src/stateful-tool-params.ts#L94) — 第 94 行
- [function `parameterRecord`](../pi-subagents/src/stateful-tool-params.ts#L148) — 第 148 行
- [function `assertOnlyActionKeys`](../pi-subagents/src/stateful-tool-params.ts#L155) — 第 155 行
- [function `assertRequiredString`](../pi-subagents/src/stateful-tool-params.ts#L169) — 第 169 行
- [function `assertOptionalString`](../pi-subagents/src/stateful-tool-params.ts#L182) — 第 182 行
- [function `assertOptionalBoolean`](../pi-subagents/src/stateful-tool-params.ts#L193) — 第 193 行

### src/stateful.ts

- [function `createSpawnPromptGuidelines`](../pi-subagents/src/stateful.ts#L55) — 第 55 行
- [function `registerStatefulSubagents`](../pi-subagents/src/stateful.ts#L105) — 第 105 行
- [callback `clearAgents`](../pi-subagents/src/stateful.ts#L124) — 第 124 行
- [method `getCompletionDelivery`](../pi-subagents/src/stateful.ts#L139) — 第 139 行
- [method `setCompletionDelivery`](../pi-subagents/src/stateful.ts#L142) — 第 142 行
- [method `getRuntimeStatus`](../pi-subagents/src/stateful.ts#L147) — 第 147 行
- [method `listAgents`](../pi-subagents/src/stateful.ts#L160) — 第 160 行
- [callback `requireRegistry`](../pi-subagents/src/stateful.ts#L167) — 第 167 行
- [callback `requireAgent`](../pi-subagents/src/stateful.ts#L171) — 第 171 行
- [method `execute`](../pi-subagents/src/stateful.ts#L329) — 第 329 行
- [method `execute`](../pi-subagents/src/stateful.ts#L403) — 第 403 行
- [method `execute`](../pi-subagents/src/stateful.ts#L431) — 第 431 行
- [method `execute`](../pi-subagents/src/stateful.ts#L499) — 第 499 行
- [method `getArgumentCompletions`](../pi-subagents/src/stateful.ts#L536) — 第 536 行
- [method `handler`](../pi-subagents/src/stateful.ts#L541) — 第 541 行
- [function `assertNoSharedWriteConflict`](../pi-subagents/src/stateful.ts#L570) — 第 570 行
- [function `assertFollowUpWriteAllowed`](../pi-subagents/src/stateful.ts#L596) — 第 596 行
- [function `isWriteCapable`](../pi-subagents/src/stateful.ts#L606) — 第 606 行
- [function `confirmProjectAgent`](../pi-subagents/src/stateful.ts#L611) — 第 611 行
- [function `isSameCwd`](../pi-subagents/src/stateful.ts#L637) — 第 637 行
- [function `normalizeContextMode`](../pi-subagents/src/stateful.ts#L641) — 第 641 行
- [function `resolveSpawnContextMode`](../pi-subagents/src/stateful.ts#L647) — 第 647 行
- [function `statefulEmptyMessage`](../pi-subagents/src/stateful.ts#L655) — 第 655 行
- [function `formatStatefulAgentLine`](../pi-subagents/src/stateful.ts#L661) — 第 661 行
- [function `sanitizeStatusLine`](../pi-subagents/src/stateful.ts#L676) — 第 676 行
- [function `formatLine`](../pi-subagents/src/stateful.ts#L687) — 第 687 行
- [function `summarizeAgent`](../pi-subagents/src/stateful.ts#L691) — 第 691 行
- [class `CompletionDeliveryBroker`](../pi-subagents/src/stateful.ts#L744) — 第 744 行
- [method `constructor`](../pi-subagents/src/stateful.ts#L750) — 第 750 行
- [method `enqueue`](../pi-subagents/src/stateful.ts#L757) — 第 757 行
- [method `setDelivery`](../pi-subagents/src/stateful.ts#L763) — 第 763 行
- [method `onParentTurnStart`](../pi-subagents/src/stateful.ts#L768) — 第 768 行
- [method `onParentSettled`](../pi-subagents/src/stateful.ts#L773) — 第 773 行
- [method `flush`](../pi-subagents/src/stateful.ts#L778) — 第 778 行
- [method `close`](../pi-subagents/src/stateful.ts#L816) — 第 816 行
- [method `scheduleFlush`](../pi-subagents/src/stateful.ts#L823) — 第 823 行
- [method `isRootIdle`](../pi-subagents/src/stateful.ts#L831) — 第 831 行
- [method `shouldWakeRoot`](../pi-subagents/src/stateful.ts#L839) — 第 839 行
- [function `chunkCompletions`](../pi-subagents/src/stateful.ts#L849) — 第 849 行
- [function `buildCompletionMessage`](../pi-subagents/src/stateful.ts#L857) — 第 857 行
- [function `completionMetadata`](../pi-subagents/src/stateful.ts#L890) — 第 890 行
- [function `buildDetachedCompletionMessage`](../pi-subagents/src/stateful.ts#L898) — 第 898 行
- [function `sanitizeCompletionLine`](../pi-subagents/src/stateful.ts#L920) — 第 920 行
- [function `cleanupClosedWorkspaces`](../pi-subagents/src/stateful.ts#L930) — 第 930 行
- [function `result`](../pi-subagents/src/stateful.ts#L942) — 第 942 行
- [function `resolveStatefulTransportKind`](../pi-subagents/src/stateful.ts#L949) — 第 949 行
- [function `resolveCompletionDelivery`](../pi-subagents/src/stateful.ts#L955) — 第 955 行
- [function `normalizeRuntimeThinkingLevel`](../pi-subagents/src/stateful.ts#L961) — 第 961 行

### src/subagents.ts

- [method `execute`](../pi-subagents/src/subagents.ts#L49) — 第 49 行
- [method `renderCall`](../pi-subagents/src/subagents.ts#L53) — 第 53 行
- [method `renderResult`](../pi-subagents/src/subagents.ts#L57) — 第 57 行

### src/subprocess-transport.ts

- [function `resolveStatefulSubprocessThinkingLevel`](../pi-subagents/src/subprocess-transport.ts#L8) — 第 8 行
- [class `SubprocessTransport`](../pi-subagents/src/subprocess-transport.ts#L15) — 第 15 行
- [method `runTurn`](../pi-subagents/src/subprocess-transport.ts#L18) — 第 18 行
- [callback `makeDetails`](../pi-subagents/src/subprocess-transport.ts#L23) — 第 23 行

### src/transport.ts

- [class `FunctionTransport`](../pi-subagents/src/transport.ts#L16) — 第 16 行
- [method `constructor`](../pi-subagents/src/transport.ts#L19) — 第 19 行
- [method `runTurn`](../pi-subagents/src/transport.ts#L21) — 第 21 行
- [function `normalizeTransport`](../pi-subagents/src/transport.ts#L26) — 第 26 行

### src/workspace.ts

- [class `WorkspaceManager`](../pi-subagents/src/workspace.ts#L17) — 第 17 行
- [method `create`](../pi-subagents/src/workspace.ts#L20) — 第 20 行
- [method `cleanup`](../pi-subagents/src/workspace.ts#L73) — 第 73 行
- [method `cleanupAll`](../pi-subagents/src/workspace.ts#L95) — 第 95 行
- [method `isOwned`](../pi-subagents/src/workspace.ts#L108) — 第 108 行


