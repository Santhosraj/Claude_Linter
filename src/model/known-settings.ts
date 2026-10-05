/**
 * Top-level settings keys Claude Code is known to accept.
 *
 * Used for one thing: telling a misspelt key from a real one. Claude Code
 * ignores an unknown top-level key without any warning — verified against the
 * binary, where `claude doctor` (2.1.250) flagged an unknown hook event in the
 * same file but said nothing about `totallyMadeUpKey123` — so `"modle": "opus"`
 * looks exactly like a model setting that simply did not work.
 *
 * WHY THIS IS NOT THE MERGE-SEMANTICS TABLE. That table answers a different
 * question (how a key merges across layers) and covers 32 rules. Using it as the
 * definition of "known" made every real key outside it "unrecognised":
 * `autoMemoryEnabled` and `modelSettings` in a real project were both reported.
 *
 * WHY THIS IS NOT TREATED AS COMPLETE. No source is. Measured on 2026-10-05:
 *   - SchemaStore (claude-code-settings.json) lists 142 keys, but not
 *     `modelSettings`, which code.claude.com/docs/en/settings documents.
 *   - Neither lists `switchModelsOnFlag`, which Claude Code itself writes into
 *     user settings (it is in the merge table instead).
 * So a key absent from here is NOT reported for being absent — only for being a
 * near-miss of one that is present. See suggestSettingsKey.
 *
 * Regenerate from https://json.schemastore.org/claude-code-settings.json and
 * keep the hand-added extras at the bottom of the source list.
 */
export const KNOWN_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "$schema", "advisorModel", "agent", "agentPushNotifEnabled", "allowAllClaudeAiMcps",
  "allowedChannelPlugins", "allowedHttpHookUrls", "allowedMcpServers",
  "allowManagedHooksOnly", "allowManagedMcpServersOnly",
  "allowManagedPermissionRulesOnly", "alwaysThinkingEnabled", "apiKeyHelper",
  "askUserQuestionTimeout", "attribution", "autoCompactEnabled", "autoConnectIde",
  "autoInstallIdeExtension", "autoMemoryDirectory", "autoMemoryEnabled", "autoMode",
  "autoScrollEnabled", "autoUpdatesChannel", "availableModels", "awaySummaryEnabled",
  "awsAuthRefresh", "awsCredentialExport", "axScreenReader", "blockedMarketplaces",
  "browserExternalPageTools", "channelsEnabled", "claudeMd", "claudeMdExcludes",
  "cleanupPeriodDays", "companyAnnouncements", "defaultShell", "deniedMcpServers",
  "diffTool", "disableAgentView", "disableAllHooks", "disableArtifact",
  "disableAutoMode", "disableBrowserExternalNavigation", "disableBundledSkills",
  "disableClaudeAiConnectors", "disableDeepLinkRegistration", "disabledMcpjsonServers",
  "disableMobileSimulatorTools", "disableRemoteControl", "disableSideloadFlags",
  "disableSkillShellExecution", "disableWorkflows", "editorMode", "effortLevel",
  "emojiCompletionEnabled", "enableAllProjectMcpServers", "enableArtifact",
  "enabledMcpjsonServers", "enabledPlugins", "enforceAvailableModels", "env",
  "externalEditorContext", "extraKnownMarketplaces", "fallbackModel", "fastMode",
  "fastModePerSessionOptIn", "feedbackSurveyRate", "fileCheckpointingEnabled",
  "fileSuggestion", "footerLinksRegexes", "forceLoginGatewayUrl", "forceLoginMethod",
  "forceLoginOrgUUID", "forceRemoteSettingsRefresh", "gcpAuthRefresh", "hooks",
  "httpHookAllowedEnvVars", "includeCoAuthoredBy", "includeGitInstructions",
  "inputNeededNotifEnabled", "language", "managedMcpServers", "minimumVersion",
  "model", "modelOverrides", "modelSettings", "otelHeadersHelper", "outputStyle",
  "parentSettingsBehavior", "permissionExplainerEnabled", "permissions",
  "plansDirectory", "pluginConfigs", "pluginSuggestionMarketplaces",
  "pluginTrustMessage", "policyHelper", "preferredNotifChannel",
  "prefersReducedMotion", "processWrapper", "prUrlTemplate", "remoteControlAtStartup",
  "requireCoworkFullVmSandbox", "requiredMaximumVersion", "requiredMinimumVersion",
  "respectGitignore", "respondToBashCommands", "sandbox",
  "showClearContextOnPlanAccept", "showThinkingSummaries", "showTurnDuration",
  "skillListingBudgetFraction", "skillListingMaxDescChars", "skillOverrides",
  "skipDangerousModePermissionPrompt", "skippedMarketplaces", "skippedPlugins",
  "skipWebFetchPreflight", "spinnerTipsEnabled", "spinnerTipsOverride", "spinnerVerbs",
  "sshConfigs", "sshHostAllowlist", "statusLine", "strictKnownMarketplaces",
  "strictPluginOnlyCustomization", "subagentStatusLine", "syntaxHighlightingDisabled",
  "teammateDefaultModel", "teammateMode", "terminalProgressBarEnabled", "theme", "tui",
  "useAutoModeDuringPlan", "verbose", "viewMode", "vimInsertModeRemaps", "voice",
  "voiceEnabled", "wheelScrollAccelerationEnabled", "workflowKeywordTriggerEnabled",
  "workflowSizeGuideline", "worktree", "wslInheritsWindowsSettings",
]);

/**
 * The known key a probable typo was meant to be, or `undefined` when the key is
 * not close to anything known.
 *
 * Returning nothing for a distant key is deliberate. A typo is, by definition,
 * near the key that was intended; a key far from every known one is far more
 * likely to be real and merely unlisted (Claude Code adds keys faster than any
 * list tracks them) than to be a slip of the fingers. Reporting those was the
 * false positive this replaces.
 *
 * Case-only differences always match, because JSON keys are case-sensitive and
 * `"Model": "opus"` is silently ignored. Otherwise the allowance is one edit for
 * short keys and two for longer ones — enough for a transposition or a dropped
 * letter, not enough to bridge two genuinely different keys.
 */
export function suggestSettingsKey(key: string, extra: Iterable<string> = []): string | undefined {
  const known = new Set([...KNOWN_SETTINGS_KEYS, ...extra]);
  if (known.has(key)) return undefined;

  const lower = key.toLowerCase();
  for (const k of known) if (k.toLowerCase() === lower) return k;

  const allowance = key.length <= 5 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const k of [...known].sort()) {
    // Cheap reject: lengths further apart than the allowance cannot match.
    if (Math.abs(k.length - key.length) > allowance) continue;
    const d = editDistance(lower, k.toLowerCase());
    if (d <= allowance && d < bestDistance) {
      best = k;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Optimal-string-alignment distance: Levenshtein plus adjacent transposition,
 * so "modle" is one edit from "model" rather than two.
 */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i]![0] = i;
  for (let j = 0; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}
