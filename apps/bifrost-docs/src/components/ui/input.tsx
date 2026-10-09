import * as React from "react"

import { cn } from "@/lib/ds-utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "min-h-[var(--bf-control-height)] w-full min-w-0 rounded-[var(--bf-radius-control)] border border-[var(--bf-line)] bg-[var(--bf-paper)] px-3 text-[13px] text-[var(--bf-ink)] outline-2 outline-transparent outline-offset-1 transition-[border-color,outline-color] duration-[var(--bf-motion-feedback)] placeholder:text-[var(--bf-muted)] hover:border-[var(--bf-line-strong)] focus:border-[var(--bf-primary)] focus:outline-[color-mix(in_srgb,var(--bf-primary)_22%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[var(--bf-danger)]",
        className
      )}
      {...props}
    />
  )
}

export { Input }
