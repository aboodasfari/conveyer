import { Box, IconButton, TextInput } from "@primer/react";
import { FileDirectoryIcon } from "@primer/octicons-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

/**
 * Text input for a workspace / directory path, with a Finder folder-picker
 * button on the right that opens a native directory chooser. Used in both
 * Settings (workspace list rows) and the WorkspacePicker popover.
 *
 * `onChange` is fired both on text edits and after a folder is picked, so
 * the parent stays in sync without dealing with the picker plumbing.
 */
export function WorkspacePathInput({
  value,
  onChange,
  placeholder = "/Users/you/code/foo",
  block = true,
  autoFocus = false,
  onBlur,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  block?: boolean;
  autoFocus?: boolean;
  onBlur?: () => void;
  onEnter?: () => void;
}) {
  const pick = async () => {
    try {
      const result = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose workspace",
        defaultPath: value || undefined,
      });
      if (typeof result === "string" && result) {
        onChange(result);
      }
    } catch {
      // User cancelled or the dialog failed — ignore.
    }
  };

  return (
    <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
      <TextInput
        block={block}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onEnter?.();
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder={placeholder}
        sx={{ flex: 1 }}
      />
      <IconButton
        aria-label="Browse for folder"
        title="Browse for folder"
        icon={FileDirectoryIcon}
        onClick={() => void pick()}
      />
    </Box>
  );
}
