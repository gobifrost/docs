import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/ds-utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-[var(--bf-radius-surface)] border px-2 py-0.5 text-xs font-semibold tabular-nums transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[var(--bf-primary)] text-white",
        secondary: "border-transparent bg-[var(--bf-cool)] text-[var(--bf-ink)]",
        outline: "border-[var(--bf-line)] text-[var(--bf-ink)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
