import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Brain, Download, KeyRound, Newspaper, PiggyBank, RefreshCw, ShieldCheck, SlidersHorizontal, Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/segmented";
import { ConfirmDialog } from "@/components/ui/confirm";
import { useTheme } from "@/lib/theme";
import { api, getToken, setToken } from "@/lib/api";
import { store } from "@/lib/store";
import { useToast } from "@/lib/toast";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RunRecord } from "@/lib/types";

const inputCls =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const labelCls = "block text-xs text-muted-foreground mb-1";

type SectionId = "prefs" | "rules" | "budget" | "ai" | "report" | "data" | "token";

const SECTIONS: { id: SectionId; label: string; icon: typeof Wallet }[] = [
  { id: "prefs", label: "偏好", icon: SlidersHorizontal },
  { id: "rules", label: "账本规则", icon: Wallet },
  { id: "budget", label: "预算", icon: PiggyBank },
  { id: "ai", label: "AI 回答", icon: Brain },
  { id: "report", label: "每日晨报", icon: Newspaper },
  { id: "data", label: "数据与状态", icon: ShieldCheck },
  { id: "token", label: "访问口令", icon: KeyRound },
];

/** 「保存设置」按钮覆盖的键（其余开关即时生效、AI 配置走独立保存）。 */
const BATCH_KEYS = [
  "monthly_income",
  "emergency_target_months",
  "essential_categories",
  "savings_goal",
  "report_time",
] as const;

