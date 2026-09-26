/** 与后端 REST/SSE 契约对应的类型。 */

export interface Position {
  symbol: string;
  name: string;
  kind: string;
  industry: string;
  shares: number;
  last: number;
  market_value: number;
  cost: number;
  pnl: number;
  pnl_pct: number;
}

export interface Transaction {
  id: number;
  date: string;
  item: string;
  category: string;
  amount: number;
}

export interface DebtItem {
  name: string;
  monthly: number;
  balance: number;
  rate: number;
  due_day?: string;
}

export interface RiskFlag {
  level: string;
  code: string;
  text: string;
}

export interface EmergencyInfo {
  cash: number;
  essential_monthly: number;
  essential_categories: string[];
  months_covered: number;
  target_months: number;
  has_data: boolean;
  ok: boolean;
}

export interface DashboardData {
  positions: Position[];
  totals: {
    total_market_value: number;
    total_cost: number;
    total_pnl: number;
    total_pnl_pct: number;
  };
  concentration: {
    threshold_pct: number;
    by_asset: { name: string; kind: string; pct: number }[];
    by_industry: { industry: string; pct: number }[];
  };
  cashflow: {
    month: string;
    income: number;
    expense: number;
    net: number;
    savings_rate: number;
    by_category: { category: string; amount: number }[];
  };
  subscriptions: {
    items: { name: string; monthly: number; note: string; due_day?: string }[];
    monthly_total: number;
    annual_total: number;
  };
  debts: { items: DebtItem[]; monthly_total: number; dti_pct: number };
  emergency: EmergencyInfo;
  flags: RiskFlag[];
  transactions: Transaction[];
  source: { portfolio: string; ledger: string; quotes: string; seeded: boolean };
}

export interface RunRecord {
  id: number;
  thread_id: string;
  question: string;
  answer: string;
  level: string;
  flags: RiskFlag[];
  created_at: string;
  /** 问答来源（2026-09 起随回答落库；更早的历史记录为空字符串 = 未知，不猜） */
  route?: string;
  llm?: string;
  route_reason?: string;
}

export interface SessionItem {
  id: number;
  thread_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface TrendMonth {
  month: string;
  income: number;
  expense: number;
  net: number;
}

export interface BudgetCatUsage {
  category: string;
  budget: number;
  spent: number;
  pct: number;
  over: boolean;
}

export interface BudgetUsage {
  month: string;
  budgets: { category: string; key: string; amount: number }[];
  usage: {
    total_budget: number;
    total_spent: number;
    total_pct: number;
    over: boolean;
    left: number;
    left_daily: number;
    days_left: number;
    categories: BudgetCatUsage[];
  };
}

export interface SchedulerStatus {
  enabled: boolean;
  report_time: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  generated: number;
}

export interface BootstrapData {
  settings: Record<string, string>;
  scheduler: SchedulerStatus;
  health: { llm_configured: boolean; model: string };
  source: DashboardData["source"];
}

export interface AnswerMeta {
  answer: string;
  level: string;
  route: string;
  route_reason: string;
  metrics: Record<string, number>;
  flags: RiskFlag[];
  /** 回答生成来源；历史记录未存来源时为 undefined（不渲染徽标） */
  llm?: "llm" | "template";
}

export type AskEvent =
  | { type: "start"; question: string }
  | { type: "step"; id: string; label: string; detail: string; phase: string }
  | { type: "text"; delta: string }
  | {
      type: "final";
      answer: string;
      level: string;
      route: string;
      route_reason: string;
      metrics: Record<string, number>;
      flags: RiskFlag[];
      llm: "llm" | "template";
    }
  | { type: "error"; message: string }
  | { type: "done" };
