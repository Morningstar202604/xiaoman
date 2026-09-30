import { Languages, LayoutDashboard, LineChart, MessageSquare, Moon, NotebookPen, Settings, Sun, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { BrandLogo, BRAND } from "@/lib/brand";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export type TopTab = "overview" | "holdings" | "market" | "ledger" | "chat";

const NAV: { id: TopTab; labelKey: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", labelKey: "nav.dashboard", icon: LayoutDashboard },
  { id: "holdings", labelKey: "nav.holdings", icon: Wallet },
  { id: "market", labelKey: "nav.market", icon: LineChart },
  { id: "ledger", labelKey: "nav.ledger", icon: NotebookPen },
  { id: "chat", labelKey: "nav.chat", icon: MessageSquare },
];

/** 顶栏：品牌 + 页签导航（桌面）+ 语言 / 明暗 / 设置。移动端导航在底部。 */
export function TopBar({
  tab,
  onNavigate,
  onOpenSettings,
}: {
  tab: TopTab;
  onNavigate: (t: TopTab) => void;
  onOpenSettings?: () => void;
}) {
  const { resolved, setTheme } = useTheme();
  const { lang, setLang, t } = useI18n();
  const today = new Date().toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });

  return (
    <header className="glass sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border px-4 py-1.5 sm:py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex items-center gap-2 min-w-0 md:hidden">
          <BrandLogo size={24} />
          <span className="text-sm font-bold leading-none truncate">{BRAND.name}</span>
        </span>
        <span className="hidden text-[11px] text-muted-foreground leading-tight truncate md:inline">{today}</span>
      </div>

      {/* 桌面页签导航：总览 / 持仓 / 行情 / 记账 / 问AI */}
      <nav className="hidden md:flex items-center gap-0.5" aria-label={t("nav.main")}>
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            aria-current={tab === n.id ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === n.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            onClick={() => onNavigate(n.id)}
          >
            <n.icon className="w-4 h-4" />
            {t(n.labelKey)}
          </button>
        ))}
      </nav>

      <div className="flex items-center gap-1.5">
        <Tooltip label={lang === "zh" ? "Switch to English" : "Switch to Chinese"}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={lang === "zh" ? "Switch language" : "Switch language"}
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          >
            <Languages className="w-4 h-4" />
          </Button>
        </Tooltip>
        <Tooltip label={resolved === "dark" ? t("topbar.toggleLight") : t("topbar.toggleDark")}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("topbar.toggleTheme")}
            onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
          >
            {resolved === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
        </Tooltip>
        {onOpenSettings && (
          <Tooltip label={t("topbar.settings")}>
            <Button variant="ghost" size="icon" aria-label={t("topbar.settings")} onClick={onOpenSettings}>
              <Settings className="w-4 h-4" />
            </Button>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
