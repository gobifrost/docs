import type { ComponentProps } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "@/lib/ds-utils";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({ className, align = "center", sideOffset = 4, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 rounded-[var(--bf-radius-surface)] border border-[var(--bf-line)] bg-[var(--bf-paper)] p-4 shadow-md outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
