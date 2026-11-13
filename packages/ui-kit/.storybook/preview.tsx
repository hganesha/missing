import type { Preview } from "@storybook/react";
import "@ehf/ui-tokens/tokens.css";
import "../src/styles/base.css";

const preview: Preview = {
  parameters: {
    layout: "padded",
    backgrounds: { disable: true },
    a11y: { config: { rules: [{ id: "region", enabled: false }] } },
  },
};

export default preview;
