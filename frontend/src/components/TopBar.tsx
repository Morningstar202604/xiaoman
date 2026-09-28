import { Languages, Moon, Settings, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { BrandLogo, BRAND } from "@/lib/brand";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";

/** 顶栏：品牌 + 日期 + 语言切换 + 明暗切换 + 设置。数据来源等工程细节移到设置页，不占首屏。 */
export function TopBar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { resolved, setTheme } = useTheme();
  const { lang, setLang, t } = useI18n();
  const today = new Date().toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });

  return (
    <header className="glass sticky top-0 z-10 flex items-center justify-between border-b border-border px-4 py-1.5 sm:py-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="flex items-center gap-2 min-w-0 md:hidden">
          <BrandLogo size={24} />
          <span className="text-sm font-bold leading-none truncate">{BRAND.name}</span>
          <span className="text-[11px] text-muted-foreground leading-none truncate">{today}</span>
        </span>
        <span className="hidden text-[11px] text-muted-foreground leading-tight truncate md:inline">{today}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Tooltip label={lang === "zh" ? "Switch to English" : "切换到中文"}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={lang === "zh" ? "Switch language" : "切换语言"}
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
