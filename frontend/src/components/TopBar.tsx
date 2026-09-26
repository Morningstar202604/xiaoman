import { Moon, Settings, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { BrandLogo, BRAND } from "@/lib/brand";
import { useTheme } from "@/lib/theme";

/** 顶栏：品牌 + 日期 + 明暗切换 + 设置。数据来源等工程细节移到设置页，不占首屏。 */
export function TopBar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { resolved, setTheme } = useTheme();
  const today = new Date().toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });

  return (
    <header className="glass sticky top-0 z-10 flex items-center justify-between border-b border-border px-4 py-2">
      <div className="flex items-center gap-2.5 min-w-0">
        {/* 桌面端侧栏已有品牌，顶栏只留移动端品牌 + 日期 */}
        <span className="flex items-center gap-2.5 min-w-0 md:hidden">
          <BrandLogo size={28} />
          <span className="text-sm font-bold leading-tight truncate">{BRAND.name}</span>
        </span>
        <span className="text-[11px] text-muted-foreground leading-tight truncate">{today}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Tooltip label={resolved === "dark" ? "切换浅色" : "切换深色"}>
          <Button
            variant="ghost"
            size="icon"
            aria-label="切换明暗"
            onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
          >
            {resolved === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
        </Tooltip>
        {onOpenSettings && (
          <Tooltip label="设置">
            <Button variant="ghost" size="icon" aria-label="设置" onClick={onOpenSettings}>
              <Settings className="w-4 h-4" />
            </Button>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
