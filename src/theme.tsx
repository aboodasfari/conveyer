import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { BaseStyles, ThemeProvider } from "@primer/react";

export type ColorMode = "day" | "night";
const STORAGE_KEY = "conveyer.colorMode";

interface ThemeCtx {
  mode: ColorMode;
  setMode: (m: ColorMode) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeCtx>({
  mode: "night",
  setMode: () => undefined,
  toggle: () => undefined,
});

export const useColorMode = () => useContext(ThemeContext);

export function AppTheme({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ColorMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "day" || stored === "night" ? stored : "night";
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
    document.documentElement.style.background =
      mode === "night" ? "#0d1117" : "#ffffff";
    // Prevent horizontal scroll on the document; titles etc. truncate instead.
    document.documentElement.style.overflowX = "hidden";
    document.body.style.overflowX = "hidden";
  }, [mode]);

  const ctx: ThemeCtx = {
    mode,
    setMode: setModeState,
    toggle: () => setModeState((m) => (m === "night" ? "day" : "night")),
  };

  return (
    <ThemeContext.Provider value={ctx}>
      <ThemeProvider colorMode={mode} preventSSRMismatch>
        <BaseStyles
          style={{
            minHeight: "100vh",
            backgroundColor: mode === "night" ? "#0d1117" : "#ffffff",
            color: mode === "night" ? "#e6edf3" : "#1f2328",
          }}
        >
          {children}
        </BaseStyles>
      </ThemeProvider>
    </ThemeContext.Provider>
  );
}
