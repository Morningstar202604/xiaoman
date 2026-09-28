/** API 访问层：统一带访问口令（Authorization: Bearer，不进 URL/日志）；
 * 401 时通过注册的回调打开应用内口令对话框，输入后自动重试一次；
 * 普通请求带超时，SSE 由 fetch-event-source 管理断线重试。
 */

import { fetchEventSource } from "@microsoft/fetch-event-source";

const TOKEN_KEY = "wo.accessToken";
const REQUEST_TIMEOUT_MS = 20_000;

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** 口令对话框回调（由 App 注册，返回用户输入或 null=取消） */
let authPrompt: (() => Promise<string | null>) | null = null;

export function setAuthPromptHandler(fn: (() => Promise<string | null>) | null): void {
  authPrompt = fn;
}

async function askAuth(): Promise<string | null> {
  if (!authPrompt) return null;
  return authPrompt();
}

/** 带超时的 fetch：外部 signal 与超时共存（任一触发即中止）。 */
async function fetchWithTimeout(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  const external = init.signal;
  const onAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", onAbort);
  }
  try {
    return await fetch(path, { ...init, signal: ctrl.signal });
  } finally {
    window.clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }
}

function authHeaders(init: RequestInit): HeadersInit {
  const token = getToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers ?? {}),
  };
}

async function request(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(path, { ...init, headers: authHeaders(init) }, REQUEST_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("请求超时，请检查服务是否可用");
    }
    throw err;
  }
  if (resp.status === 401 && !retried) {
    const input = await askAuth();
    if (input) {
      setToken(input.trim());
      return request(path, init, true);
    }
    throw new Error("需要访问口令");
  }
  return resp;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await request(path, init);
  if (!resp.ok) {
    let detail = `${resp.status}`;
    try {
      const body = await resp.json();
      if (body?.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await resp.json()) as T;
}

/** 内部信号：需要用户重新输口令（触发一次带新口令的重试） */
class ReauthError extends Error {}
/** 致命错误：不重试，直接抛给调用方 */
class FatalError extends Error {}

/**
 * SSE 流式问答：用微软官方 fetch-event-source，拿到断线指数退避重试、
 * Last-Event-ID 续传、页面隐藏自动挂起。语义按其实现：onerror 返回数字=延迟后重试，
 * 抛错=停止重试并 reject。
 */
export async function apiStream(
  path: string,
  body: unknown,
  onLine: (obj: Record<string, unknown>) => void,
  signal?: AbortSignal,
  retried = false,
): Promise<void> {
  const token = getToken();
  let got = false;

  try {
    await fetchEventSource(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
      openWhenHidden: true, // 提问后切标签页也不打断
      async onopen(response) {
        if (response.status === 401) {
          if (!retried) {
            const input = await askAuth();
            if (input) {
              setToken(input.trim());
              throw new ReauthError();
            }
          }
          throw new FatalError("需要访问口令");
        }
        if (!response.ok) {
          let detail = `${response.status}`;
          try {
            const b = await response.clone().json();
            if (b?.error) detail = b.error;
          } catch {
            /* ignore */
          }
          throw new FatalError(detail);
        }
      },
      onmessage(ev) {
        if (!ev.data || ev.data === "[DONE]") return;
        try {
          got = true;
          onLine(JSON.parse(ev.data) as Record<string, unknown>);
        } catch {
          /* 忽略坏帧 */
        }
      },
      onerror(err) {
        // 抛错=停止重试；返回数字=延迟后重试（该库语义）
        if (err instanceof ReauthError || err instanceof FatalError) throw err;
        if (signal?.aborted) throw err;
        if (got) throw err; // 已收到内容：不再重试（重试会重跑一遍后端生成）
        return 1500; // 还没收到任何内容：退避后重试（服务器刚起/网络抖动）
      },
    });
  } catch (err) {
    if (err instanceof ReauthError) return apiStream(path, body, onLine, signal, true);
    if (signal?.aborted) return; // 用户主动取消不算失败
    if (got) return; // 已经拿到内容，后续抖动不打扰用户
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// ---------------------------------------------------------------------------
// 财务目标
// ---------------------------------------------------------------------------

export const listGoals = () =>
  api<{ goals: import("@/lib/types").Goal[] }>("/api/goals").then((r) => r.goals);

export const createGoal = (g: { name: string; target: number; saved?: number; deadline?: string }) =>
  api<{ ok: boolean; name: string }>("/api/goals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(g),
  });

export const updateGoal = (name: string, patch: { saved?: number; target?: number; deadline?: string }) =>
  api<{ ok: boolean }>(`/api/goals/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });

export const deleteGoal = (name: string) =>
  api<{ ok: boolean; deleted: number }>(`/api/goals/${encodeURIComponent(name)}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// 长期记忆
// ---------------------------------------------------------------------------

export const listMemory = () =>
  api<{ memory: import("@/lib/types").MemoryItem[] }>("/api/memory").then((r) => r.memory);

export const addMemory = (content: string) =>
  api<{ ok: boolean; id: number; deduped?: boolean }>("/api/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

export const deleteMemory = (id: number) =>
  api<{ ok: boolean; deleted: number }>(`/api/memory/${id}`, { method: "DELETE" });

export const clearMemory = () =>
  api<{ ok: boolean; deleted: number }>("/api/memory/clear", { method: "POST" });

// ---------------------------------------------------------------------------
// 财务体检
// ---------------------------------------------------------------------------

export const fetchHealthCheck = (lang = "zh") =>
  api<import("@/lib/types").HealthReport>(`/api/health-check?lang=${encodeURIComponent(lang)}`);
