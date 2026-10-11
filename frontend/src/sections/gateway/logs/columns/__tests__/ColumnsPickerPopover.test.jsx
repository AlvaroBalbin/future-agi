import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, within } from "src/utils/test-utils";
import ColumnsPickerPopover from "../ColumnsPickerPopover";
import {
  DEFAULT_CONFIG,
  MAX_COLUMN_ENTRIES,
  moveColumn,
  resolveColumns,
} from "../columnModel";

function buildProps(overrides = {}) {
  const resolved = resolveColumns({
    config: overrides.config || {
      v: 1,
      columns: [...DEFAULT_CONFIG.columns, { id: "metadata:tenant" }],
      hidden: [],
    },
    declarations: overrides.declarations || [
      { name: "tenant" },
      { name: "feature" },
    ],
    status: overrides.status || "success",
  });
  return {
    anchorEl: document.body,
    open: true,
    onClose: vi.fn(),
    entries: resolved.entries,
    stale: resolved.stale,
    visibleCount: resolved.visibleCount,
    totalCount: resolved.totalCount,
    declarationStatus: overrides.status || "success",
    unavailableCustomCount: overrides.unavailableCustomCount || 0,
    atCap: resolved.atCap,
    reservedDeclared: resolved.reservedDeclared,
    onToggle: vi.fn(),
    onMove: vi.fn(),
    onRemove: vi.fn(),
    onReset: vi.fn(),
    onRetryDeclarations: vi.fn(),
  };
}

// Re-renders on every move, as the real hook does, so focus is checked
// against the moved row.
function MovablePicker() {
  const [config, setConfig] = React.useState(DEFAULT_CONFIG);
  const { movableIds } = resolveColumns({
    config,
    declarations: [],
    status: "success",
  });
  return (
    <ColumnsPickerPopover
      {...buildProps({ config })}
      onMove={(id, delta) =>
        setConfig(moveColumn(config, id, delta, movableIds))
      }
    />
  );
}

// Tab from the dialog until `target` has focus, as a keyboard user would.
async function tabTo(user, target) {
  for (let i = 0; i < 10 && document.activeElement !== target; i += 1) {
    await user.tab();
  }
  expect(target).toHaveFocus();
}