function Section({
  title,
  icon,
  desc,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-[var(--card-pad)]">
      <div className="flex items-center gap-1.5 text-sm font-medium mb-1">
        {icon}
        {title}
      </div>
      {desc ? <div className="text-xs text-muted-foreground mb-2">{desc}</div> : null}
      {children}
    </Card>
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint ? <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SettingsView() {
  const { bootstrap } = store.useApp();
  const { toast } = useToast();
  const theme = useTheme();

  const { theme: themeMode, setTheme } = theme;

  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<SectionId>("prefs");
  const [resetOpen, setResetOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState(getToken());
  const [reports, setReports] = useState<RunRecord[]>([]);
  const [budgetTotal, setBudgetTotal] = useState("");
  const [budgetCats, setBudgetCats] = useState("");

  useEffect(() => {
    if (bootstrap) setForm({ ...bootstrap.settings });
  }, [bootstrap]);

  // 加载本月预算设置
  useEffect(() => {
    let alive = true;
    api<{ budgets: { key: string; amount: number }[] }>("/api/budgets")
      .then((d) => {
        if (!alive) return;
        const total = d.budgets.find((b) => b.key === "__total");
        setBudgetTotal(total ? String(total.amount) : "");
        setBudgetCats(
          d.budgets
            .filter((b) => b.key !== "__total")
            .map((b) => `${b.key} ${b.amount}`)
            .join("\n"),
        );
      })
      .catch(() => {
        /* 预算读取失败不阻塞设置页 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const saveBudget = async () => {
    const items: { category: string; amount: number }[] = [];
    const total = Number(budgetTotal);
    if (Number.isFinite(total) && total > 0) items.push({ category: "__total", amount: total });
    for (const line of budgetCats.split("\n")) {
      const m = line.trim().match(/^(.+?)\s+(\d+(?:\.\d+)?)$/);
      if (m && Number(m[2]) > 0) items.push({ category: m[1].trim(), amount: Number(m[2]) });
    }
    try {
      await api("/api/budgets", { method: "PUT", body: JSON.stringify({ budgets: items }) });
      toast("预算已保存", "ok");
      store.bump();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  // 加载最近晨报（生成 / 进入设置页时刷新）
  const loadReports = useCallback(async () => {
    try {
      const d = await api<{ reports: RunRecord[] }>("/api/reports?limit=5");
      setReports(d.reports ?? []);
    } catch {
      /* 晨报历史加载失败不阻塞设置页 */
    }
  }, []);
  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  if (!bootstrap) {
    return <div className="p-8 text-center text-sm text-muted-foreground">加载中…</div>;
  }

  const save = async () => {
    setSaving(true);
    try {
      // 只提交表单自有字段：bootstrap.settings 里含 data_note 等服务端内部键，
      // 整包回传会被后端判为「未知配置项」，导致保存必失败。
      const settings: Record<string, string> = {};
      for (const k of BATCH_KEYS) if (form[k] !== undefined) settings[k] = form[k];
      const res = await api<{ ok: boolean; errors: string[] }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ settings }),
      });
      if (res.errors.length) {
        toast(`保存失败：${res.errors.join("；")}`, "error");
      } else {
        toast("设置已保存", "ok");
        await store.refreshBootstrap();
        store.bump();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  /** 开关类即改即生效（与外观一致，无需点保存按钮）；数值输入仍走底部批量保存。 */
  const toggle = (k: string) => {
    const v = form[k] === "on" ? "off" : "on";
    set(k, v);
    void (async () => {
      try {
        const res = await api<{ ok: boolean; errors: string[] }>("/api/settings", {
          method: "PUT",
          body: JSON.stringify({ settings: { [k]: v } }),
        });
        if (res.errors.length) {
          toast(`保存失败：${res.errors.join("；")}`, "error");
          return;
        }
        await store.refreshBootstrap();
        store.bump();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "error");
      }
    })();
  };

  const resetSeed = async () => {
    await api("/api/portfolio/reset", { method: "POST" });
    await store.refreshBootstrap();
    store.bump();
    toast("已恢复示例数据", "ok");
  };

  const saveAi = async () => {
    try {
      const res = await api<{ ok: boolean; errors: string[] }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            ai_base_url: (form.ai_base_url ?? "").trim(),
            ai_api_key: (form.ai_api_key ?? "").trim(),
            ai_model: (form.ai_model ?? "").trim(),
          },
        }),
      });
      if (res.errors.length) {
        toast(`保存失败：${res.errors.join("；")}`, "error");
        return;
      }
      await store.refreshBootstrap();
      store.bump();
      toast("AI 配置已保存", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const exportBackup = async () => {
    try {
      const data = await api<Record<string, unknown>>("/api/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `随身理财-备份-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("备份已下载", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const sc = bootstrap.scheduler;

  return (
    <div className="md:flex md:items-start md:gap-3">
      <nav className="grid grid-cols-4 md:grid-cols-1 gap-1.5 md:w-48 md:shrink-0 md:sticky md:top-4 mb-3 md:mb-0">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          const on = active === s.id;
          return (
            <button
              key={s.id}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => setActive(s.id)}
              className={cn(
                "flex flex-col md:flex-row items-center justify-center md:justify-start gap-1 rounded-lg px-2 py-2 text-xs transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{s.label}</span>
            </button>
          );
        })}
      </nav>

      <motion.div
        key={active}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
        className="flex-1 min-w-0 space-y-3"
      >
      {/* 偏好：只留日常会动的两项，其余工程开关全部砍掉 */}
      {active === "prefs" && (
      <Section title="偏好" icon={<SlidersHorizontal className="w-4 h-4 text-muted-foreground" />} desc="即时生效，保存在本机浏览器">
        <div className="flex items-center justify-between">
          <span className="text-sm">主题模式</span>
          <Segmented
            value={themeMode}
            onChange={setTheme}
            options={[
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
              { value: "system", label: "跟随系统" },
            ]}
          />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <div>
            <div className="text-sm">语音提问</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">问答页显示麦克风按钮（需浏览器支持）</div>
          </div>
          <Switch checked={form.voice_input === "on"} onChange={() => toggle("voice_input")} label="语音提问" />
        </div>
      </Section>)}

      {/* 账本假设 */}
      {active === "rules" && (
      <Section title="账本规则" icon={<Wallet className="w-4 h-4 text-muted-foreground" />} desc="用于结余、储蓄率、应急金等计算口径">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>月收入（元）</label>
            <input className={inputCls} type="number" value={form.monthly_income ?? ""} onChange={(e) => set("monthly_income", e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>应急金目标（月）</label>
            <input className={inputCls} type="number" value={form.emergency_target_months ?? ""} onChange={(e) => set("emergency_target_months", e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>必要支出类别（逗号分隔，用于应急金口径）</label>
            <input className={inputCls} value={form.essential_categories ?? ""} onChange={(e) => set("essential_categories", e.target.value)} placeholder="居住,餐饮,交通" />
          </div>
          <div>
            <label className={labelCls}>储蓄率目标（%）</label>
            <input className={inputCls} type="number" value={form.savings_goal ?? "20"} onChange={(e) => set("savings_goal", e.target.value)} />
          </div>
        </div>
      </Section>)}

      {/* 预算 */}
      {active === "budget" && (
      <Section
        title="预算"
        desc="设置本月总预算与分类预算，仪表盘实时展示进度、剩余日均与超支预警"
      >
        <div className="space-y-3">
          <div>
            <label className={labelCls}>本月总预算（元）</label>
            <input className={inputCls} type="number" min="0" value={budgetTotal} onChange={(e) => setBudgetTotal(e.target.value)} placeholder="例如 5000" />
          </div>
          <div>
            <label className={labelCls}>分类预算（每行「类别 金额」）</label>
            <textarea
              className={`${inputCls} min-h-24`}
              value={budgetCats}
              onChange={(e) => setBudgetCats(e.target.value)}
              placeholder={"餐饮 800\n交通 300\n购物 500"}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              {budgetTotal ? `总预算 ¥${budgetTotal}` : "未设置总预算"} · 分类 {budgetCats.trim() ? budgetCats.trim().split("\n").filter((l) => l.trim()).length : 0} 项
            </span>
            <Button variant="outline" size="sm" onClick={() => void saveBudget()} disabled={saving}>
              保存预算
            </Button>
          </div>
        </div>
      </Section>)}

      {/* AI 回答 */}
      {active === "ai" && (
      <Section
        title="AI 回答"
        icon={<Brain className="w-4 h-4 text-muted-foreground" />}
        desc="可选。接入任意 OpenAI 兼容模型（豆包 / DeepSeek / 通义等）。未配置或调用失败时自动回退内置分析。"
      >
        <div className="space-y-3">
          <Row label="启用 AI 回答" hint="开启后问答优先使用 AI 生成，失败自动降级">
            <Switch checked={form.ai_enabled === "on"} onChange={() => toggle("ai_enabled")} label="启用 AI 回答" />
          </Row>
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
            开启后，你的持仓与账本摘要会随问题发送到你配置的模型服务商。介意数据出机请保持关闭，内置分析已能回答全部问题。
          </div>
          <div>
            <label className={labelCls}>接口地址（Base URL）</label>
            <input
              className={inputCls}
              value={form.ai_base_url ?? ""}
              onChange={(e) => set("ai_base_url", e.target.value)}
              placeholder="https://apihub.agnes-ai.com/v1"
            />
          </div>
          <div>
            <label className={labelCls}>API Key（仅存本机）</label>
            <input
              className={inputCls}
              type="password"
              value={form.ai_api_key ?? ""}
              onChange={(e) => set("ai_api_key", e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
            />
          </div>
          <div>
            <label className={labelCls}>模型</label>
            <input
              className={inputCls}
              value={form.ai_model ?? ""}
              onChange={(e) => set("ai_model", e.target.value)}
              placeholder="agnes-3.0-flash / deepseek-chat 等"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              当前：{bootstrap.health.llm_configured ? `已启用（${bootstrap.health.model}）` : "未启用（内置分析）"}
            </span>
            <Button variant="outline" size="sm" onClick={() => void saveAi()}>
              保存 AI 配置
            </Button>
          </div>
        </div>
      </Section>)}

      {/* 每日晨报：默认只留时间 + 立即生成，历史收进折叠 */}
      {active === "report" && (
      <Section title="每日晨报" icon={<Newspaper className="w-4 h-4 text-muted-foreground" />}>
        <div className="flex items-end gap-2">
          <div className="w-36">
            <label className={labelCls}>生成时间</label>
            <input className={inputCls} type="time" value={form.report_time ?? "08:00"} onChange={(e) => set("report_time", e.target.value)} />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const r = await api<{ ok: boolean; skipped?: boolean }>("/api/reports/generate", {
                  method: "POST",
                });
                if (r.skipped) {
                  toast("还没有数据，暂不生成晨报", "error");
                  return;
                }
                toast(r.ok ? "晨报已生成" : "生成失败", r.ok ? "ok" : "error");
                store.bump();
                void loadReports();
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e), "error");
              }
            }}
          >
            <RefreshCw className="w-3.5 h-3.5" /> 立即生成
          </Button>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          {sc.enabled ? `下次：${sc.next_run_at ?? "—"}` : "定时任务未启用"}
          {sc.generated > 0 ? ` · 已生成 ${sc.generated} 份` : ""}
        </div>
        <details className="mt-3 group">
          <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
            最近晨报{reports.length > 0 ? `（${reports.length}）` : ""}
          </summary>
          {reports.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {reports.map((r) => (
                <details key={r.id} className="rounded-lg border border-border bg-card px-2.5 py-2 text-xs">
                  <summary className="flex cursor-pointer items-center justify-between text-muted-foreground">
                    <span>{fmtDate(r.created_at ?? "")}</span>
                    <Badge variant={r.level === "L2 建议" ? "warn" : "ok"}>{r.level}</Badge>
                  </summary>
                  <div className="mt-1.5 whitespace-pre-wrap text-foreground">{r.answer}</div>
                </details>
              ))}
            </div>
          )}
        </details>
      </Section>)}

      {/* 数据 */}
      {active === "data" && (
      <Section title="数据与状态" icon={<ShieldCheck className="w-4 h-4 text-muted-foreground" />}>
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>行情来源</span><span className="text-right text-foreground">{bootstrap.source.quotes}</span>
            <span>组合数据</span><span className="text-right text-foreground">{bootstrap.source.portfolio}</span>
            <span>模型</span>
            <span className="text-right text-foreground">
              {bootstrap.health.llm_configured ? bootstrap.health.model : "未配置（内置分析）"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              {bootstrap.source.seeded ? "当前为示例数据，可到「记账」改成自己的真实数据。" : "当前是你的真实数据。"}
            </div>
            <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
              恢复示例数据
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">导出全部数据为 JSON 备份（AI Key 已自动脱敏）</div>
            <Button variant="outline" size="sm" onClick={() => void exportBackup()}>
              <Download className="w-3.5 h-3.5" /> 导出备份
            </Button>
          </div>
        </div>
      </Section>)}

      {/* 访问口令 */}
      {active === "token" && (
      <Section title="访问口令" icon={<KeyRound className="w-4 h-4 text-muted-foreground" />}>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className={labelCls}>浏览器端口令（留空清除）</label>
            <input className={inputCls} type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="后端 API_TOKEN 相同时才有效" />
          </div>
          <Button size="sm" onClick={() => { setToken(tokenInput.trim()); toast("口令已更新", "ok"); }}>
            保存
          </Button>
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          未在服务端设置 API_TOKEN 时无需口令；公网部署请务必设置。
        </div>
      </Section>)}

      {/* 全局保存只覆盖「账本规则 / 每日晨报」的表单字段；其余界面各自即存或有独立保存按钮 */}
      {(active === "rules" || active === "report") && (
        <Button className="w-full" onClick={() => void save()} disabled={saving}>
          {saving ? "保存中…" : "保存设置"}
        </Button>
      )}
      </motion.div>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="恢复示例数据"
        description="恢复示例数据会覆盖当前的持仓、流水与负债，确定吗？"
        confirmText="恢复"
        danger
        onConfirm={() => void resetSeed()}
      />
    </div>
  );
}
