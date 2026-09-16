import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm text-xs font-medium transition active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:bg-accent-dim',
        secondary:
          'border border-border bg-surface-raised text-text-body hover:bg-surface-hover',
        ghost: 'text-text-muted hover:bg-surface-hover hover:text-text-body',
        danger: 'border border-red/40 text-red hover:bg-red-soft'
      },
      size: {
        sm: 'h-7 px-2.5',
        md: 'h-8 px-3',
        lg: 'h-9 px-4 text-sm'
      }
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md'
    }
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  )
)
Button.displayName = 'Button'

export { buttonVariants }
