import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChevronDown, ChevronUp, Copy, Download, Loader2, MessageCircle, Mic, MicOff, RotateCcw, Search, Send, Square, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SummaryBlock } from "@/components/SummaryBlock";
import { BrandLogo, BRAND } from "@/lib/brand";
import { api, apiStream } from "@/lib/api";
import { store } from "@/lib/store";
import { useToast } from "@/lib/toast";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AnswerMeta, RunRecord } from "@/lib/types";

interface StepInfo {
  id: string;
  label: string;
  detail: string;
}

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** assistant 消息对应的提问（导出时用） */
  q?: string;
  meta?: AnswerMeta;
  steps: StepInfo[];
  error?: string;
  created_at?: string;
}

const BASE_SUGGESTIONS = [
  "我这个月的钱都花到哪了？",
  "帮我看看持仓有什么风险",
  "我的组合现在赚还是亏？",
];

/** 无数据时的引导建议：不假设用户已有持仓/账本（chat-first 首屏）。 */
const GENERIC_SUGGESTIONS = [
  "这个月怎么省钱，有什么建议？",
  "一句话记账怎么用？",
  "支持哪些方式导入账单？",
];

/** 依据仪表盘风险项生成针对性追问（贴合当前数据，不是固定文案）。
 *  注意：后端 risk_checks 的 code 全大写（CONCENTRATION 等），这里必须一一对应。 */
function dynamicSuggestions(flags: RunRecord["flags"]): string[] {
  const map: Record<string, string> = {
    CONCENTRATION: "持仓太集中，怎么分散风险？",
    HIGH_RATE_DEBT: "高息负债怎么还更划算？",
    SAVINGS_RATE: "储蓄率偏低，怎么改善？",
    EMERGENCY_FUND: "应急金不足，怎么补？",
    DTI: "负债收入比偏高，需要注意什么？",
  };
  const out: string[] = [];
  for (const f of flags.slice(0, 2)) {
    if (map[f.code]) out.push(map[f.code]);
  }
  return out;
}

let msgSeq = 1;

