import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

/** 应用根部包一层，统一提示延迟等参数。 */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={300}>{children}</TooltipPrimitive.Provider>;
}

/** 图标按钮的悬停提示（Radix Tooltip）。需在应用根部包一层 <TooltipProvider>。 */
export function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          className={cn(
            "z-50 select-none rounded-md border border-border bg-card px-2 py-1",
            "text-xs text-foreground shadow-lift",
            "data-[state=delayed-open]:animate-fade-in",
          )}
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
