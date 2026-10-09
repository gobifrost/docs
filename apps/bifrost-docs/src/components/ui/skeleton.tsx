import type { HTMLAttributes } from "react";
import { cn } from "@/lib/ds-utils";

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-[var(--bf-radius-surface)] bg-[var(--bf-cool)]", className)} {...props} />;
}
