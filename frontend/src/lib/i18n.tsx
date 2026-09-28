/** 轻量 i18n：默认 English，可切换中文，本地持久化，即时生效。
 * 文案字典：src/lib/lang/{en,zh}.ts（扁平 key）。
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { setMoneyLocale } from "./format";
import { en } from "./lang/en";
import { zh } from "./lang/zh";

export type Lang = "en" | "zh";

const KEYS = { lang: "wo.lang" };
const DICTS: Record<Lang, Record<string, string>> = { en, zh };

interface I18nState {
  lang: Lang;
  setLang: (v: Lang) => void;
  /** 取当前语言文案；缺失时回退英文，再缺失回退 key 本身。支持 {var} 占位替换。 */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nCtx = createContext<I18nState | null>(null);

function load(): Lang {
  try {
    const v = localStorage.getItem(KEYS.lang);
    return v === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(load);

  const setLang = useCallback((v: Lang) => {
    setLangState(v);
    setMoneyLocale(v);
    try {
      localStorage.setItem(KEYS.lang, v);
    } catch {
      /* ignore */
    }
  }, []);

  // 同步 <html lang>（利于无障碍与浏览器翻译提示）
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  // 初始同步一次（避免 fmtMoney 等在切换前用模块默认 en）
  useEffect(() => {
    setMoneyLocale(lang);
  }, [lang]);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let v = DICTS[lang][key] ?? DICTS.en[key] ?? key;
      if (vars) {
        for (const [k, val] of Object.entries(vars)) {
          v = v.replaceAll(`{${k}}`, String(val));
        }
      }
      return v;
    },
    [lang],
  );

  return <I18nCtx.Provider value={{ lang, setLang, t }}>{children}</I18nCtx.Provider>;
}

export function useI18n(): I18nState {
  const ctx = useContext(I18nCtx);
  if (!ctx) throw new Error("useI18n 必须在 I18nProvider 内使用");
  return ctx;
}
