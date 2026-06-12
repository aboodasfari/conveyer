import { ReactNode } from "react";
import { Box, Button } from "@primer/react";

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Lightweight modal. We deliberately avoid Primer's Dialog because v36 ships
 * two flavours with conflicting types, and this one is plenty.
 */
export function Modal({ open, title, onClose, children, footer }: ModalProps) {
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
          minWidth: 480,
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
          }}
        >
          <strong>{title}</strong>
          <Button size="small" variant="invisible" onClick={onClose}>
            Close
          </Button>
        </Box>
        <Box sx={{ p: 3, overflowY: "auto" }}>{children}</Box>
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
