import { ActionList, ActionMenu, Box, Text } from "@primer/react";

export interface ModelInfo {
  id: string;
  name: string;
  supported_reasoning_efforts?: string[] | null;
  default_reasoning_effort?: string | null;
}

/**
 * Primer ActionMenu-backed model dropdown. Wider, prettier, and supports
 * an explicit "use default" option. When `models` is empty we fall back
 * to a simple text input via the caller (see ModelPicker.tsx).
 */
export function ModelDropdown({
  value,
  models,
  onChange,
  allowInherit,
  inheritLabel,
  width = 360,
}: {
  value: string;
  models: ModelInfo[];
  onChange: (v: string) => void;
  allowInherit: boolean;
  inheritLabel: string;
  width?: number | string;
}) {
  const selected = models.find((m) => m.id === value);
  const label = !value
    ? inheritLabel
    : selected
      ? selected.name
      : `${value} (custom)`;

  return (
    <ActionMenu>
      <ActionMenu.Button
        sx={{
          width,
          maxWidth: "100%",
          justifyContent: "space-between",
          fontWeight: 400,
          textAlign: "left",
          overflow: "hidden",
        }}
      >
        <Box
          as="span"
          sx={{
            display: "inline-flex",
            alignItems: "baseline",
            gap: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            color: !value ? "fg.muted" : "fg.default",
          }}
        >
          <Text
            sx={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </Text>
          {value && selected && selected.name !== selected.id && (
            <Text sx={{ color: "fg.muted", fontSize: 0, flexShrink: 0 }}>{selected.id}</Text>
          )}
        </Box>
      </ActionMenu.Button>
      <ActionMenu.Overlay width="large" align="start" sx={{ maxHeight: 360, overflowY: "auto" }}>
        <ActionList selectionVariant="single">
          {allowInherit && (
            <ActionList.Item selected={!value} onSelect={() => onChange("")}>
              <Text sx={{ color: "fg.muted" }}>{inheritLabel}</Text>
            </ActionList.Item>
          )}
          {allowInherit && <ActionList.Divider />}
          {models.map((m) => (
            <ActionList.Item
              key={m.id}
              selected={m.id === value}
              onSelect={() => onChange(m.id)}
            >
              {m.name}
              {m.name !== m.id && (
                <ActionList.Description variant="block">{m.id}</ActionList.Description>
              )}
            </ActionList.Item>
          ))}
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  );
}
