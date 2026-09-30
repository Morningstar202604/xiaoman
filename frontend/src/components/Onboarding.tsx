import { useState } from "react";
import { motion } from "framer-motion";
import { LineChart, NotebookPen, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 首次启动三步引导：空账本首启时弹出，带用户走一遍核心入口
 * （记一笔 → 加自选 → 配 AI）。任一步「去试试」或跳过即完成，
 * localStorage 标记后不再打扰；各页空态引导仍在兜底。
 */
const STEPS: {
  icon: typeof NotebookPen;
  titleKey: string;
  descKey: string;
  btnKey: string;
  tab: "ledger" | "market" | "settings";
}[] = [
  { icon: NotebookPen, titleKey: "onboard.step1Title", descKey: "onboard.step1Desc", btnKey: "onboard.step1Btn", tab: "ledger" },
  { icon: LineChart, titleKey: "onboard.step2Title", descKey: "onboard.step2Desc", btnKey: "onboard.step2Btn", tab: "market" },
  { icon: Sparkles, titleKey: "onboard.step3Title", descKey: "onboard.step3Desc", btnKey: "onboard.step3Btn", tab: "settings" },
];

export function Onboarding({ onNavigate, onDone }: { onNavigate: (tab: "ledger" | "market" | "settings") => void; onDone: () => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const s = STEPS[step];
  const Icon = s.icon;

  const go = () => {
    onNavigate(s.tab);
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lift"
      >
        {/* 头部：标题 + 关闭 */}
        <div className="flex items-start justify-between">
          <div className="text-base font-semibold">{t("onboard.title")}</div>
          <button
            type="button"
            onClick={onDone}
            aria-label={t("onboard.close")}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 步进指示：3 圆点 */}
        <div className="mt-3 flex items-center gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === step ? "w-6 bg-primary" : "w-1.5 bg-border",
              )}
            />
          ))}
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {step + 1}/{STEPS.length}
          </span>
        </div>

        {/* 当前步骤 */}
        <div className="mt-5 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">{t(s.titleKey)}</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t(s.descKey)}</p>
          </div>
        </div>

        {/* 动作区 */}
        <div className="mt-6 space-y-2">
          <Button className="w-full" onClick={go}>
            {t(s.btnKey)}
          </Button>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={onDone}
              className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {t("onboard.skip")}
            </button>
            {step < STEPS.length - 1 && (
              <button
                type="button"
                onClick={() => setStep((v) => v + 1)}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {t("onboard.next")}
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
