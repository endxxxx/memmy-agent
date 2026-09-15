import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, FileText, Loader2, LogIn, MessageSquare, MoreHorizontal, Plus, Puzzle, RefreshCw, Scale, Search, X } from "lucide-react";
import type { InstalledPlugin } from "@memmy/local-api-contracts";
import { Button } from "../components/button.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Modal } from "../components/modal.js";
import { Tooltip } from "../components/tooltip.js";
import { useTranslation } from "../i18n/use-translation.js";
import { PluginDetailPreview } from "./plugin-detail-preview.js";

export interface MarketplacePlugin {
  id: string;
  name: string;
  description: string;
  category: "legal" | "research" | "office" | "other";
  version?: string;
  defaultInstalled?: boolean;
  /** Declared by the plugin: needs a signed-in account to install/use. */
  requiresLogin?: boolean;
  /** Declared by the plugin: locked to the account-owned official model (implies login). */
  requiresOfficialModel?: boolean;
  installed?: InstalledPlugin;
  installable: boolean;
}

export interface PluginMarketplaceSectionProps {
  /** The parent supplies the catalog after applying account visibility rules. */
  plugins: MarketplacePlugin[];
  loading?: boolean;
  error?: string | null;
  busyId?: string | null;
  /** Temporarily block lifecycle mutations while keeping refresh available. */
  actionsDisabled?: boolean;
  onInstall(plugin: MarketplacePlugin): void;
  onUninstall(plugin: MarketplacePlugin): void;
  onEnable(plugin: MarketplacePlugin): void;
  onAddToChat(plugin: MarketplacePlugin): void;
  onConfigureModel(): void;
  onRefresh(): void;
  onSignIn?(): void;
  officialModelReady: boolean | undefined;
  /**
   * Account sign-in state, sourced from the server. Login is applied per plugin
   * (only plugins that declare it), never as a section-wide gate. Whitelist / beta
   * eligibility is applied upstream when the parent builds `plugins`, and will be
   * fed by the server through the same seam.
   */
  signedIn?: boolean;
}

/** Slash command inserted into the current chat composer for an active plugin. */
export function pluginComposerCommand(plugin: MarketplacePlugin): string | null {
  if (plugin.installed?.state !== "active") return null;
  return plugin.installed.manifest.commands?.[0]?.command ?? `/${plugin.id}`;
}

/** Prepends a plugin command without duplicating it or wiping the current draft. */
export function addPluginCommandToDraft(command: string, draft: string): string {
  const existing = draft.trim();
  if (!existing) return `${command}  `;
  const leading = existing.split(/\s/, 1)[0];
  if (leading === command) return existing === command ? `${command}  ` : draft;
  return `${command}  ${existing}`;
}

type PrimaryAction = "install" | "enable" | "configure" | "sign-in" | "unavailable" | null;

/** A plugin needs sign-in when it declares login (or an official model, which is account-owned) and the user is signed out. */
function pluginNeedsSignIn(plugin: MarketplacePlugin, signedIn: boolean): boolean {
  return !signedIn && Boolean(plugin.requiresLogin || plugin.requiresOfficialModel);
}

