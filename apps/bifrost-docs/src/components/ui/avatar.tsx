import type { ComponentProps } from "react";
import { Avatar as AvatarPrimitive } from "radix-ui";
import { cn } from "@/lib/ds-utils";

export function Avatar({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        "relative flex h-9 w-9 shrink-0 overflow-hidden rounded-full bg-[var(--bf-cool)]",
        className,
      )}
      {...props}
    />
  );
}

export function AvatarFallback({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      className={cn(
        "flex h-full w-full items-center justify-center rounded-full bg-[var(--bf-cool)] text-xs font-semibold text-[var(--bf-ink)]",
        className,
      )}
      {...props}
    />
  );
}
