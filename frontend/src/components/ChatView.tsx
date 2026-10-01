import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChevronDown, ChevronUp, Copy, Download, Loader2, MessageCircle, Mic, MicOff, RotateCcw, Search, Send, Square, Sparkles, Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SummaryBlock } from "@/components/SummaryBlock";
import { BrandLogo, BRAND } from "@/lib/brand";
import { api, apiStream } from "@/lib/api";
import { store } from "@/lib/store";
import { useToast } from "@/lib/toast";
import { useI18n } from "@/lib/i18n";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AgentToolStep, AnswerMeta, RunRecord } from "@/lib/types";

interface StepInfo {
  id: string;
  label: string;
  detail: string;
}

/** 工具名 → 用户能看懂的动作（工具名是内部契约，不出口） */
const TOOL_LABEL_KEYS: Record<string, string> = {
  get_market_view: "chat.toolMarket",
  get_ledger_view: "chat.toolLedger",
  get_risk_flags: "chat.toolRisk",
  get_budget: "chat.toolBudget",
  get_trend: "chat.toolTrend",
  record_transaction: "chat.toolRecord",
  get_kline: "chat.toolKline",
};

function toolLabel(tr: (k: string) => string, name: string): string {
  const k = TOOL_LABEL_KEYS[name];
  return k ? tr(k) : name;
}

/** 对话结果的页面跳转意图 → 按钮文案 key（对话中枢：结果一键去对应页面） */
const TAB_ACTION_KEYS: Record<string, string> = {
  overview: "chat.goOverview",
  holdings: "chat.goHoldings",
  market: "chat.goMarket",
  ledger: "chat.goLedger",
  settings: "chat.goSettings",
};

/** 空账本首屏能力清单：对话里一句话能完成的事（点卡片即发送示例） */
const CAP_GROUPS: { titleKey: string; chips: string[] }[] = [
  { titleKey: "chat.capBook", chips: ["chat.capBook1", "chat.capBook2"] },
  { titleKey: "chat.capMarket", chips: ["chat.capMarket1", "chat.capMarket2", "chat.capMarket3"] },
  { titleKey: "chat.capHold", chips: ["chat.capHold1", "chat.capHold2", "chat.capHold3"] },
  { titleKey: "chat.capAct", chips: ["chat.capAct1", "chat.capAct2", "chat.capAct3"] },
  { titleKey: "chat.capSet", chips: ["chat.capSet1", "chat.capSet2", "chat.capSet3"] },
];

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** assistant 消息对应的提问（导出时用） */
  q?: string;
  meta?: AnswerMeta;
  steps: StepInfo[];
  /** agent 模式：模型调用过的工具（实时展示） */
  tools?: AgentToolStep[];
  /** 对话结果附带的跳转意图（对话中枢：结果一键去对应页面） */
  actions?: { tab: string }[];
  error?: string;
  created_at?: string;
}

const BASE_SUGGESTION_KEYS = [
  "chat.sHealth",
  "chat.sSpend",
  "chat.sRisk",
  "chat.sPnl",
];

/** 无数据时的引导建议：不假设用户已有持仓/账本（chat-first 首屏）。 */
/** 默认路径是通用 agent：空态建议体现"什么都能问"，财务与记账只是其中两件事。 */
const GENERIC_SUGGESTION_KEYS = [
  "chat.sGenericPlan",
  "chat.sGenericRewrite",
  "chat.sRecord",
];

/** 依据仪表盘风险项生成针对性追问（贴合当前数据，不是固定文案）。
 *  注意：后端 risk_checks 的 code 全大写（CONCENTRATION 等），这里必须一一对应。 */
function dynamicSuggestions(flags: RunRecord["flags"]): string[] {
  const map: Record<string, string> = {
    CONCENTRATION: "chat.qConcentration",
    HIGH_RATE_DEBT: "chat.qHighRateDebt",
    SAVINGS_RATE: "chat.qSavingsRate",
    EMERGENCY_FUND: "chat.qEmergencyFund",
    DTI: "chat.qDti",
  };
  return flags.slice(0, 2).filter((f) => map[f.code]).map((f) => map[f.code]);
}

let msgSeq = 1;

