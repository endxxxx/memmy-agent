import { useCallback, useEffect, useRef, useState } from "react";
import type { InstalledPlugin } from "@memmy/local-api-contracts";
import { useApiClients } from "../app/providers.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentActions, appActions } from "../state/app-actions.js";
import { agentChatScopeKey } from "../state/agent-composer-state.js";
import { useAppState } from "../state/app-state.js";
import { officialPluginCatalog } from "./official-plugin-catalog.js";
import {
  addPluginCommandToDraft,
  PluginMarketplaceSection,
  pluginComposerCommand,
  type MarketplacePlugin
} from "./plugin-marketplace-section.js";
import { writeSettingsTabHash } from "./settings-nav.js";

/** Live marketplace: installed state is always read back from the plugin host. */
export function PluginMarketplace() {
  const { clients } = useApiClients();
  const { state, dispatch } = useAppState();
  const { language } = useTranslation();
  const en = language === "en-US";
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [officialModelReady, setOfficialModelReady] = useState<boolean | undefined>(undefined);
  const busy = useRef(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!clients) return;
    const current = ++generation.current;
    setLoading(true);
    setActionError(null);
    const [plugins, model] = await Promise.allSettled([
      clients.plugins.list(), clients.config.getModelConfig()
    ]);
    if (generation.current !== current) return;
    if (plugins.status === "fulfilled") {
      setInstalled(plugins.value);
      setError(null);
    } else {
      setError(en ? "Could not load plugins. Please try again." : "插件列表加载失败，请重试。");
    }
    setModelError(model.status === "rejected"
      ? (en ? "Could not read model settings. Refresh to check availability." : "无法读取模型配置，请刷新后查看模型状态。") : null);
    setOfficialModelReady(model.status === "rejected" ? undefined : Boolean(state.account.userId)
      && Boolean(model.value.catalog?.effectiveCandidates.account.some((candidate) => (
        candidate.source === "account" && candidate.available && candidate.capabilities.includes("agent")
        && candidate.ownerAccountId === state.account.userId
      ))));
    setLoading(false);
  }, [clients, en, state.account.userId]);

  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh]);

  async function mutate(plugin: MarketplacePlugin, operation: () => Promise<unknown>) {
    if (!clients || loading || busy.current || error) return;
    busy.current = true;
    setBusyId(plugin.id);
    setActionError(null);
    let failed = false;
    try {
      try { await operation(); } catch { failed = true; }
      // Read back even after partial failure (e.g. installed but activation failed).
      await refresh();
      if (failed) {
        setActionError(en
          ? `Could not complete the action for ${plugin.name}. Please try again.`
          : `${plugin.name}操作未完成，请重试。`);
      }
    } finally {
      setBusyId(null);
      busy.current = false;
    }
  }

  async function activateOfficialPlugin(plugin: InstalledPlugin) {
    // Only this official catalog combines permission approval with installation.
    await clients!.plugins.approvePermissions(plugin.id, plugin.manifest.permissions);
    await clients!.plugins.enable(plugin.id);
  }

  const plugins = officialPluginCatalog({ language, installed });

  return <>
    {modelError && <p role="alert" className="mb-4 text-sm text-text-ink/60">{modelError}</p>}
    <PluginMarketplaceSection
    plugins={plugins}
    loading={loading}
    error={[error, actionError].filter(Boolean).join(" ") || null}
    busyId={busyId}
    actionsDisabled={!clients || Boolean(error)}
    officialModelReady={officialModelReady}
    signedIn={Boolean(state.account.userId)}
    onRefresh={() => void refresh()}
    onInstall={(plugin) => {
      if (!plugin.installable) return;
      void mutate(plugin, async () => {
        const installedPlugin = await clients!.plugins.install(plugin.id, plugin.version);
        await activateOfficialPlugin(installedPlugin);
      });
    }}
    onEnable={(plugin) => {
      const installedPlugin = plugin.installed;
      if (!installedPlugin) return;
      void mutate(plugin, () => activateOfficialPlugin(installedPlugin));
    }}
    onUninstall={(plugin) => void mutate(plugin, () => clients!.plugins.uninstall(plugin.id))}
    onAddToChat={(plugin) => {
      const command = pluginComposerCommand(plugin);
      if (command) {
        const scopeKey = agentChatScopeKey(state.agent.currentChatId, state.agent.newChatRequestId);
        dispatch(agentActions.composerDraftUpdated(
          scopeKey,
          addPluginCommandToDraft(command, state.agent.composerDraftsByScope[scopeKey] ?? "")
        ));
      }
      dispatch(appActions.navigate("/main"));
    }}
    onConfigureModel={() => {
      writeSettingsTabHash(state.account.userId ? "model" : "account");
      dispatch(appActions.navigate("/settings"));
    }}
    onSignIn={() => dispatch(appActions.navigate("/welcome"))}
    />
  </>;
}
