// Release notes are built from commit subjects; see "Commits and releases" in
// AGENTS.md. Checked in CI for every pull request.
const config = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 100],
  },
};

export default config;