/** Catalog presentation only: installation state always comes from the parent. */
export function PluginMarketplaceSection(props: PluginMarketplaceSectionProps) {
  const { language } = useTranslation();
  const zh = language === "zh-CN";
  const copy = (chinese: string, english: string) => zh ? chinese : english;
  const [filter, setFilter] = useState<"all" | "installed">("all");
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [uninstallId, setUninstallId] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const installedCount = props.plugins.filter((plugin) => Boolean(plugin.installed)).length;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visiblePlugins = props.plugins.filter((plugin) => (
    (filter === "all" || plugin.installed)
    && `${plugin.name}\n${plugin.description}`.toLocaleLowerCase().includes(normalizedQuery)
  ));
  const detail = props.plugins.find((plugin) => plugin.id === detailId);
  const confirmedPlugin = props.plugins.find((plugin) => plugin.id === uninstallId);
  const busy = Boolean(props.busyId) || Boolean(props.loading);
  const actionsDisabled = busy || Boolean(props.actionsDisabled);
  const confirmationValid = Boolean(confirmedPlugin?.installed);
  const signedIn = props.signedIn !== false;

  useEffect(() => {
    if (!menuId) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-plugin-menu]")) setMenuId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuId(null);
        sectionRef.current?.querySelector<HTMLButtonElement>(`[data-menu-trigger="${CSS.escape(menuId)}"]`)?.focus();
      }
    };
    sectionRef.current?.querySelector<HTMLElement>("[role=menu] [role=menuitem]")?.focus();
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuId]);

  function requestUninstall(plugin: MarketplacePlugin) {
    if (actionsDisabled) return;
    setMenuId(null);
    setDetailId(null);
    setUninstallId(plugin.id);
  }

  function performPrimary(plugin: MarketplacePlugin) {
    if (busy) return;
    switch (primaryAction(plugin, signedIn, props.officialModelReady)) {
      case "install":
        if (actionsDisabled) return;
        setDetailId(null);
        props.onInstall(plugin);
        break;
      case "enable":
        if (actionsDisabled) return;
        setDetailId(null);
        props.onEnable(plugin);
        break;
      case "configure": setDetailId(null); props.onConfigureModel(); break;
      case "sign-in": setDetailId(null); props.onSignIn?.(); break;
    }
  }

  function addToChat(plugin: MarketplacePlugin) {
    if (plugin.installed?.state !== "active") return;
    setMenuId(null);
    setDetailId(null);
    props.onAddToChat(plugin);
  }

  function renderPrimary(plugin: MarketplacePlugin) {
    const action = primaryAction(plugin, signedIn, props.officialModelReady);
    if (!action) return null;
    const working = props.busyId === plugin.id || isTransitioning(plugin);
    const label = action === "unavailable" ? copy("即将上线", "Coming soon")
      : action === "install" ? copy("安装", "Install")
      : action === "configure" ? copy("配置官方模型", "Set up official model")
      : action === "sign-in" ? copy("去登录", "Sign in")
      : copy("重试安装", "Retry installation");
    // Sign-in and model setup are navigation, not lifecycle mutations, so they stay enabled while actions are disabled.
    const bypassesActionsDisabled = action === "configure" || action === "sign-in";
    return (
      <Button type="button" size="sm" variant={action === "unavailable" ? "secondary" : "primary"}
        aria-label={action === "install" ? copy(`安装${plugin.name}`, `Install ${plugin.name}`) : action === "enable" ? copy(`重试安装${plugin.name}`, `Retry installing ${plugin.name}`) : undefined}
        disabled={busy || working || action === "unavailable" || (!bypassesActionsDisabled && actionsDisabled)} onClick={() => performPrimary(plugin)}>
        {working ? <Loader2 size={13} className="mr-1.5 animate-spin" aria-hidden="true" /> : null}
        {working ? copy("处理中…", "Working…") : label}
      </Button>
    );
  }

  const status = (plugin: MarketplacePlugin) => {
    if (props.busyId === plugin.id || isTransitioning(plugin)) return copy("处理中", "Working");
    if (!plugin.installed) return pluginNeedsSignIn(plugin, signedIn) ? copy("需登录", "Sign in required") : copy("未安装", "Not installed");
    if (plugin.installed.state === "failed") return copy("安装失败", "Installation failed");
    if (plugin.installed.state !== "active") return copy("安装未完成", "Installation incomplete");
    if (pluginNeedsSignIn(plugin, signedIn)) return copy("已安装 · 需登录", "Installed · Sign in required");
    if (plugin.requiresOfficialModel && props.officialModelReady === undefined) return copy("暂未获取模型状态", "Model status unavailable");
    if (plugin.requiresOfficialModel && !props.officialModelReady) return copy("已安装 · 需配置模型", "Installed · Model setup required");
    return copy("已安装", "Installed");
  };

  return (
    <section ref={sectionRef} className="memory-panel plugin-marketplace-section" aria-label={copy("任务插件", "Task plugins")}>
      <div className="memory-panel__header">
        <div className="memory-panel__header-main">
          <h2 className="memory-panel__title">{copy("任务插件", "Task plugins")}</h2>
          <p className="memory-panel__subtitle">{copy("由 Memmy 提供和维护，围绕具体目标提供完整任务能力。", "Complete entire tasks with capabilities provided and maintained by Memmy.")}</p>
        </div>
        <button type="button" disabled={props.loading || busy} onClick={props.onRefresh}
          aria-label={copy("刷新", "Refresh")} title={copy("刷新", "Refresh")}
          className="memory-refresh-button">
          <RefreshCw size={15} className={props.loading ? "animate-spin" : ""} aria-hidden="true" />
        </button>
      </div>
      <div className="extension-catalog-toolbar">
        <div className="memory-log-filter-group" aria-label={copy("插件筛选", "Filter plugins")}>
          {(["all", "installed"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setMenuId(null); }}
              className={`memory-log-filter${filter === value ? " memory-log-filter--active" : ""}`}>
              {value === "all" ? copy("全部", "All") : `${copy("已安装", "Installed")} (${installedCount})`}
            </button>
          ))}
        </div>
        <label className="extension-catalog-search">
          <Search size={15} aria-hidden="true" />
          <input type="search" value={query}
            aria-label={copy("搜索任务插件", "Search task plugins")} placeholder={copy("搜索任务插件", "Search task plugins")}
            onChange={(event) => { setQuery(event.target.value); setMenuId(null); }} />
        </label>
      </div>

      {props.error ? <p role="alert" className="mb-4 rounded-card border border-status-error/20 bg-status-error/5 p-3 text-sm text-status-error">{props.error}</p> : null}
      {props.loading ? <p role="status" className="mb-4 text-sm text-text-ink/55">{copy("正在加载插件…", "Loading plugins…")}</p> : null}
      {!props.loading && visiblePlugins.length === 0 ? (
        <div className="rounded-card border border-border-stone/30 bg-background-paper px-6 py-12 text-center text-sm text-text-ink/50">
          <Puzzle size={26} className="mx-auto mb-3 text-text-ink/30" aria-hidden="true" />
          {normalizedQuery ? copy("没有找到匹配的任务插件。", "No task plugins match your search.")
            : filter === "installed" ? copy("还没有安装插件，去“全部”看看。", "No plugins installed. Explore the All tab.") : copy("暂无可用插件。", "No plugins available.")}
        </div>
      ) : null}
      <div className="plugin-marketplace-grid">
        {visiblePlugins.map((plugin) => (
          <article key={plugin.id} aria-label={plugin.name} className="plugin-marketplace-row"
            data-installed={plugin.installed?.state === "active" && !pluginNeedsSignIn(plugin, signedIn) ? "true" : undefined}>
            <button type="button" onClick={() => setDetailId(plugin.id)} className="plugin-marketplace-summary" aria-label={`${copy("查看", "View ")}${plugin.name}${copy("详情", " details")}`}>
              <PluginIcon category={plugin.category} />
              <span className="plugin-marketplace-text">
                <span className="plugin-marketplace-name-line">
                  <span className="plugin-marketplace-name">{plugin.name}</span>
                </span>
                <span className="plugin-marketplace-description" title={plugin.description}>{plugin.description}</span>
              </span>
            </button>
            <div className="plugin-marketplace-row-actions">
              {props.busyId === plugin.id || isTransitioning(plugin) ? (
                <span className="plugin-marketplace-working" role="status" aria-label={copy(`正在处理${plugin.name}`, `Working on ${plugin.name}`)}><Loader2 size={16} className="animate-spin" aria-hidden="true" /></span>
              ) : pluginNeedsSignIn(plugin, signedIn) ? (
                <button type="button" className="plugin-marketplace-sign-in-button"
                  aria-label={copy(`登录后使用${plugin.name}`, `Sign in to use ${plugin.name}`)} title={copy("登录后使用", "Sign in to use")}
                  disabled={busy} onClick={() => performPrimary(plugin)}>
                  <LogIn size={14} aria-hidden="true" />
                  {copy("去登录", "Sign in")}
                </button>
              ) : !plugin.installed ? (
                <button type="button" className={plugin.installable ? "plugin-marketplace-icon-button" : "plugin-marketplace-coming-soon"}
                  aria-label={plugin.installable ? copy(`安装${plugin.name}`, `Install ${plugin.name}`) : copy("即将上线", "Coming soon")}
                  title={plugin.installable ? copy(`安装${plugin.name}`, `Install ${plugin.name}`) : undefined}
                  disabled={actionsDisabled || !plugin.installable} onClick={() => performPrimary(plugin)}>
                  {plugin.installable ? <Plus size={18} aria-hidden="true" /> : copy("即将上线", "Coming soon")}
                </button>
              ) : plugin.installed.state === "active" ? (
                <span className="plugin-marketplace-installed-slot">
                  <span className="plugin-marketplace-installed-check" role="img" aria-label={copy("已安装", "Installed")}>
                    <Check size={16} aria-hidden="true" />
                  </span>
                  <Tooltip content={copy("试一试", "Try it")}>
                    <button type="button" className="plugin-marketplace-icon-button plugin-marketplace-try"
                      aria-label={copy(`将${plugin.name}加入对话`, `Add ${plugin.name} to chat`)}
                      onClick={() => addToChat(plugin)}>
                      <MessageSquare size={16} aria-hidden="true" />
                    </button>
                  </Tooltip>
                </span>
              ) : (
                <button type="button" className="plugin-marketplace-retry" aria-label={copy(`重试安装${plugin.name}`, `Retry installing ${plugin.name}`)} disabled={actionsDisabled} onClick={() => performPrimary(plugin)}>{copy("重试安装", "Retry installation")}</button>
              )}
              {plugin.installed ? (
                <div className="plugin-marketplace-menu-anchor" data-plugin-menu>
                  <button type="button" aria-label={`${plugin.name}${copy("更多操作", " options")}`} aria-haspopup="menu" aria-expanded={menuId === plugin.id}
                    data-menu-trigger={plugin.id} disabled={busy} onClick={() => setMenuId(menuId === plugin.id ? null : plugin.id)}
                    className="plugin-marketplace-icon-button">
                    <MoreHorizontal size={18} aria-hidden="true" />
                  </button>
                  {menuId === plugin.id ? (
                    <div role="menu" aria-label={`${plugin.name}${copy("操作", " actions")}`} className="plugin-marketplace-menu"
                      onKeyDown={(event) => {
                        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"));
                        const index = items.indexOf(document.activeElement as HTMLButtonElement);
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          event.preventDefault();
                          items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                        } else if (event.key === "Tab") setMenuId(null);
                      }}>
                      <button type="button" role="menuitem" onClick={() => { setMenuId(null); setDetailId(plugin.id); }}>{copy("查看详情", "View details")}</button>
                      <button type="button" role="menuitem" className="plugin-marketplace-menu-danger" disabled={actionsDisabled} onClick={() => requestUninstall(plugin)}>{copy("卸载", "Uninstall")}</button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      {detail ? (
        <Modal open title={detail.name} subtitle={copy("Memmy 官方插件", "An official Memmy plugin")} headerIcon={<PluginIcon category={detail.category} />}
          className="plugin-marketplace-detail"
          backdropClassName="plugin-marketplace-detail-backdrop"
          closeLabel={copy("关闭", "Close")} closeContent={<X size={16} aria-hidden="true" />} onClose={() => setDetailId(null)}
          style={{ width: 660, maxWidth: "calc(100vw - 32px)" }}
          footer={<div className="plugin-marketplace-detail-footer">
            <span className="plugin-marketplace-detail-status">{status(detail)}{detail.version || detail.installed?.version ? ` · v${detail.version ?? detail.installed?.version}` : ""}</span>
            <div className="plugin-marketplace-detail-actions">
              {detail.installed ? <Button type="button" size="sm" variant="ghost" disabled={actionsDisabled} onClick={() => requestUninstall(detail)}>{copy("卸载", "Uninstall")}</Button> : null}
              {renderPrimary(detail) ?? (detail.installed?.state === "active"
                ? <Button type="button" size="sm" onClick={() => addToChat(detail)}>{copy("加入对话", "Add to chat")}</Button>
                : null)}
            </div>
          </div>}>
          <div className="plugin-marketplace-detail-content">
            <PluginDetailPreview category={detail.category} name={detail.name} />
            <p className="plugin-marketplace-detail-description">{capabilityDescription(detail.category, zh)}</p>
            {(detail.requiresOfficialModel || detail.category === "legal") ? (
              <div className="plugin-marketplace-detail-conditions" aria-label={copy("使用条件", "Requirements")}>
                {detail.requiresOfficialModel ? <span>{copy("需登录；推荐 Memmy 官方模型", "Sign-in required; Memmy official model recommended")}</span> : null}
                {detail.category === "legal" ? <span>{copy("仅限已开通的账号", "For accounts with access")}</span> : null}
              </div>
            ) : null}
            {detail.requiresOfficialModel ? <p className="plugin-marketplace-detail-note">{copy("该插件推荐使用 Memmy 官方模型，效果更好；你也可以使用自己的模型（效果可能不佳），可随时自由切换。", "This plugin works best with the Memmy official model. You can also use your own model (results may be weaker) and switch freely at any time.")}</p> : null}
            {!detail.installed && !detail.installable ? <p className="plugin-marketplace-detail-note">{copy("当前尚未提供可安装版本。", "An installable release is not available yet.")}</p> : null}
            {detail.installed?.state === "failed" ? <p className="plugin-marketplace-detail-error">{copy("安装未能完成，请重试安装。如果仍然失败，请稍后重试或联系支持。", "Installation could not complete. Retry installation, or contact support if the problem continues.")}</p> : null}
          </div>
        </Modal>
      ) : null}

      <ConfirmDialog open={Boolean(uninstallId && confirmationValid)}
        title={copy(`卸载${confirmedPlugin?.name ?? ""}？`, `Uninstall ${confirmedPlugin?.name ?? ""}?`)}
        message={copy("卸载后，新任务将无法使用此插件。你可以稍后重新安装。", "New tasks will no longer be able to use this plugin. You can reinstall it later.")}
        cancelLabel={copy("取消", "Cancel")} closeLabel={copy("关闭", "Close")}
        confirmLabel={copy("卸载", "Uninstall")}
        confirmVariant="danger"
        confirmDisabled={actionsDisabled || !confirmationValid} onCancel={() => setUninstallId(null)}
        onConfirm={() => {
          if (actionsDisabled || !confirmationValid || !confirmedPlugin || !uninstallId) return;
          setUninstallId(null);
          props.onUninstall(confirmedPlugin);
        }} />
    </section>
  );
}

function isTransitioning(plugin: MarketplacePlugin): boolean {
  return plugin.installed?.state === "enabling" || plugin.installed?.state === "disabling";
}

function primaryAction(plugin: MarketplacePlugin, signedIn: boolean, officialModelReady: boolean | undefined): PrimaryAction {
  if (!plugin.installed) {
    if (!plugin.installable) return "unavailable";
    return pluginNeedsSignIn(plugin, signedIn) ? "sign-in" : "install";
  }
  if (plugin.installed.state !== "active") return "enable";
  if (pluginNeedsSignIn(plugin, signedIn)) return "sign-in";
  if (plugin.requiresOfficialModel && officialModelReady === false) return "configure";
  return null;
}

function PluginIcon(props: { category: MarketplacePlugin["category"] }) {
  const Icon = props.category === "legal" ? Scale : props.category === "research" ? BookOpen : props.category === "office" ? FileText : Puzzle;
  return <span className={`plugin-marketplace-icon plugin-marketplace-icon--${props.category}`}><Icon size={20} strokeWidth={1.6} aria-hidden="true" /></span>;
}

function capabilityDescription(category: MarketplacePlugin["category"], zh: boolean): string {
  const copy = (chinese: string, english: string) => zh ? chinese : english;
  switch (category) {
    case "research": return copy("根据研究主题检索论文、整理证据，生成可继续编辑的文献综述和参考文献。", "Find papers for your research topic, organize evidence, and produce an editable literature review with references.");
    case "office": return copy("根据你的要求创建和编辑文档、表格与演示文稿，并处理 PDF 文件。", "Create and edit documents, spreadsheets, and presentations, and work with PDF files according to your instructions.");
    case "legal": return copy("辅助整理劳动用工调研材料、核实信息和起草报告，供专业人员审核。", "Help organize employment research materials, verify information, and draft reports for professional review.");
    case "other": return copy("按照你的任务要求提供相应功能，并将结果交付到任务中。", "Provide the plugin's capabilities according to your instructions and return the results to your task.");
  }
}
