import * as React from "react"

import { cn } from "@/lib/ds-utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-19 w-full resize-y rounded-[var(--bf-radius-control)] border border-[var(--bf-line)] bg-[var(--bf-paper)] px-3 py-2.5 text-[13px] leading-6 text-[var(--bf-ink)] outline-2 outline-transparent outline-offset-1 transition-[border-color,outline-color] duration-[var(--bf-motion-feedback)] placeholder:text-[var(--bf-muted)] hover:border-[var(--bf-line-strong)] focus:border-[var(--bf-primary)] focus:outline-[color-mix(in_srgb,var(--bf-primary)_22%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[var(--bf-danger)]",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
