import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { LayoutDashboard, LineChart, MessageSquare, NotebookPen, Sparkles, Wallet, X } from "lucide-react";
import { TopBar, type TopTab } from "@/components/TopBar";
import { SessionSidebar } from "@/components/SessionSidebar";
import { Dashboard } from "@/components/Dashboard";
import { HoldingsView } from "@/components/HoldingsView";
import { MarketView } from "@/components/MarketView";
import { EntryView } from "@/components/EntryView";
import { SettingsView } from "@/components/SettingsView";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/confirm";
import { PasswordDialog } from "@/components/ui/password-dialog";
import { store } from "@/lib/store";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

// 问答页（含 markdown 渲染 ~153KB）按需加载：问答非首屏，echarts 仍不进首屏
const ChatView = lazy(() => import("@/components/ChatView").then((m) => ({ default: m.ChatView })));

type Tab = TopTab | "settings";

// 移动端底部导航：总览 / 持仓 / 行情 / 记账 / 问AI（设置走顶栏齿轮）
const NAV: { id: TopTab; labelKey: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", labelKey: "nav.dashboard", icon: LayoutDashboard },
  { id: "holdings", labelKey: "nav.holdings", icon: Wallet },
  { id: "market", labelKey: "nav.market", icon: LineChart },
  { id: "ledger", labelKey: "nav.ledger", icon: NotebookPen },
  { id: "chat", labelKey: "nav.chat", icon: MessageSquare },
];

