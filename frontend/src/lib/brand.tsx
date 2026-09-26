/** 品牌系统：随身理财 —— 名称 / 标语 / Logo / 品牌色预设。 */

export const BRAND = {
  name: "随身理财",
  /** 副标用动作对，不用"你的XX管家"这类换行业也通顺的口号 */
  tagline: "记一笔，问一句",
  en: "SuiShen Wealth",
};

export interface BrandPreset {
  id: string;
  label: string;
  /** CSS 变量覆盖（HSL triplet 字符串，用于 :root 与 .dark） */
  light: Record<string, string>;
  dark: Record<string, string>;
  /** 品牌主色（浅色主题下用于图表高亮等） */
  accent: string;
}

/** 四套品牌色：翡翠（默认）/ 靛蓝 / 琥珀 / 石墨 */
export const BRAND_PRESETS: BrandPreset[] = [
  {
    id: "emerald",
    label: "翡翠",
    light: {
      "--primary": "174 62% 29%",
      "--primary-foreground": "0 0% 100%",
      "--accent": "174 62% 93%",
      "--accent-foreground": "174 70% 20%",
      "--ring": "174 62% 34%",
      "--brand": "174 62% 29%",
    },
    dark: {
      "--primary": "174 62% 52%",
      "--primary-foreground": "180 60% 8%",
      "--accent": "174 40% 18%",
      "--accent-foreground": "174 60% 88%",
      "--ring": "174 62% 50%",
      "--brand": "174 62% 52%",
    },
    accent: "#0d7a66",
  },
  {
    id: "indigo",
    label: "靛蓝",
    light: {
      "--primary": "239 74% 52%",
      "--primary-foreground": "0 0% 100%",
      "--accent": "239 80% 93%",
      "--accent-foreground": "239 70% 38%",
      "--ring": "239 74% 55%",
      "--brand": "239 74% 52%",
    },
    dark: {
      "--primary": "239 84% 64%",
      "--primary-foreground": "240 60% 8%",
      "--accent": "239 40% 20%",
      "--accent-foreground": "239 70% 90%",
      "--ring": "239 84% 62%",
      "--brand": "239 84% 64%",
    },
    accent: "#4f46e5",
  },
  {
    id: "amber",
    label: "琥珀",
    light: {
      "--primary": "27 72% 36%",
      "--primary-foreground": "0 0% 100%",
      "--accent": "32 85% 93%",
      "--accent-foreground": "27 80% 28%",
      "--ring": "27 72% 42%",
      "--brand": "27 72% 36%",
    },
    dark: {
      "--primary": "35 88% 58%",
      "--primary-foreground": "25 60% 10%",
      "--accent": "32 45% 18%",
      "--accent-foreground": "35 80% 90%",
      "--ring": "35 88% 56%",
      "--brand": "35 88% 58%",
    },
    accent: "#a16207",
  },
  {
    id: "graphite",
    label: "石墨",
    light: {
      "--primary": "215 22% 34%",
      "--primary-foreground": "0 0% 100%",
      "--accent": "215 25% 92%",
      "--accent-foreground": "215 25% 24%",
      "--ring": "215 22% 38%",
      "--brand": "215 22% 34%",
    },
    dark: {
      "--primary": "215 18% 62%",
      "--primary-foreground": "215 30% 8%",
      "--accent": "215 20% 20%",
      "--accent-foreground": "215 20% 90%",
      "--ring": "215 18% 58%",
      "--brand": "215 18% 62%",
    },
    accent: "#475569",
  },
];

/**
 * 品牌 Logo：外圆古钱币 + 方孔 + 上升趋势线（钱生钱）。
 * 纯 SVG，随品牌色变化；size 为边长。
 */
export function BrandLogo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      aria-label={`${BRAND.name} Logo`}
    >
      {/* 外圆（钱币） */}
      <circle cx="24" cy="24" r="21" fill="hsl(var(--primary) / 0.12)" />
      <circle cx="24" cy="24" r="21" stroke="hsl(var(--primary))" strokeWidth="2.6" />
      {/* 方孔 */}
      <rect x="19.4" y="19.4" width="9.2" height="9.2" rx="1.6" stroke="hsl(var(--primary))" strokeWidth="2" />
      {/* 上升趋势线（从方孔穿出） */}
      <path
        d="M13 31.5 L20 24.5 L25 29 L35 16.5"
        stroke="hsl(var(--brand-gold, 43 78% 46%))"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* 终点圆点 */}
      <circle cx="35" cy="16.5" r="2.4" fill="hsl(var(--brand-gold, 43 78% 46%))" />
    </svg>
  );
}
