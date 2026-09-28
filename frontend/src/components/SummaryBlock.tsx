import { Badge } from "@/components/ui/badge";
import { fmtMoney, pnlClass } from "@/lib/format";
import type { AnswerMeta } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

/** 回答尾部摘要：等级 + 关键数字 + 风险提示（全部来自后端 final 事件，口径唯一）。 */
export function SummaryBlock({ meta }: { meta: AnswerMeta }) {
  const { t } = useI18n();
  const m = meta.metrics;
  const chips: { label: string; value: string; cls?: string }[] = [];
  if (m.total_market_value != null)
    chips.push({ label: t("summary.marketValue"), value: fmtMoney(m.total_market_value) });
  if (m.total_pnl != null)
    chips.push({
      label: t("summary.totalPnl"),
      value: fmtMoney(m.total_pnl, true),
      cls: pnlClass(m.total_pnl),
    });
  if (m.net != null) chips.push({ label: t("summary.monthlyNet"), value: fmtMoney(m.net, true) });
  if (m.savings_rate != null) chips.push({ label: t("summary.savingsRate"), value: `${m.savings_rate}%` });
  if (m.debt_monthly != null)
    chips.push({ label: t("summary.debtMonthly"), value: `${fmtMoney(m.debt_monthly)}/mo` });

  // 内部等级代号不出口：L2 建议 / L1 洞察 / 已记账 → 用户能懂的话。
  // 通用闲聊（level 为空）不套财务分级，因此这里也不给标签。
  const LEVEL_TEXT: Record<string, string> = {
    "L2 建议": t("summary.l2"),
    "L1 洞察": t("summary.l1"),
    "已记账": t("summary.recorded"),
  };
  const levelText = LEVEL_TEXT[meta.level] ?? meta.level;
  const isAlert = meta.level === "L2 建议";
  const hasChips = chips.length > 0;
  // 通用回答：既无等级也无指标，这整块就是空的 → 什么都不渲染
  if (!levelText && !meta.llm && !hasChips) return null;

  return (
    <div className="mt-3 border-t border-border/70 pt-2.5">
      {(levelText || meta.llm) && (
        <div className="flex items-center gap-2">
          {levelText && <Badge variant={isAlert ? "warn" : "ok"}>{levelText}</Badge>}
          {/* 来源只在拿得到时才说：来源未知的旧记录不能替它断言 */}
          {meta.llm && (
            <span className="text-xs text-muted-foreground">
              {meta.llm === "llm" ? t("summary.llmAnswer") : t("summary.ruleAnswer")}
            </span>
          )}
          {meta.tools && meta.tools.length > 0 && (
            <span className="text-xs text-muted-foreground">{t("summary.tools", { n: meta.tools.length })}</span>
          )}
        </div>
      )}
      {hasChips && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
          {chips.map((c) => (
            <span key={c.label} className="text-muted-foreground">
              {c.label}
              <b className={cn("ml-1 text-foreground", c.cls)}>{c.value}</b>
            </span>
          ))}
        </div>
      )}
      {/* 风险清单不在这里重复列：模板回答必然逐条列出，模型也被 system prompt 要求列出，
          再列一遍就是同一屏说两遍。 */}
    </div>
  );
}
