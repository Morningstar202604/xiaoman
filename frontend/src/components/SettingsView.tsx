import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Brain, BrainCog, Download, KeyRound, Newspaper, PiggyBank, Plus, RefreshCw, ShieldCheck, SlidersHorizontal, Trash2, Upload, Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/segmented";
import { ConfirmDialog } from "@/components/ui/confirm";
import { useTheme } from "@/lib/theme";
import { api, addMemory, clearMemory, deleteMemory, getToken, listMemory, setToken } from "@/lib/api";
import { store } from "@/lib/store";
import { useToast } from "@/lib/toast";
import { BRAND } from "@/lib/brand";
import { useI18n } from "@/lib/i18n";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MemoryItem, RunRecord } from "@/lib/types";

const inputCls =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const labelCls = "block text-xs text-muted-foreground mb-1";

/** 国产供应商预设（与后端 app/llm.py PROVIDERS 一致）：快捷选择自动填入 base/model */
const PRESET_PROVIDERS = {
  deepseek: { base: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  doubao: { base: "https://ark.cn-beijing.volces.com/api/v3", model: "" },
  qwen: { base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
} as const;
type ProviderKey = keyof typeof PRESET_PROVIDERS | "custom";

type SectionId = "prefs" | "rules" | "budget" | "ai" | "report" | "data" | "memory" | "token";

const SECTIONS: { id: SectionId; labelKey: string; icon: typeof Wallet }[] = [
  { id: "prefs", labelKey: "settings.navPrefs", icon: SlidersHorizontal },
  { id: "rules", labelKey: "settings.navRules", icon: Wallet },
  { id: "budget", labelKey: "settings.navBudget", icon: PiggyBank },
  { id: "ai", labelKey: "settings.navAi", icon: Brain },
  { id: "report", labelKey: "settings.navReport", icon: Newspaper },
  { id: "memory", labelKey: "settings.navMemory", icon: BrainCog },
  { id: "data", labelKey: "settings.navData", icon: ShieldCheck },
  { id: "token", labelKey: "settings.navToken", icon: KeyRound },
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

/** 长期记忆：AI 问答会先查这里，把用户长期信息记在这里即可全局生效 */
function MemorySection() {
  const { t } = useI18n();
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const { toast } = useToast();

  const reload = useCallback(async () => {
    try {
      setItems(await listMemory());
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submit = async () => {
    setErr("");
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await addMemory(text.trim());
      setText("");
      toast(r.deduped ? t("settings.memDup") : t("settings.memSaved"), "ok");
      void reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("settings.navMemory")} icon={<BrainCog className="w-4 h-4 text-muted-foreground" />} desc={t("settings.memDesc")}>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className={labelCls}>{t("settings.memNew")}</label>
          <input
            className={inputCls}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder={t("settings.memPh")}
            maxLength={500}
          />
        </div>
        <Button size="sm" onClick={() => void submit()} disabled={busy || !text.trim()}>
          <Plus className="w-3.5 h-3.5" /> {t("settings.memSave")}
        </Button>
      </div>
      {err && <div className="mt-1 text-xs text-red-600 dark:text-red-400">{err}</div>}

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {items == null ? t("settings.loading") : items.length === 0 ? t("settings.memEmpty") : t("settings.memCount", { n: items.length })}
        </span>
        {items && items.length > 0 && (
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setClearOpen(true)}>
            {t("settings.memClear")}
          </Button>
        )}
      </div>

      {items && items.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {items.map((m) => (
            <li key={m.id} className="flex items-start justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block break-words">{m.content}</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {m.kind !== "fact" ? `${m.kind} · ` : ""}{t("settings.memUpdated")} {fmtDate(m.updated_at)}
                </span>
              </span>
              <button
                className="shrink-0 text-muted-foreground hover:text-red-600"
                onClick={() => void deleteMemory(m.id).then(reload)}
                aria-label={t("settings.memDelete", { c: m.content })}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={clearOpen}
        title={t("settings.memClearTitle")}
        description={t("settings.memClearDesc")}
        confirmText={t("settings.memClear")}
        danger
        onOpenChange={setClearOpen}
        onConfirm={() => {
          void clearMemory().then(() => {
            setClearOpen(false);
            toast(t("settings.memCleared"), "ok");
            void reload();
          });
        }}
      />
    </Section>
  );
}

export function SettingsView() {
  const { t, lang, setLang } = useI18n();
  const { bootstrap } = store.useApp();
  const { toast } = useToast();
  const theme = useTheme();

  const { theme: themeMode, setTheme } = theme;

  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<SectionId>("prefs");
  const [resetOpen, setResetOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState(getToken());
  const [providerSel, setProviderSel] = useState<ProviderKey>("custom");
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
      toast(t("settings.budgetSaved"), "ok");
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
    return <div className="p-8 text-center text-sm text-muted-foreground">{t("settings.loading")}</div>;
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
        toast(`${t("settings.saveFail")}: ${res.errors.join("; ")}`, "error");
      } else {
        toast(t("settings.saved"), "ok");
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
          toast(`${t("settings.saveFail")}: ${res.errors.join("; ")}`, "error");
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
    toast(t("settings.demoRestored"), "ok");
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
        toast(`${t("settings.saveFail")}: ${res.errors.join("; ")}`, "error");
        return;
      }
      await store.refreshBootstrap();
      store.bump();
      toast(t("settings.aiSaved"), "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const [pendingImport, setPendingImport] = useState<File | null>(null);
  const [backupPass, setBackupPass] = useState("");

  const exportBackup = async () => {
    try {
      const pass = backupPass.trim();
      if (!pass && !window.confirm(t("settings.exportPlainWarn"))) {
        return;
      }
      const data = await api<Record<string, unknown>>(pass ? `/api/export?passphrase=${encodeURIComponent(pass)}` : "/api/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${BRAND.name}-backup-${new Date().toISOString().slice(0, 10)}${pass ? "-encrypted" : ""}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(pass ? t("settings.backupEncrypted") : t("settings.backupDownloaded"), "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const importBackup = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
      const encrypted = (parsed as { encrypted?: boolean }).encrypted === true;
      if (encrypted && !backupPass.trim()) {
        toast(t("settings.backupNeedPass"), "error");
        return;
      }
      const body = encrypted ? { ...parsed, passphrase: backupPass.trim() } : parsed;
      const r = await api<{ counts: Record<string, number> }>("/api/import/backup", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const c = r.counts;
      const parts = [
        `${t("settings.pos")} ${c.positions ?? 0}`,
        `${t("settings.tx")} ${c.transactions ?? 0}`,
        `${t("settings.sub")} ${c.subscriptions ?? 0}`,
        `${t("settings.debt")} ${c.debts ?? 0}`,
      ].filter((p) => Number(p.split(" ")[1]) > 0);
      toast(
        parts.length ? t("settings.restoreDone", { p: parts.join(", ") }) : t("settings.restoreDoneEmpty"),
        "ok",
      );
      await store.refreshBootstrap();
      await store.refreshDashboard();
      await store.refreshSessions();
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
              <span className="truncate">{t(s.labelKey)}</span>
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
      <Section title={t("settings.navPrefs")} icon={<SlidersHorizontal className="w-4 h-4 text-muted-foreground" />} desc={t("settings.prefsDesc")}>
        <div className="flex items-center justify-between">
          <span className="text-sm">{t("settings.theme")}</span>
          <Segmented
            value={themeMode}
            onChange={setTheme}
            options={[
              { value: "light", label: t("settings.light") },
              { value: "dark", label: t("settings.dark") },
              { value: "system", label: t("settings.system") },
            ]}
          />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <div>
            <div className="text-sm">{t("settings.voice")}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{t("settings.voiceHint")}</div>
          </div>
          <Switch checked={form.voice_input === "on"} onChange={() => toggle("voice_input")} label={t("settings.voice")} />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <div>
            <div className="text-sm">{t("settings.language")}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{t("settings.languageHint")}</div>
          </div>
          <div className="flex gap-1.5">
            {(["en", "zh"] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium border transition-colors",
                  lang === l ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {l === "en" ? "English" : "中文"}
              </button>
            ))}
          </div>
        </div>
        {/* 涨跌颜色：A股红涨绿跌 / 海外绿涨红跌 */}
        <div className="mt-3 flex items-center justify-between">
          <div>
            <div className="text-sm">{t("settings.colorScheme")}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{t("settings.colorSchemeHint")}</div>
          </div>
          <Segmented
            value={form.color_scheme ?? "cn"}
            onChange={(v) => set("color_scheme", v)}
            options={[
              { value: "cn", label: t("settings.cnScheme") },
              { value: "us", label: t("settings.usScheme") },
            ]}
          />
        </div>
        {/* 默认首页 */}
        <div className="mt-3 flex items-center justify-between">
          <div>
            <div className="text-sm">{t("settings.defaultTab")}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{t("settings.defaultTabHint")}</div>
          </div>
          <Segmented
            value={form.default_tab ?? "overview"}
            onChange={(v) => set("default_tab", v)}
            options={[
              { value: "overview", label: t("nav.dashboard") },
              { value: "holdings", label: t("nav.holdings") },
              { value: "market", label: t("nav.market") },
              { value: "ledger", label: t("nav.ledger") },
              { value: "chat", label: t("nav.chat") },
            ]}
          />
        </div>
      </Section>)}

      {/* 账本假设 */}
      {active === "rules" && (
      <Section title={t("settings.navRules")} icon={<Wallet className="w-4 h-4 text-muted-foreground" />} desc={t("settings.rulesDesc")}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>{t("settings.monthlyIncome")}</label>
            <input className={inputCls} type="number" value={form.monthly_income ?? ""} onChange={(e) => set("monthly_income", e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>{t("settings.emergencyTarget")}</label>
            <input className={inputCls} type="number" value={form.emergency_target_months ?? ""} onChange={(e) => set("emergency_target_months", e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>{t("settings.essentialCats")}</label>
            <input className={inputCls} value={form.essential_categories ?? ""} onChange={(e) => set("essential_categories", e.target.value)} placeholder={t("settings.essentialPh")} />
          </div>
          <div>
            <label className={labelCls}>{t("settings.savingsGoal")}</label>
            <input className={inputCls} type="number" value={form.savings_goal ?? "20"} onChange={(e) => set("savings_goal", e.target.value)} />
          </div>
        </div>
      </Section>)}

      {/* 预算 */}
      {active === "budget" && (
      <Section
        title={t("settings.navBudget")}
        desc={t("settings.budgetDesc")}
      >
        <div className="space-y-3">
          <div>
            <label className={labelCls}>{t("settings.budgetTotal")}</label>
            <input className={inputCls} type="number" min="0" value={budgetTotal} onChange={(e) => setBudgetTotal(e.target.value)} placeholder={t("settings.budgetTotalPh")} />
          </div>
          <div>
            <label className={labelCls}>{t("settings.budgetCats")}</label>
            <textarea
              className={`${inputCls} min-h-24`}
              value={budgetCats}
              onChange={(e) => setBudgetCats(e.target.value)}
              placeholder={t("settings.budgetCatsPh")}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              {budgetTotal ? `${t("settings.budgetTotalLabel")} ¥${budgetTotal}` : t("settings.budgetNone")} · {t("settings.budgetCatCount", { n: budgetCats.trim() ? budgetCats.trim().split("\n").filter((l) => l.trim()).length : 0 })}
            </span>
            <Button variant="outline" size="sm" onClick={() => void saveBudget()} disabled={saving}>
              {t("settings.saveBudget")}
            </Button>
          </div>
        </div>
      </Section>)}

      {/* AI 回答 */}
      {active === "ai" && (
      <Section
        title={t("settings.navAi")}
        icon={<Brain className="w-4 h-4 text-muted-foreground" />}
        desc={t("settings.aiDesc")}
      >
        <div className="space-y-3">
          <Row label={t("settings.aiEnable")} hint={t("settings.aiEnableHint")}>
            <Switch checked={form.ai_enabled === "on"} onChange={() => toggle("ai_enabled")} label={t("settings.aiEnable")} />
          </Row>
          <Row label={t("settings.aiProvider")} hint={t("settings.aiProviderHint")}>
            <Segmented
              value={providerSel}
              onChange={(v) => {
                setProviderSel(v);
                if (v !== "custom") {
                  const p = PRESET_PROVIDERS[v];
                  set("ai_base_url", p.base);
                  set("ai_model", p.model);
                }
              }}
              options={[
                { value: "deepseek", label: "DeepSeek" },
                { value: "doubao", label: "豆包" },
                { value: "qwen", label: "通义" },
                { value: "custom", label: t("settings.aiCustom") },
              ]}
            />
          </Row>
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
            {t("settings.aiPrivacy")}
          </div>
          <div>
            <label className={labelCls}>{t("settings.aiBaseUrl")}</label>
            <input
              className={inputCls}
              value={form.ai_base_url ?? ""}
              onChange={(e) => set("ai_base_url", e.target.value)}
              placeholder="https://api.deepseek.com/v1"
            />
          </div>
          <div>
            <label className={labelCls}>{t("settings.aiKey")}</label>
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
            <label className={labelCls}>{t("settings.aiModel")}</label>
            <input
              className={inputCls}
              value={form.ai_model ?? ""}
              onChange={(e) => set("ai_model", e.target.value)}
              placeholder={t("settings.aiModelPh")}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              {t("settings.current")}: {bootstrap.health.llm_configured ? `${t("settings.aiOn")}（${bootstrap.health.model}）` : t("settings.aiOff")}
            </span>
            <Button variant="outline" size="sm" onClick={() => void saveAi()}>
              {t("settings.saveAi")}
            </Button>
          </div>
        </div>
      </Section>)}

      {/* 每日晨报：默认只留时间 + 立即生成，历史收进折叠 */}
      {active === "report" && (
      <Section title={t("settings.navReport")} icon={<Newspaper className="w-4 h-4 text-muted-foreground" />}>
        <div className="flex items-end gap-2">
          <div className="w-36">
            <label className={labelCls}>{t("settings.reportTime")}</label>
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
                  toast(t("settings.reportNoData"), "error");
                  return;
                }
                toast(r.ok ? t("settings.reportDone") : t("settings.reportFail"), r.ok ? "ok" : "error");
                store.bump();
                void loadReports();
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e), "error");
              }
            }}
          >
            <RefreshCw className="w-3.5 h-3.5" /> {t("settings.reportGenerate")}
          </Button>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          {sc.enabled ? `${t("settings.reportNext")}: ${sc.next_run_at ?? "—"}` : t("settings.reportDisabled")}
          {sc.generated > 0 ? ` · ${t("settings.reportCount", { n: sc.generated })}` : ""}
        </div>
        <details className="mt-3 group">
          <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
            {t("settings.reportHistory")}{reports.length > 0 ? `（${reports.length}）` : ""}
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
        <div className="mt-2 text-[11px] text-muted-foreground">{t("notAdvice")}</div>
      </Section>)}

      {/* 数据 */}
      {/* 长期记忆：AI 记住用户长期信息；可增删清空 */}
      {active === "memory" && <MemorySection />}

      {active === "data" && (
      <Section title={t("settings.navData")} icon={<ShieldCheck className="w-4 h-4 text-muted-foreground" />}>
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{t("settings.srcQuotes")}</span><span className="text-right text-foreground">{bootstrap.source.quotes}</span>
            <span>{t("settings.srcPortfolio")}</span><span className="text-right text-foreground">{bootstrap.source.portfolio}</span>
            <span>{t("settings.srcModel")}</span>
            <span className="text-right text-foreground">
              {bootstrap.health.llm_configured ? bootstrap.health.model : t("settings.modelNone")}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              {bootstrap.source.seeded ? t("settings.demoNote") : t("settings.realNote")}
            </div>
            <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
              {t("settings.restoreDemo")}
            </Button>
          </div>
          <div className="space-y-1.5">
            <input
              type="password"
              value={backupPass}
              onChange={(e) => setBackupPass(e.target.value)}
              placeholder={t("settings.backupPassPh")}
              aria-label={t("settings.backupPassPh")}
              className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              maxLength={64}
            />
            <p className="text-[11px] text-muted-foreground/70">{t("settings.backupPassHint")}</p>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">{t("settings.exportHint")}</div>
            <Button variant="outline" size="sm" onClick={() => void exportBackup()}>
              <Download className="w-3.5 h-3.5" /> {t("settings.exportBackup")}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2 pt-3 border-t border-border/60">
            <div className="text-xs text-muted-foreground">
              {t("settings.importHint")}
            </div>
            <label className="inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-border bg-transparent px-3 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground">
              <Upload className="w-3.5 h-3.5" /> {t("settings.importBackup")}
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) setPendingImport(f);
                }}
              />
            </label>
          </div>
        </div>
      </Section>)}

      {/* 访问口令 */}
      {active === "token" && (
      <Section title={t("settings.navToken")} icon={<KeyRound className="w-4 h-4 text-muted-foreground" />}>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className={labelCls}>{t("settings.tokenInput")}</label>
            <input className={inputCls} type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder={t("settings.tokenPh")} />
          </div>
          <Button size="sm" onClick={() => { setToken(tokenInput.trim()); toast(t("settings.tokenUpdated"), "ok"); }}>
            {t("settings.save")}
          </Button>
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          {t("settings.tokenHint")}
        </div>
      </Section>)}

      {/* 全局保存只覆盖「账本规则 / 每日晨报」的表单字段；其余界面各自即存或有独立保存按钮 */}
      {(active === "rules" || active === "report") && (
        <Button className="w-full" onClick={() => void save()} disabled={saving}>
          {saving ? t("settings.saving") : t("settings.saveSettings")}
        </Button>
      )}
      </motion.div>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={t("settings.restoreDemoTitle")}
        description={t("settings.restoreDemoDesc")}
        confirmText={t("settings.restoreDemo")}
        danger
        onConfirm={() => void resetSeed()}
      />

      <ConfirmDialog
        open={pendingImport !== null}
        onOpenChange={(o) => {
          if (!o) setPendingImport(null);
        }}
        title={t("settings.restoreTitle")}
        description={t("settings.restoreDesc")}
        confirmText={t("settings.restoreDemo")}
        danger
        onConfirm={() => {
          const f = pendingImport;
          setPendingImport(null);
          if (f) void importBackup(f);
        }}
      />
    </div>
  );
}
