import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* ============================================================================
   Button · 规范依据 DESIGN.md §4.6 / §8.2
   ----------------------------------------------------------------------------
   要点：
   · 高度收敛为 34 / 29 / 40px（原 default 为 36px），字重 500 → 600
   · 圆角用固定的 8 / 7 / 9px，不跟随卡片圆角（按钮圆角过大会显"胖"）
   · 去掉投影：静置无影、按下位移 1px，是更克制的做法，也避免与卡片投影打架
   · 买入红 / 卖出绿为 A 股语义，**必须带文字标签**，不得只用色块或图标
   · 移动端触控目标需 ≥44px，故 lg 尺寸在移动端配足间距（§8.2）
   ==========================================================================*/

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] text-body font-semibold transition-colors active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-[#1a44c4]",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        /* 次级按钮：白底 + 强调边框，悬停转下沉面并加深边框（§4.6 .btn-o） */
        outline:
          "border border-border-strong bg-white text-t1 hover:border-[#bfc9d9] hover:bg-surface-subtle",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        /* 交易专用：买入红、卖出绿（A股习惯，与欧美相反，不准"顺手修正"） */
        buy: "bg-stock-up text-white hover:bg-stock-up/90",
        sell: "bg-stock-down text-white hover:bg-stock-down/90",
      },
      size: {
        default: "h-[34px] px-3.5",
        sm: "h-[29px] rounded-[7px] px-[11px] text-[12.5px]",
        lg: "h-10 rounded-[9px] px-5 text-[14px]",
        icon: "h-[34px] w-[34px]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** 为 true 时把样式合并到子元素（配合 next/link 使用） */
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
