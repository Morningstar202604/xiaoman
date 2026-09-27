import { useState } from "react";
import { Plus, Target, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createGoal, deleteGoal, updateGoal } from "@/lib/api";
import { fmtMoney } from "@/lib/format";
import type { Goal } from "@/lib/types";

const labelCls = "block text-xs text-muted-foreground mb-1";
const inputCls =
  "w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

/** 目标进度条（按完成比例着色） */
function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = pct >= 100 ? "bg-down" : pct >= 50 ? "bg-primary" : "bg-amber-500";
  return (
    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
      <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function GoalsPanel({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ name: "", target: "", saved: "", deadline: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr("");
    if (!f.name.trim() || !Number(f.target)) {
      setErr("名称与目标金额必填");
      return;
    }
    setBusy(true);
    try {
      await createGoal({
        name: f.name.trim(),
        target: Number(f.target),
        saved: f.saved ? Number(f.saved) : 0,
        deadline: f.deadline.trim(),
      });
      setF({ name: "", target: "", saved: "", deadline: "" });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={labelCls}>目标名称</label>
          <input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="买房首付 / 应急金 10 万" />
        </div>
        <div>
          <label className={labelCls}>目标金额（元）</label>
          <input className={inputCls} type="number" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} placeholder="200000" />
        </div>
        <div>
          <label className={labelCls}>已存金额（元，可留空）</label>
          <input className={inputCls} type="number" value={f.saved} onChange={(e) => setF({ ...f, saved: e.target.value })} placeholder="50000" />
        </div>
        <div>
          <label className={labelCls}>目标月份 YYYY-MM（可留空）</label>
          <input className={inputCls} value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} placeholder="2027-06" />
        </div>
      </div>
      {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
      <Button size="sm" onClick={() => void submit()} disabled={busy || !f.name || !f.target}>
        <Plus className="w-3.5 h-3.5" /> 添加目标
      </Button>
    </div>
  );
}

/** 目标列表：进度 + 建议月存 + 快捷追加 + 删除 */
export function GoalsList({ goals, onDone }: { goals: Goal[]; onDone: () => void }) {
  const [busy, setBusy] = useState("");

  const bump = async (name: string, amount: number) => {
    setBusy(name);
    try {
      const g = goals.find((x) => x.name === name);
      if (g) await updateGoal(name, { saved: Math.max(0, g.saved + amount) });
      onDone();
    } catch {
      /* 静默：下次刷新恢复 */
    } finally {
      setBusy("");
    }
  };

  if (goals.length === 0) {
    return (
      <div className="py-4 text-center text-sm text-muted-foreground">
        还没有财务目标。设一个「买房首付」「应急金 10 万」之类的目标，问答和体检都会带上它。
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {goals.map((g) => (
        <div key={g.name} className="rounded-lg border border-border bg-card px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-sm font-medium min-w-0">
              <Target className="w-3.5 h-3.5 text-primary shrink-0" />
              <span className="truncate">{g.name}</span>
              {g.done && <Badge variant="ok">已达成</Badge>}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums shrink-0">
              {fmtMoney(g.saved, false)} / {fmtMoney(g.target, false)}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="flex-1">
              <ProgressBar pct={g.pct} />
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{g.pct}%</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {g.months_left != null && g.monthly_suggest != null
                ? `距 ${g.deadline} 还有 ${g.months_left} 个月，建议月存 ${fmtMoney(g.monthly_suggest, false)}`
                : g.deadline
                  ? `截止 ${g.deadline}`
                  : "未设截止时间"}
              {g.gap > 0 && ` · 还差 ${fmtMoney(g.gap, false)}`}
            </span>
            <span className="flex items-center gap-1 shrink-0">
              <Button size="sm" variant="outline" className="h-6 px-2" disabled={busy === g.name} onClick={() => void bump(g.name, 1000)}>
                +1k
              </Button>
              <Button size="sm" variant="outline" className="h-6 px-2" disabled={busy === g.name} onClick={() => void bump(g.name, -1000)}>
                -1k
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-muted-foreground hover:text-red-600"
                aria-label={`删除目标 ${g.name}`}
                onClick={() => void deleteGoal(g.name).then(onDone)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
