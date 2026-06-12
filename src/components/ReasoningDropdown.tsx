import { ActionList, ActionMenu, Box, Text } from "@primer/react";
import { ChevronDownIcon } from "@primer/octicons-react";

export const REASONING_LABEL: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/**
 * Reasoning-effort dropdown. Renders nothing useful when the model
 * doesn't support reasoning; the caller is responsible for hiding it
 * in that case.
 */
export function ReasoningDropdown({
  value,
  supported,
  defaultEffort,
  onChange,
  allowInherit,
  inheritLabel,
  width = 180,
}: {
  value: string;
  supported: string[];
  defaultEffort?: string | null;
  onChange: (v: string) => void;
  allowInherit: boolean;
  inheritLabel: string;
  width?: number | string;
}) {
  const label = !value ? inheritLabel : REASONING_LABEL[value] ?? value;
  return (
    <ActionMenu>
      <ActionMenu.Button
        trailingVisual={ChevronDownIcon}
        sx={{
          width,
          justifyContent: "space-between",
          fontWeight: 400,
          textAlign: "left",
        }}
      >
        <Box as="span" sx={{ color: !value ? "fg.muted" : "fg.default" }}>
          {label}
        </Box>
      </ActionMenu.Button>
      <ActionMenu.Overlay align="start" sx={{ maxHeight: 320, overflowY: "auto" }}>
        <ActionList selectionVariant="single">
          {allowInherit && (
            <ActionList.Item selected={!value} onSelect={() => onChange("")}>
              <Text sx={{ color: "fg.muted" }}>{inheritLabel}</Text>
            </ActionList.Item>
          )}
          {allowInherit && <ActionList.Divider />}
          {supported.map((eff) => (
            <ActionList.Item
              key={eff}
              selected={eff === value}
              onSelect={() => onChange(eff)}
            >
              {REASONING_LABEL[eff] ?? eff}
              {eff === defaultEffort && (
                <ActionList.Description variant="block">model default</ActionList.Description>
              )}
            </ActionList.Item>
          ))}
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  );
}
