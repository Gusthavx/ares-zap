import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Spinner } from "./misc";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "icon" | "icon-sm";

const VARIANT: Record<Variant, string> = {
    primary: "bg-ink text-ink-fg hover:opacity-90 border border-transparent",
    secondary: "border border-line bg-bg hover:bg-subtle",
    ghost: "border border-transparent hover:bg-subtle text-fg",
    danger: "border border-line bg-bg text-bad hover:bg-subtle",
};
const SIZE: Record<Size, string> = {
    sm: "h-8 px-3 text-[13px] gap-1.5",
    md: "h-9 px-3.5 text-[13.5px] gap-2",
    icon: "h-9 w-9 justify-center",
    "icon-sm": "h-7 w-7 justify-center",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: Variant;
    size?: Size;
    loading?: boolean;
    icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { variant = "secondary", size = "md", loading, icon, className = "", children, disabled, type = "button", ...rest }, ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            disabled={disabled || loading}
            className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-md font-medium transition-[background-color,opacity] duration-100 disabled:pointer-events-none disabled:opacity-45 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
            {...rest}
        >
            {loading ? <Spinner className="h-3.5 w-3.5" /> : icon}
            {children}
        </button>
    );
});

/** Botão só com ícone e título acessível. */
export function IconButton({ title, children, className = "", size = "icon-sm", ...rest }: ButtonProps & { title: string }) {
    return (
        <Button variant="ghost" size={size} title={title} aria-label={title} className={`text-muted hover:text-fg ${className}`} {...rest}>
            {children}
        </Button>
    );
}