export default function App() {
  const { t } = useI18n();
  const { sessions, bootstrap } = store.useApp();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("overview");
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: number; threadId: string } | null>(null);
  const [inited, setInited] = useState(false);
  const [aiBannerDismiss, setAiBannerDismiss] = useState(false);

  // AI 未配置引导：bootstrap 健康检查标记（配置后消失）
  const llmConfigured = bootstrap?.health?.llm_configured ?? true;

  // 首次进入时加载基础数据
  useEffect(() => {
    void store.refreshBootstrap();
    void store.refreshDashboard();
    void store.refreshSessions().finally(() => setInited(true));
  }, []);

  // 涨跌颜色主题（设置中心自定义）：cn 红涨绿跌 / us 绿涨红跌，即时作用于 --color-up/down
  const colorScheme = bootstrap?.settings.color_scheme ?? "cn";
  useEffect(() => {
    document.documentElement.dataset.scheme = colorScheme === "us" ? "us" : "cn";
  }, [colorScheme]);

  // 默认首页（设置中心自定义）：首次加载完成后落地，之后用户手动切换不受影响
  const defaultTab = bootstrap?.settings.default_tab;
  const defaultApplied = useRef(false);
  useEffect(() => {
    if (!defaultApplied.current && (defaultTab === "overview" || defaultTab === "holdings" || defaultTab === "market" || defaultTab === "ledger" || defaultTab === "chat")) {
      setTab(defaultTab);
      defaultApplied.current = true;
    }
  }, [defaultTab]);

  // 仪表盘自动刷新（设置中心开关）
  const autoRefresh = bootstrap?.settings.auto_refresh === "on";
  const autoRefreshSec = Number(bootstrap?.settings.auto_refresh_seconds ?? 300);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      void store.refreshDashboard();
    }, Math.max(30, autoRefreshSec) * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, autoRefreshSec]);

  const newSession = useCallback(async () => {
    try {
      const r = await api<{ thread_id: string }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await store.refreshSessions();
      setActiveThread(r.thread_id);
      setTab("chat");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  }, [toast]);

  const openChat = useCallback(
    (threadId: string | null) => {
      if (!threadId && sessions.length === 0) {
        void newSession();
        return;
      }
      setActiveThread(threadId ?? sessions[0]?.thread_id ?? null);
      setTab("chat");
    },
    [sessions, newSession],
  );

  const deleteSession = useCallback(
    async (id: number, threadId: string) => {
      try {
        await api(`/api/sessions/${id}`, { method: "DELETE" });
        await store.refreshSessions();
        if (activeThread === threadId) {
          // 正在看被删的会话：落到最近会话或新建，不留空页面
          setActiveThread(null);
          if (sessions.length <= 1) {
            void newSession();
          } else {
            const next = sessions.find((s) => s.thread_id !== threadId);
            setActiveThread(next?.thread_id ?? null);
          }
        }
        toast(t("app.sessionDeleted"), "ok");
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "error");
      }
    },
    [activeThread, sessions, newSession, toast],
  );

  const renameSession = useCallback(
    async (id: number, title: string) => {
      try {
        await api(`/api/sessions/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ title }),
        });
        await store.refreshSessions();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "error");
      }
    },
    [toast],
  );

  const goChat = () => {
    if (!activeThread && sessions.length > 0) {
      setActiveThread(sessions[0].thread_id);
    } else if (!activeThread && sessions.length === 0) {
      void newSession();
    }
    setTab("chat");
  };

  const navigate = (next: TopTab) => {
    if (next === "chat") goChat();
    else setTab(next);
  };

  // 进入问AI 页时落到最近会话（无会话则新建），避免滞留在加载占位
  useEffect(() => {
    if (!inited || tab !== "chat" || activeThread) return;
    if (sessions.length > 0) setActiveThread(sessions[0].thread_id);
    else void newSession();
  }, [inited, tab, activeThread, sessions, newSession]);

  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
    <div className="flex h-full">
      {/* 桌面侧栏：仅问AI 页显示会话历史，其他页让位给内容 */}
      {tab === "chat" && (
        <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-border bg-card/40">
          <SessionSidebar
            activeThread={activeThread}
            onHome={() => setTab("overview")}
            onSelect={openChat}
            onNew={() => void newSession()}
            onDelete={(id, threadId) => setPendingDelete({ id, threadId })}
            onRename={renameSession}
            onOpenSettings={() => setTab("settings")}
          />
        </aside>
      )}

      <div className="flex flex-1 min-w-0 flex-col">
        <TopBar tab={tab === "settings" ? "overview" : tab} onNavigate={navigate} onOpenSettings={() => setTab("settings")} />

        {/* AI 未配置引导：可关闭，跳设置一键填国产端点 */}
        {!llmConfigured && !aiBannerDismiss && tab !== "settings" && (
          <div className="mx-auto mt-3 flex w-[min(100%,46rem)] items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <Sparkles className="w-3.5 h-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{t("aiBanner.title")}</span> · {t("aiBanner.desc")}
            </span>
            <button
              type="button"
              className="shrink-0 rounded-md border border-amber-600/40 px-2 py-0.5 font-medium hover:bg-amber-600/10"
              onClick={() => setTab("settings")}
            >
              {t("aiBanner.go")}
            </button>
            <button
              type="button"
              className="shrink-0 rounded-md p-0.5 text-amber-700/70 hover:text-amber-700 dark:text-amber-400/70 dark:hover:text-amber-400"
              aria-label={t("aiBanner.dismiss")}
              onClick={() => setAiBannerDismiss(true)}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <main
          className={cn(
            "flex-1 min-h-0",
            tab === "chat" ? "flex flex-col" : "overflow-y-auto scroll-thin",
          )}
        >
          {tab === "chat" ? (
            <div className="mx-auto w-full max-w-3xl h-full flex flex-col pb-20 md:pb-0 view-enter">
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {t("app.preparing")}
                  </div>
                }
              >
                {activeThread ? (
                  <ChatView
                    key={activeThread}
                    threadId={activeThread}
                    onNewSession={() => void newSession()}
                    onSwitch={openChat}
                    onOpenSettings={() => setTab("settings")}
                  />
                ) : (
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {t("app.preparing")}
                  </div>
                )}
              </Suspense>
            </div>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                className="mx-auto max-w-3xl px-4 py-4 pb-24 md:pb-8"
              >
                {tab === "overview" && <Dashboard onGoLedger={() => setTab("ledger")} />}
                {tab === "holdings" && <HoldingsView />}
                {tab === "market" && <MarketView />}
                {tab === "ledger" && <EntryView />}
                {tab === "settings" && <SettingsView />}
              </motion.div>
            </AnimatePresence>
          )}
        </main>

        {/* 移动端底部导航 */}
        <nav className="md:hidden fixed bottom-0 inset-x-0 z-10 glass border-t border-border grid grid-cols-5 pb-[env(safe-area-inset-bottom)]" aria-label={t("nav.main")}>
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              aria-current={tab === n.id ? "page" : undefined}
              className={cn(
                "relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:-ring-offset-2 focus-visible:ring-inset",
                tab === n.id ? "text-primary" : "text-muted-foreground",
              )}
              onClick={() => navigate(n.id)}
            >
              {tab === n.id && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute -top-px h-0.5 w-8 rounded-full bg-primary"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              )}
              <n.icon className="w-5 h-5" />
              {t(n.labelKey)}
            </button>
          ))}
        </nav>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        title={t("app.deleteTitle")}
        description={t("app.deleteDesc")}
        confirmText={t("app.delete")}
        danger
        onConfirm={() => {
          const t = pendingDelete;
          setPendingDelete(null);
          if (t) void deleteSession(t.id, t.threadId);
        }}
      />

      {/* 访问口令：401 时应用内输入，替代原生 prompt */}
      <PasswordDialog />
    </div>
      </TooltipProvider>
    </MotionConfig>
  );
}
