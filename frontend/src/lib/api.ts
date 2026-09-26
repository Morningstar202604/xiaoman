/** API 访问层：统一带上访问口令；遇到 401 时引导用户输入口令后重试一次。 */

import { fetchEventSource } from "@microsoft/fetch-event-source";

const TOKEN_KEY = "wo.accessToken";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const token = getToken();
  const url = token ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : path;
  const resp = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (resp.status === 401 && !retried) {
    const input = window.prompt("本服务设置了访问口令，请输入：");
    if (input !== null) {
      setToken(input.trim());
      return request(path, init, true);
    }
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
  const url = token ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : path;
  let got = false;

  try {
    await fetchEventSource(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
      openWhenHidden: true, // 提问后切标签页也不打断
      async onopen(response) {
        if (response.status === 401) {
          const input = window.prompt("本服务设置了访问口令，请输入：");
          if (!retried && input !== null) {
            setToken(input.trim());
            throw new ReauthError();
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
