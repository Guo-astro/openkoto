import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import React from "react";
import { cn } from "../../lib/utils";

/**
 * The one button style for the whole web app (landing, public pages and the signed-in app).
 * Heights come from the control tokens in styles/themes/paper.css: sm 36 · md 40 · lg 48.
 * Use `asChild` to style a <Link>/<a>, or `buttonVariants()` for a className.
 */
const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium leading-none",
    "transition-[background-color,border-color,color,transform] active:translate-y-px",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current",
    "disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0",
    // CJK labels: regular weight with a little tracking reads better than a faux-bold Song face.
    "[:is(:lang(zh),:lang(ja))_&]:font-normal [:is(:lang(zh),:lang(ja))_&]:tracking-[0.06em]",
  ],
  {
    variants: {
      variant: {
        /** Solid ink: the main action (ink pill in light mode, cream pill in dark mode). */
        default: "bg-ink text-ink-foreground hover:bg-ink-hover",
        /** Hairline outline that darkens on hover. */
        outline: "border border-line bg-transparent text-current hover:border-current",
        /** Soft sand fill. */
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
        ghost: "text-current hover:bg-line",
        danger: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        /** Cream pill on the dark banner. */
        inverse: "bg-banner-foreground text-banner hover:bg-banner-foreground/90",
      },
      size: {
        sm: "h-ctl-sm px-4 text-sm",
        md: "h-ctl-md px-5 text-[15px]",
        lg: "h-ctl-lg px-7 text-base",
        "icon-sm": "size-ctl-sm",
        icon: "size-ctl-md",
        "icon-lg": "size-ctl-lg",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});

Button.displayName = "Button";

export { Button, buttonVariants };
