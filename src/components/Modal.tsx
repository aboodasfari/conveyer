import { ReactNode } from "react";
import { Box, IconButton } from "@primer/react";
import { XIcon } from "@primer/octicons-react";

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

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
