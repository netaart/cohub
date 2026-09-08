const { defineConfig, globalIgnores } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  ...expoConfig,
  globalIgnores([
    "dist/**",
    ".expo/**",
    "android/**",
    "ios/**",
    "reference/**",
    "coverage/**",
  ]),
  {
    rules: {
      "import/order": "off",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
]);
