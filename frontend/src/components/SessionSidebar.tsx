/** 桌面侧边栏：品牌 + 导航 + 会话列表 + 设置入口（符合人的使用逻辑：先有导航，再有历史会话）。 */

import { useState } from "react";
import {
  LayoutDashboard, MessageSquare, NotebookPen, Plus, Search, Settings,
  Trash2, Pencil, MessageCircle,
} from "lucide-react";
import { BrandLogo, BRAND } from "@/lib/brand";
import { store } from "@/lib/store";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { SessionItem } from "@/lib/types";

type SidebarTab = "dashboard" | "chat" | "ledger" | "settings";

const NAV: { id: SidebarTab; labelKey: string; icon: typeof LayoutDashboard }[] = [
  { id: "chat", labelKey: "sidebar.chat", icon: MessageSquare },
  { id: "ledger", labelKey: "sidebar.ledger", icon: NotebookPen },
  { id: "dashboard", labelKey: "sidebar.dashboard", icon: LayoutDashboard },
];

export function SessionSidebar({
  tab,
  activeThread,
  onNavigate,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onOpenSettings,
}: {
  tab: SidebarTab;
  activeThread: string | null;
  /** 切换页面（chat 时由内部决定落到最近会话） */
  onNavigate: (t: SidebarTab) => void;
  onSelect: (threadId: string | null) => void;
  onNew: () => void;
  onDelete: (id: number, threadId: string) => void;
  onRename: (id: number, title: string) => void;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  const { sessions } = store.useApp();
  const [editing, setEditing] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [q, setQ] = useState("");

  // 本地过滤：会话量小，无需后端接口
  const kw = q.trim().toLowerCase();
  const filtered = kw ? sessions.filter((s) => s.title.toLowerCase().includes(kw)) : sessions;

  const go = (id: SidebarTab) => {
    onNavigate(id);
    if (id === "chat") onSelect(sessions[0]?.thread_id ?? null);
  };

  return (
    <div className="flex h-full flex-col">
      {/* 品牌：点击回问答首页（chat-first）*/}
      <button
        type="button"
        className="flex items-center gap-2.5 px-4 py-3.5 text-left"
        onClick={() => go("chat")}
      >
        <BrandLogo size={30} />
        <span>
          <span className="block text-sm font-bold leading-tight">{BRAND.name}</span>
          <span className="block text-[11px] text-muted-foreground leading-tight">{t("brand.tagline")}</span>
        </span>
      </button>

      {/* 主导航 */}
      <nav className="px-2 space-y-0.5">
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            aria-current={tab === n.id ? "page" : undefined}
            className={cn(
              "w-full flex items-center gap-2 rounded-[calc(var(--radius)-2px)] px-3 py-2 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === n.id
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            onClick={() => go(n.id)}
          >
            <n.icon className="w-4 h-4" />
            {t(n.labelKey)}
          </button>
        ))}
      </nav>

      {/* 会话区 */}
      <div className="mt-4 flex-1 min-h-0 flex flex-col">
        <div className="flex items-center justify-between px-4 mb-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("sidebar.sessions")}
          </span>
          <button
            type="button"
            className="text-muted-foreground hover:text-primary p-1"
            aria-label={t("sidebar.newSession")}
            onClick={onNew}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        {/* 会话多了之后提供搜索（主流 agent 标配） */}
        {sessions.length > 3 && (
          <div className="px-2 mb-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("sidebar.searchSession")}
                aria-label={t("sidebar.searchSession")}
                className="w-full rounded-lg border border-input bg-background pl-8 pr-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
        )}
        <div className="flex-1 overflow-y-auto scroll-thin px-2 space-y-0.5">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              <MessageCircle className="w-4 h-4 mx-auto mb-1.5 opacity-60" />
              {q.trim() ? t("sidebar.noMatch") : t("sidebar.noSessions")}
              {!q.trim() && (
                <>
                  <br />
                  {t("sidebar.startHint")}
                </>
              )}
            </div>
          ) : (
            filtered.slice(0, 30).map((s: SessionItem) => (
              <div
                key={s.id}
                className={cn(
                  "group flex items-center gap-1 rounded-[calc(var(--radius)-2px)] px-2 py-1.5 text-sm cursor-pointer transition-colors",
                  s.thread_id === activeThread
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
                onClick={() => onSelect(s.thread_id)}
              >
                {editing === s.id ? (
                  <input
                    autoFocus
                    className="min-w-0 flex-1 rounded border border-input bg-background px-1.5 py-0.5 text-xs"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        onRename(s.id, editTitle.trim() || s.title);
                        setEditing(null);
                      }
                      if (e.key === "Escape") setEditing(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{s.title}</span>
                    <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        aria-label={t("sidebar.rename")}
                        className="p-0.5 text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(s.id);
                          setEditTitle(s.title);
                        }}
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={t("sidebar.deleteSession")}
                        className="p-0.5 text-muted-foreground hover:text-red-600"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(s.id, s.thread_id);
                        }}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </span>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* 底部：设置入口 + 会话数 */}
      <div className="border-t border-border px-2 py-2">
        <button
          type="button"
          className="w-full flex items-center gap-2 rounded-[calc(var(--radius)-2px)] px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onOpenSettings}
        >
          <Settings className="w-4 h-4" />
          {t("sidebar.settings")}
        </button>
        <div className="px-3 pt-1 text-[10px] text-muted-foreground/70">
          {sessions.length} {t("sidebar.sessionCount")} · {t("sidebar.localData")}
        </div>
      </div>
    </div>
  );
}
