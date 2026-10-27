import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { IconButton } from "@/ui/button";

export function ThemeToggle() {
    const [theme, toggle] = useTheme();
    return (
        <IconButton title={theme === "dark" ? "Usar tema claro" : "Usar tema escuro"} onClick={toggle}>
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </IconButton>
    );
}