export function ChatView({
  threadId,
  onNewSession,
  onSwitch,
  onOpenSettings,
}: {
  threadId: string;
  onNewSession: () => void;
  /** 切换到另一个会话（桌面走侧栏，移动端走顶部下拉） */
  onSwitch: (threadId: string) => void;
  /** 跳转设置页（未接入 AI 时的引导入口） */
  onOpenSettings: () => void;
}) {
  const { dashboard, bootstrap, sessions } = store.useApp();
  const { toast } = useToast();
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
            { id: msgSeq++, role: "user" as const, text: r.question, steps: [] },
            {
              id: msgSeq++,
              role: "assistant" as const,
              text: r.answer,
              q: r.question,
              steps: [],
              // 历史 runs 存了 level/flags（真实数据），但没存 route/llm 来源：
              // 因此只带 level 与 flags，来源留空 → 前端不会显示无法证明的「由规则算出」
              meta: {
                answer: r.answer,
                level: r.level,
                route: "",
                route_reason: "",
                metrics: {},
                flags: r.flags,
              },
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

  const send = async (text: string, opts?: { regenerate?: boolean }) => {
    const q = text.trim();
    if (!q || busy) return;
    const regen = opts?.regenerate ?? false;

    if (!regen) setInput("");
    setBusy(true);

    let asstMsg: ChatMessage;
    if (regen) {
      // 重新生成：替换最后一条回答（原用户消息保留）
      asstMsg = { id: msgSeq++, role: "assistant", text: "", q, steps: [] };
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
      const userMsg: ChatMessage = { id: msgSeq++, role: "user", text: q, steps: [] };
      asstMsg = { id: msgSeq++, role: "assistant", text: "", q, steps: [] };
      setMessages((prev) => [...prev, userMsg, asstMsg]);
    }
    scrollBottom();

    const controller = new AbortController();
    abortRef.current = controller;
    const acc = { text: "", steps: [] as StepInfo[] };

    try {
      await apiStream(
        "/api/ask",
        { question: q, thread_id: threadId, regenerate: regen },
        (ev) => {
          switch (ev.type) {
            case "text":
              acc.text += String(ev.delta ?? "");
              patchMsg(asstMsg.id, { text: acc.text });
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
                },
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
      toast("当前浏览器不支持语音输入（建议使用 Chrome/Edge）", "info");
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
      toast("正在聆听，请说话…", "info");
    } catch {
      setListening(false);
      toast("语音输入启动失败", "error");
    }
  };

  /** 把「问题 + 回答」导出为 Markdown（复制 / 下载） */
  const exportAnswer = async (m: ChatMessage, action: "copy" | "download") => {
    const md = [
      `# 随身理财 · 问答记录`,
      ``,
      `**问题**：${m.q ?? ""}`,
      ``,
      `**时间**：${new Date().toLocaleString("zh-CN")}`,
      ``,
      `---`,
      ``,
      m.text,
      ``,
      `---`,
      ``,
      `*由随身理财（${BRAND.tagline}）基于你的本地数据生成，不构成投资建议。*`,
    ].join("\n");
    try {
      if (action === "copy") {
        await navigator.clipboard.writeText(md);
        toast("已复制到剪贴板", "ok");
      } else {
        const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `随身理财-${new Date().toISOString().slice(0, 10)}.md`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast("已下载 Markdown", "ok");
      }
    } catch {
      toast("导出失败", "error");
    }
  };

  // chat-first：有无数据决定首屏话术与建议（无数据时不做持仓/账本假设）
  const hasData =
    (dashboard?.positions.length ?? 0) > 0 || (dashboard?.transactions.length ?? 0) > 0;
  const suggestions = suggestionsOn
    ? hasData
      ? [...dynamicSuggestions(dashboard?.flags ?? []), ...BASE_SUGGESTIONS].slice(0, 5)
      : GENERIC_SUGGESTIONS
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
            <span className="truncate">当前会话</span>
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
                      placeholder="搜索会话"
                      aria-label="搜索会话"
                      className="w-full rounded-lg border border-input bg-background pl-8 pr-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                )}
                {filteredSessions.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    {sessionSearch.trim() ? "没有匹配的会话" : "还没有会话"}
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
          <Sparkles className="w-3.5 h-3.5" /> 新会话
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
                  问你的钱，这里都有答案
                </h1>
                <p className="mt-2 text-sm text-muted-foreground max-w-xs mx-auto leading-relaxed text-balance">
                  基于你的持仓与账本，回答关于盈亏、支出、负债和风险的问题。
                </p>
              </>
            ) : (
              <>
                <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight leading-[1.2] text-balance">
                  我是随身理财
                </h1>
                <p className="mt-2 text-sm text-muted-foreground max-w-xs mx-auto leading-relaxed text-balance">
                  没有数据也能聊：先随便问问，或去「记账」记下第一笔，再让我帮你分析。
                </p>
              </>
            )}
            {suggestions.length > 0 && (
              <div className="mt-5 flex flex-col gap-2 max-w-sm mx-auto">
                {suggestions.map((s) => (
                  <Button key={s} variant="outline" onClick={() => send(s)} disabled={busy}>
                    {s}
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
                <div className="inline-block rounded-2xl rounded-br-md bg-primary text-primary-foreground px-4 py-2 text-sm shadow-sm">
                  {m.text}
                </div>
              ) : (
                /* 账本的行：左侧一条竖线标来源，正文直接落在页面上，不再套白卡 */
                <div className="border-l-2 border-border pl-3.5 sm:pl-4">
                  {m.error ? (
                    <div className="text-sm text-red-600 dark:text-red-400">出错了：{m.error}</div>
                  ) : m.text === "" ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" /> 正在分析…
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          {m.meta?.llm === "llm" && <Badge variant="default">AI 生成</Badge>}
                          {m.meta?.llm === "template" && <Badge variant="muted">内置分析</Badge>}
                          <span>{m.created_at ? fmtDate(m.created_at) : "刚刚"}</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <button
                            type="button"
                            className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
                            aria-label="重新生成回答"
                            title="重新生成"
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
                                aria-label="复制 Markdown"
                                onClick={() => void exportAnswer(m, "copy")}
                              >
                                <Copy className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                className="p-1 text-muted-foreground hover:text-foreground"
                                aria-label="下载 Markdown"
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
                      {m.steps.length > 0 && (
                        <div className="mt-3">
                          <button
                            type="button"
                            className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground"
                            onClick={() => setShowSteps((v) => !v)}
                          >
                            查看分析过程
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
          <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            <span>AI 未接入：自由问答需先在设置里配置模型；当前由内置分析回答财务问题。</span>
            <Button variant="outline" size="sm" className="h-6 shrink-0 px-2" onClick={onOpenSettings}>
              去接入
            </Button>
          </div>
        )}
        <div className="flex items-end gap-2">
          {voiceOn && (
            <Button
              variant={listening ? "default" : "ghost"}
              size="icon"
              aria-label="语音输入"
              onClick={toggleVoice}
              className={listening ? "animate-pulse-ring" : ""}
            >
              {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </Button>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={1}
            placeholder="问点什么，比如：这个月开销怎么样？"
            className="flex-1 resize-none rounded-xl border border-input bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[44px] max-h-32"
          />
          {busy ? (
            <Button size="icon" variant="outline" onClick={stop} aria-label="停止回答">
              <Square className="w-4 h-4" />
            </Button>
          ) : (
            <Button size="icon" onClick={() => send(input)} disabled={!input.trim()}>
              <Send className="w-4 h-4" />
            </Button>
          )}
        </div>
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          Enter 发送 · Shift+Enter 换行{voiceOn ? " · 点麦克风语音提问" : ""}
        </div>
      </div>
    </div>
  );
}