export function ChatView({
  threadId,
  onNewSession,
  onSwitch,
  onOpenSettings,
  onNavigate,
}: {
  threadId: string;
  onNewSession: () => void;
  /** 切换到另一个会话（桌面走侧栏，移动端走顶部下拉） */
  onSwitch: (threadId: string) => void;
  /** 跳转设置页（未接入 AI 时的引导入口） */
  onOpenSettings: () => void;
  /** 对话中枢：结果附带的跳转意图，一键去对应页面 */
  onNavigate: (tab: string) => void;
}) {
  const { dashboard, bootstrap, sessions } = store.useApp();
  const { toast } = useToast();
  const { t: tr } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const [listening, setListening] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const recogRef = useRef<{ stop: () => void } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 会话本地过滤（量小，无需后端）
  const kw = sessionSearch.trim().toLowerCase();
  const filteredSessions = kw ? sessions.filter((s) => s.title.toLowerCase().includes(kw)) : sessions;

  const settings = bootstrap?.settings ?? {};
  const voiceOn = settings.voice_input === "on";
  const exportOn = settings.show_export === "on";
  const suggestionsOn = settings.show_suggestions === "on";

  const patchMsg = (id: number, patch: Partial<ChatMessage>) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const scrollBottom = () => {
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  // 切换会话：加载该 thread 的历史问答
  useEffect(() => {
    let alive = true;
    setMessages([]);
    setShowSteps((bootstrap?.settings.expand_process ?? "off") === "on");
    api<{ runs: RunRecord[] }>(`/api/history?thread_id=${encodeURIComponent(threadId)}&limit=50`)
      .then((d) => {
        if (!alive) return;
        const loaded: ChatMessage[] = (d.runs ?? [])
          .slice()
          .reverse()
          .flatMap((r) => [
            { id: msgSeq++, role: "user" as const, text: r.question, steps: [], tools: [] },
            {
              id: msgSeq++,
              role: "assistant" as const,
              text: r.answer,
              q: r.question,
              steps: [],
              tools: [],
              // 来源随回答落库（route/llm/route_reason）：有就显示真实来源，
              // 旧记录或空值一律留空 —— 拿不到就不说，不猜。
              meta: {
                answer: r.answer,
                level: r.level,
                route: r.route ?? "",
                route_reason: r.route_reason ?? "",
                metrics: {},
                flags: r.flags,
                llm: (r.llm || undefined) as "llm" | "template" | undefined,
                tools: r.tools ?? [],
              },
              actions: r.actions ?? [],
              created_at: r.created_at,
            },
          ]);
        setMessages(loaded);
        requestAnimationFrame(() =>
          listRef.current?.scrollTo({ top: listRef.current.scrollHeight }),
        );
      })
      .catch(() => {
        /* 历史加载失败不影响提问 */
      });
    return () => {
      alive = false;
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // 桌面端自动聚焦输入框：打开 / 切换会话后即可直接打字（移动端不弹键盘）
  useEffect(() => {
    if (window.matchMedia("(min-width: 768px)").matches) {
      inputRef.current?.focus();
    }
  }, [threadId]);

  const send = async (text: string, opts?: { regenerate?: boolean }) => {
    const q = text.trim();
    if (!q || busy) return;
    const regen = opts?.regenerate ?? false;

    if (!regen) setInput("");
    setBusy(true);

    let asstMsg: ChatMessage;
    if (regen) {
      // 重新生成：替换最后一条回答（原用户消息保留）
      asstMsg = { id: msgSeq++, role: "assistant", text: "", q, steps: [], tools: [] };
      setMessages((prev) => {
        const out = [...prev];
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i].role === "assistant") {
            out[i] = asstMsg;
            break;
          }
        }
        return out;
      });
    } else {
      const userMsg: ChatMessage = { id: msgSeq++, role: "user", text: q, steps: [], tools: [] };
      asstMsg = { id: msgSeq++, role: "assistant", text: "", q, steps: [], tools: [] };
      setMessages((prev) => [...prev, userMsg, asstMsg]);
    }
    scrollBottom();

    const controller = new AbortController();
    abortRef.current = controller;
    const acc = { text: "", steps: [] as StepInfo[], tools: [] as AgentToolStep[] };

    try {
      await apiStream(
        "/api/ask",
        { question: q, thread_id: threadId, regenerate: regen, lang: tr("chat.locale") },
        (ev) => {
          switch (ev.type) {
            case "text":
              acc.text += String(ev.delta ?? "");
              patchMsg(asstMsg.id, { text: acc.text });
              break;
            case "agent_step":
              acc.tools.push({
                name: String(ev.name),
                args: (ev.args as Record<string, unknown>) ?? {},
                summary: String(ev.summary ?? ""),
              });
              patchMsg(asstMsg.id, { tools: [...acc.tools] });
              break;
            case "step":
              if (ev.phase === "done") {
                acc.steps.push({ id: String(ev.id), label: String(ev.label), detail: String(ev.detail) });
                patchMsg(asstMsg.id, { steps: [...acc.steps] });
              }
              break;
            case "final":
              acc.text = String(ev.answer ?? acc.text);
              patchMsg(asstMsg.id, {
                text: acc.text,
                meta: {
                  answer: acc.text,
                  level: String(ev.level ?? "L1 洞察"),
                  route: String(ev.route ?? ""),
                  route_reason: String(ev.route_reason ?? ""),
                  metrics: (ev.metrics as Record<string, number>) ?? {},
                  flags: (ev.flags as AnswerMeta["flags"]) ?? [],
                  llm: (ev.llm as "llm" | "template") ?? "template",
                  tools: (ev.tools as string[] | undefined) ?? [],
                },
                actions: (ev.actions as { tab: string }[] | undefined) ?? [],
              });
              break;
            case "error":
              patchMsg(asstMsg.id, { error: String(ev.message) });
              break;
          }
          scrollBottom();
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        patchMsg(asstMsg.id, { error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      store.bump();
    }
  };

  const stop = () => abortRef.current?.abort();

  const toggleVoice = () => {
    const w = window as unknown as Record<string, unknown>;
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) {
      toast(tr("chat.voiceUnsupported"), "info");
      return;
    }
    if (listening) {
      recogRef.current?.stop();
      setListening(false);
      return;
    }
    try {
      const rec = new (SR as new () => {
        lang: string;
        interimResults: boolean;
        onresult: ((e: unknown) => void) | null;
        onend: (() => void) | null;
        onerror: (() => void) | null;
        start: () => void;
        stop: () => void;
      })();
      rec.lang = "zh-CN";
      rec.interimResults = false;
      rec.onresult = (e: unknown) => {
        const ev = e as { results: ArrayLike<ArrayLike<{ transcript: string }>> };
        const t = ev.results[0]?.[0]?.transcript ?? "";
        if (t) setInput((v) => (v ? `${v}${t}` : t));
      };
      rec.onend = () => setListening(false);
      rec.onerror = () => setListening(false);
      recogRef.current = rec;
      rec.start();
      setListening(true);
      toast(tr("chat.voiceListening"), "info");
    } catch {
      setListening(false);
      toast(tr("chat.voiceFail"), "error");
    }
  };

  /** 把「问题 + 回答」导出为 Markdown（复制 / 下载） */
  const exportAnswer = async (m: ChatMessage, action: "copy" | "download") => {
    const md = [
      `# ${BRAND.name} · Q&A Log`,
      ``,
      `**Q**: ${m.q ?? ""}`,
      ``,
      `**Time**: ${new Date().toLocaleString(tr("chat.locale") === "zh" ? "zh-CN" : "en-US")}`,
      ``,
      `---`,
      ``,
      m.text,
      ``,
      `---`,
      ``,
      `*${tr("chat.mdFooter", { name: BRAND.name })}*`,
    ].join("\n");
    try {
      if (action === "copy") {
        await navigator.clipboard.writeText(md);
        toast(tr("chat.copied"), "ok");
      } else {
        const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${BRAND.name}-${new Date().toISOString().slice(0, 10)}.md`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast(tr("chat.downloaded"), "ok");
      }
    } catch {
      toast(tr("chat.exportFail"), "error");
    }
  };

  // chat-first：有无数据决定首屏话术与建议（无数据时不做持仓/账本假设）
  const hasData =
    (dashboard?.positions.length ?? 0) > 0 || (dashboard?.transactions.length ?? 0) > 0;
  const suggestions = suggestionsOn
    ? hasData
      ? [...dynamicSuggestions(dashboard?.flags ?? []), ...BASE_SUGGESTION_KEYS].slice(0, 6)
      : GENERIC_SUGGESTION_KEYS
    : [];

  return (
    <div className="flex flex-col h-full">
      {/* 会话头：点当前会话可切换（移动端无侧栏，这是唯一入口）；移动端压缩高度把版面留给对话 */}
      <div className="relative flex items-center justify-between gap-2 px-4 py-2 border-b border-border/60 py-1.5 sm:py-2">
        <div className="relative min-w-0">
          <button
            type="button"
            className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground"
            onClick={() => setShowSessions((v) => !v)}
          >
            <MessageCircle className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{tr("chat.currentSession")}</span>
            <ChevronDown className={cn("w-3 h-3 shrink-0 transition-transform", showSessions && "rotate-180")} />
          </button>
          {showSessions && (
            <>
              <div
                className="fixed inset-0 z-20"
                onClick={() => setShowSessions(false)}
                aria-hidden
              />
              <div className="absolute left-0 top-full mt-1 z-30 w-72 max-h-80 overflow-y-auto scroll-thin rounded-xl border border-border bg-card shadow-lift p-1.5">
                {sessions.length > 3 && (
                  <div className="relative px-1 pt-1 pb-1.5">
                    <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                    <input
                      type="search"
                      value={sessionSearch}
                      onChange={(e) => setSessionSearch(e.target.value)}
                      placeholder={tr("sidebar.searchSession")}
                      aria-label={tr("sidebar.searchSession")}
                      className="w-full rounded-lg border border-input bg-background pl-8 pr-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                )}
                {filteredSessions.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    {sessionSearch.trim() ? tr("sidebar.noMatch") : tr("sidebar.noSessions")}
                  </div>
                ) : (
                  filteredSessions.slice(0, 30).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={cn(
                        "w-full text-left truncate rounded-lg px-2.5 py-2 text-sm",
                        s.thread_id === threadId
                          ? "bg-accent text-accent-foreground font-medium"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                      onClick={() => {
                        setShowSessions(false);
                        if (s.thread_id !== threadId) onSwitch(s.thread_id);
                      }}
                    >
                      {s.title}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onNewSession}>
          <Sparkles className="w-3.5 h-3.5" /> {tr("chat.newSession")}
        </Button>
      </div>

      {/* 消息列表 */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scroll-thin">
        {messages.length === 0 && (
          <div className="pt-10 sm:pt-14 text-center">
            <div className="flex justify-center mb-5">
              <BrandLogo size={44} />
            </div>
            {hasData ? (
              <>
                {/* 大标题收紧字距、拉开层级：标题本身参与构图，不只是放大的正文 */}
                <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight leading-[1.2] text-balance">
                  {tr("chat.heroQuestion")}
                </h1>
                <p className="mt-2 text-sm text-muted-foreground max-w-xs mx-auto leading-relaxed text-balance">
                  {tr("chat.heroDesc")}
                </p>
              </>
            ) : (
              <>
                <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight leading-[1.2] text-balance">
                  {tr("chat.heroTitle", { name: BRAND.name })}
                </h1>
                <p className="mt-2 text-sm text-muted-foreground max-w-xs mx-auto leading-relaxed text-balance">
                  {tr("chat.heroEmptyDesc")}
                </p>
                {/* 对话中枢：空账本首屏能力清单，点卡片即发送示例指令 */}
                <div className="mt-6 mx-auto grid max-w-md grid-cols-2 gap-2 text-left">
                  {CAP_GROUPS.map((g) => (
                    <div key={g.titleKey} className="rounded-xl border border-border bg-card p-3">
                      <div className="text-[11px] font-medium text-muted-foreground">{tr(g.titleKey)}</div>
                      <div className="mt-1.5 flex flex-col items-start gap-1">
                        {g.chips.map((c) => (
                          <button
                            key={c}
                            type="button"
                            disabled={busy}
                            onClick={() => void send(tr(c))}
                            className="text-left text-xs text-foreground/90 transition-colors hover:text-primary disabled:opacity-50"
                          >
                            {tr(c)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {suggestions.length > 0 && (
              <div className="mt-5 flex flex-col gap-2 max-w-sm mx-auto">
                {suggestions.map((sk) => (
                  <Button key={sk} variant="outline" onClick={() => send(tr(sk))} disabled={busy}>
                    {tr(sk)}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div className={m.role === "user" ? "max-w-[85%]" : "max-w-full w-full"}>
              {m.role === "user" ? (
                <div className="inline-block rounded-2xl rounded-br-md bg-primary text-primary-foreground px-4 py-2 text-sm shadow-xs">
                  {m.text}
                </div>
              ) : (
                /* 账本的行：左侧一条竖线标来源，正文直接落在页面上，不再套白卡 */
                <div className="border-l-2 border-border pl-3.5 sm:pl-4">
                  {m.error ? (
                    <div className="text-sm text-red-600 dark:text-red-400">{tr("chat.error")}: {m.error}</div>
                  ) : m.text === "" ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" /> {tr("chat.analyzing")}
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          {m.meta?.llm === "llm" && <Badge variant="default">{tr("chat.badgeAi")}</Badge>}
                          {m.meta?.llm === "template" && <Badge variant="muted">{tr("chat.badgeRule")}</Badge>}
                          <span>{m.created_at ? fmtDate(m.created_at) : tr("chat.justNow")}</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <button
                            type="button"
                            className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
                            aria-label={tr("chat.regenerate")}
                            title={tr("chat.regenerate")}
                            disabled={busy}
                            onClick={() => void send(m.q ?? "", { regenerate: true })}
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                          {exportOn && (
                            <>
                              <button
                                type="button"
                                className="p-1 text-muted-foreground hover:text-foreground"
                                aria-label={tr("chat.copyMd")}
                                onClick={() => void exportAnswer(m, "copy")}
                              >
                                <Copy className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                className="p-1 text-muted-foreground hover:text-foreground"
                                aria-label={tr("chat.downloadMd")}
                                onClick={() => void exportAnswer(m, "download")}
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </span>
                      </div>
                      <div className="max-w-none text-sm leading-relaxed text-foreground">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                      </div>
                      {m.meta && m.meta.route !== "general" && m.meta.route !== "nl_add" && (
                        <SummaryBlock meta={m.meta} />
                      )}
                      {m.actions && m.actions.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          {m.actions.map((a, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => onNavigate(a.tab)}
                              className="rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-[11px] text-primary transition-colors hover:bg-primary/10"
                            >
                              {tr(TAB_ACTION_KEYS[a.tab] ?? "chat.goOverview")}
                            </button>
                          ))}
                        </div>
                      )}
                      {m.tools && m.tools.length > 0 && (
                        <div className="mt-2.5 space-y-1 border-l-2 border-primary/30 pl-2.5">
                          {m.tools.map((t, i) => (
                            <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                              <Wrench className="w-3.5 h-3.5 shrink-0 text-primary mt-0.5" />
                              <span>
                                <b className="text-foreground/80">{toolLabel(tr, t.name)}</b>
                                {t.summary ? <span className="ml-1">{t.summary}</span> : null}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {m.steps.length > 0 && (
                        <div className="mt-3">
                          <button
                            type="button"
                            className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground"
                            onClick={() => setShowSteps((v) => !v)}
                          >
                            {tr("chat.viewSteps")}
                            {showSteps ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          </button>
                          {showSteps && (
                            <ul className="mt-2 space-y-1.5">
                              {m.steps.map((s, i) => (
                                <li key={i} className="text-xs text-muted-foreground flex gap-1.5">
                                  <span className="text-primary shrink-0">✓</span>
                                  <span>
                                    <b className="text-foreground/80">{s.label}</b>
                                    <span className="ml-1">{s.detail}</span>
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 输入区 */}
      <div className="border-t border-border bg-card/80 backdrop-blur px-3 py-3">
        {!bootstrap?.health?.llm_configured && (
          /* 移动端只留一句（横幅曾占两行、挤掉输入区），完整说明留给 ≥sm */
          <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            <span className="min-w-0">
              <span className="sm:hidden">{tr("chat.noAiShort")}</span>
              <span className="hidden sm:inline">
                {tr("chat.noAiLong")}
              </span>
            </span>
            <Button variant="outline" size="sm" className="h-6 shrink-0 px-2" onClick={onOpenSettings}>
              {tr("chat.goSetup")}
            </Button>
          </div>
        )}
        {/* 快捷指令：一条龙工作流的入口（搜→看→自选→分析，一句话直达） */}
        <div className="mb-2 flex gap-1.5 overflow-x-auto scroll-thin pb-0.5">
          {[
            "chat.chipAnalyze",
            "chat.chipWatch",
            "chat.chipMyWatch",
            "chat.chipLedger",
          ].map((sk) => (
            <button
              key={sk}
              type="button"
              disabled={busy}
              onClick={() => void send(tr(sk))}
              className="shrink-0 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-50"
            >
              {tr(sk)}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          {voiceOn && (
            <Button
              variant={listening ? "default" : "ghost"}
              size="icon"
              aria-label={tr("chat.voiceInput")}
              onClick={toggleVoice}
              className={listening ? "animate-pulse-ring" : ""}
            >
              {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </Button>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={1}
            placeholder={tr("chat.inputPh")}
            className="flex-1 resize-none rounded-xl border border-input bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[44px] max-h-32"
          />
          {busy ? (
            <Button size="icon" variant="outline" onClick={stop} aria-label={tr("chat.stop")}>
              <Square className="w-4 h-4" />
            </Button>
          ) : (
            <Button size="icon" onClick={() => send(input)} disabled={!input.trim()}>
              <Send className="w-4 h-4" />
            </Button>
          )}
        </div>
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          {tr("chat.inputHint")}{voiceOn ? tr("chat.voiceHint") : ""}
        </div>
      </div>
    </div>
  );
}
