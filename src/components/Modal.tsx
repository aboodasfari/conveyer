import { ReactNode, useEffect } from "react";
import { Box, Flash, IconButton } from "@primer/react";
import { XIcon } from "@primer/octicons-react";

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Optional error string shown inline at the top of the body. */
  error?: string | null;
  /** Optional width override. Defaults to 480px min, expands with content. */
  width?: number | string;
}

export function Modal({ open, title, onClose, children, footer, error, width }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <Box
      onClick={onClose}
      sx={{
        position: "fixed",
        inset: 0,
        bg: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <Box
        onClick={(e) => e.stopPropagation()}
        sx={{
          bg: "canvas.default",
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: "border.default",
          borderRadius: 2,
          width: width,
          minWidth: width ? undefined : 480,
          maxWidth: "calc(100vw - 48px)",
          maxHeight: "calc(100vh - 48px)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "shadow.large",
        }}
      >
        <Box
          sx={{
            p: 3,
            borderBottomWidth: 1,
            borderBottomStyle: "solid",
            borderBottomColor: "border.default",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 3,
          }}
        >
          <strong>{title}</strong>
          <IconButton
            aria-label="Close"
            icon={XIcon}
            variant="invisible"
            onClick={onClose}
          />
        </Box>
        <Box sx={{ p: 3, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
          {error && <Flash variant="danger">{error}</Flash>}
          {children}
        </Box>
        {footer && (
          <Box
            sx={{
              p: 3,
              borderTopWidth: 1,
              borderTopStyle: "solid",
              borderTopColor: "border.default",
              display: "flex",
              justifyContent: "flex-end",
              gap: 2,
            }}
          >
            {footer}
          </Box>
        )}
      </Box>
    </Box>
  );
}
