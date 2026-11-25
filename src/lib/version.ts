// lib/version.ts — the release version, printed by --version in every tool.
// Homebrew installs only bin/ and src/, so package.json isn't there to read at
// runtime. Bump this with package.json at each release; ccmeter --version
// should print the tag being released.
export const VERSION = "0.2.15";
