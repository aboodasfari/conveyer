import { ReactNode } from "react";
import { BaseStyles, ThemeProvider } from "@primer/react";

export function AppTheme({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider colorMode="night" preventSSRMismatch>
      <BaseStyles
        style={{
          minHeight: "100vh",
          backgroundColor: "var(--bgColor-default, #0d1117)",
          color: "var(--fgColor-default, #e6edf3)",
        }}
      >
        {children}
      </BaseStyles>
    </ThemeProvider>
  );
}
