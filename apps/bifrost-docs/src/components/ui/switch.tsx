"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/ds-utils"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex h-6 w-10.5 shrink-0 items-center rounded-xl border border-[var(--bf-line)] bg-[var(--bf-line)] transition-all duration-[var(--bf-motion-disclosure)] outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bf-primary)] data-[state=checked]:border-[var(--bf-primary)] data-[state=checked]:bg-[var(--bf-primary)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none ml-[3px] block size-4 rounded-full bg-[var(--bf-paper)] transition-transform duration-[var(--bf-motion-disclosure)] data-[state=checked]:translate-x-[18px]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