describe("ColumnsPickerPopover", () => {
  it("is a named dialog that lists groups, counts and a locked Timestamp (AC5)", () => {
    const props = buildProps();
    render(<ColumnsPickerPopover {...props} />);

    const dialog = screen.getByRole("dialog", { name: "Choose columns" });
    expect(within(dialog).getByText("11 of 12 visible")).toBeInTheDocument();
    expect(within(dialog).getByText("Built-in")).toBeInTheDocument();
    expect(within(dialog).getByText("Custom properties")).toBeInTheDocument();

    const timestamp = within(dialog).getByRole("checkbox", {
      name: "Timestamp (always visible)",
    });
    expect(timestamp).toBeChecked();
    expect(timestamp).toBeDisabled();
    expect(
      within(dialog).queryByRole("button", { name: "Move Timestamp up" }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Move Model up" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Move Model down" }),
    ).toBeEnabled();
    expect(
      within(dialog).getByRole("button", { name: "Move Session ID down" }),
    ).toBeDisabled();
    // Search appears only above 8 entries (D6).
    expect(
      within(dialog).getByRole("textbox", { name: "Search columns" }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Column limit reached/)).toBeNull();
  });

  it("toggles, moves and resets through keyboard-operable controls (AC5/AC17)", async () => {
    const user = userEvent.setup();
    const props = buildProps();
    render(<ColumnsPickerPopover {...props} />);
    const dialog = screen.getByRole("dialog", { name: "Choose columns" });

    await tabTo(
      user,
      within(dialog).getByRole("button", { name: "Move Model down" }),
    );
    await user.keyboard("{Enter}");
    expect(props.onMove).toHaveBeenCalledWith("builtin:model", 1);

    await user.tab();
    expect(
      within(dialog).getByRole("checkbox", { name: "Provider" }),
    ).toHaveFocus();
    await user.keyboard(" ");
    expect(props.onToggle).toHaveBeenCalledWith("builtin:provider");

    await user.click(within(dialog).getByRole("checkbox", { name: "feature" }));
    expect(props.onToggle).toHaveBeenCalledWith("metadata:feature");
    expect(
      within(dialog).getByRole("button", { name: "Move feature up" }),
    ).toBeDisabled();

    await user.click(
      within(dialog).getByRole("button", { name: "Reset to default" }),
    );
    expect(props.onReset).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps focus on the pressed Move button while its column moves (AC17)", async () => {
    const user = userEvent.setup();
    render(<MovablePicker />);
    const dialog = screen.getByRole("dialog", { name: "Choose columns" });
    const moveDown = () =>
      within(dialog).getByRole("button", { name: "Move Model down" });
    const order = () =>
      within(dialog)
        .getAllByRole("checkbox")
        .slice(1, 4)
        .map((box) => box.getAttribute("aria-label"));

    await tabTo(user, moveDown());
    await user.keyboard("{Enter}");
    expect(order()).toEqual(["Provider", "Model", "Application"]);
    expect(moveDown()).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(order()).toEqual(["Provider", "Application", "Model"]);
    expect(moveDown()).toHaveFocus();
  });

  it("moves focus to the opposite Move button when a column reaches the end of its group (AC17)", async () => {
    const user = userEvent.setup();
    render(<MovablePicker />);
    const dialog = screen.getByRole("dialog", { name: "Choose columns" });
    const button = (name) => within(dialog).getByRole("button", { name });

    await user.click(button("Move Tokens down"));
    expect(button("Move Tokens down")).toBeDisabled();
    expect(button("Move Tokens up")).toHaveFocus();

    await user.click(button("Move Provider up"));
    expect(button("Move Provider up")).toBeDisabled();
    expect(button("Move Provider down")).toHaveFocus();
  });

  it("filters entries by search text without touching the data", async () => {
    const user = userEvent.setup();
    render(<ColumnsPickerPopover {...buildProps()} />);
    const dialog = screen.getByRole("dialog", { name: "Choose columns" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Search columns" }),
      "ten",
    );
    expect(
      within(dialog).getByRole("checkbox", { name: "tenant" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("checkbox", { name: "Provider" }),
    ).toBeNull();
  });

  it("shows the stale group with a Remove action after a successful fetch (AC14)", async () => {
    const user = userEvent.setup();
    const props = buildProps({ declarations: [{ name: "feature" }] });
    render(<ColumnsPickerPopover {...props} />);
    const dialog = screen.getByRole("dialog", { name: "Choose columns" });
    expect(within(dialog).getByText("No longer declared")).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("checkbox", { name: "tenant" }),
    ).toBeNull();
    await user.click(
      within(dialog).getByRole("button", { name: "Remove tenant" }),
    );
    expect(props.onRemove).toHaveBeenCalledWith("metadata:tenant");
  });

  it("shows an error row with an accessible Retry and no stored names while declarations fail (AC18/J5)", async () => {
    const user = userEvent.setup();
    const props = buildProps({ status: "error", unavailableCustomCount: 1 });
    render(<ColumnsPickerPopover {...props} />);
    const dialog = screen.getByRole("dialog", { name: "Choose columns" });
    expect(
      within(dialog).getByText(/Couldn't load custom properties/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/1 saved custom column unavailable/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("tenant")).toBeNull();
    expect(within(dialog).queryByText("No longer declared")).toBeNull();
    await user.click(
      within(dialog).getByRole("button", {
        name: "Retry loading custom properties",
      }),
    );
    expect(props.onRetryDeclarations).toHaveBeenCalledTimes(1);
  });

  it("shows a loading row while declarations are pending", () => {
    render(<ColumnsPickerPopover {...buildProps({ status: "pending" })} />);
    const dialog = screen.getByRole("dialog", { name: "Choose columns" });
    expect(
      within(dialog).getByText(/Loading custom properties/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("tenant")).toBeNull();
  });

  it("points to Custom Properties when nothing is declared (R36)", () => {
    render(
      <ColumnsPickerPopover
        {...buildProps({ config: DEFAULT_CONFIG, declarations: [] })}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Choose columns" });
    expect(
      within(dialog).getByText(/No custom properties declared/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", {
        name: "Declare one in Custom Properties",
      }),
    ).toHaveAttribute("href", "/dashboard/gateway/custom-properties");
    // Ten built-ins already exceed the eight-entry threshold, so search stays (D6).
    expect(
      within(dialog).getByRole("textbox", { name: "Search columns" }),
    ).toBeInTheDocument();
  });

  it("says Application and Service are built-in when they are the only declarations (D3/R36)", () => {
    render(
      <ColumnsPickerPopover
        {...buildProps({
          config: DEFAULT_CONFIG,
          declarations: [{ name: "application" }, { name: "service" }],
        })}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Choose columns" });
    expect(
      within(dialog).getByText(
        /No other custom properties declared \(Application and Service are already built-in columns\)/,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText(/No custom properties declared/),
    ).toBeNull();
    expect(
      within(dialog).getByRole("link", {
        name: "Declare one in Custom Properties",
      }),
    ).toBeInTheDocument();
  });

  it("disables columns that cannot be added once the column limit is reached", () => {
    const names = Array.from(
      { length: MAX_COLUMN_ENTRIES - DEFAULT_CONFIG.columns.length },
      (_, i) => `p${i}`,
    );
    render(
      <ColumnsPickerPopover
        {...buildProps({
          config: {
            v: 1,
            columns: [
              ...DEFAULT_CONFIG.columns,
              ...names.map((name) => ({ id: `metadata:${name}` })),
            ],
            hidden: [],
          },
          declarations: [...names, "extra"].map((name) => ({ name })),
        })}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Choose columns" });
    expect(
      within(dialog).getByText(/Column limit reached/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("checkbox", { name: "extra" }),
    ).toBeDisabled();
    expect(within(dialog).getByRole("checkbox", { name: "p0" })).toBeEnabled();
  });
});
