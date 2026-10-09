import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/ds-utils"

const buttonVariants = cva(
  "bds-button group/button shrink-0 whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bds-button--primary",
        outline: "bds-button--secondary",
        secondary: "bds-button--secondary",
        ghost: "bds-button--ghost",
        destructive: "bds-button--danger",
        link: "bds-button--ghost underline underline-offset-4",
      },
      size: {
        default:
          "min-h-[var(--bf-control-height)]",
        xs: "min-h-6 px-2 text-[11px] [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-[var(--bf-control-height)]",
        lg: "min-h-[calc(var(--bf-control-height)+8px)] px-4",
        icon: "size-[var(--bf-control-height)] p-0",
        "icon-xs": "size-6 min-h-6 p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 min-h-8 p-0",
        "icon-lg": "size-10 min-h-10 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef<HTMLButtonElement, React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }>(function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}, ref) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  )
})
Button.displayName = "Button"

export { Button, buttonVariants }
