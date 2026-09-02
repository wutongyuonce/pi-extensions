import { defineConfig } from "oxfmt";

export default defineConfig({
  sortImports: {
    customGroups: [
      {
        groupName: "node",
        elementNamePattern: ["node:*"],
      },
    ],
    groups: [
      "type-import",
      "node",
      ["value-builtin", "value-external"],
      ["type-internal", "value-internal"],
      ["type-parent", "type-sibling", "type-index"],
      ["value-parent", "value-sibling", "value-index"],
      "unknown",
    ],
  },
});
