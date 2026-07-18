// lib/format.ts — shared terminal-rendering helpers for the dotfiles CLI tools.
// Color, utilization bars, percent/reset/relative-time formatting. Import from
// any tool under tools/ so output stays consistent across the whole suite.

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

type ColorName = keyof typeof ANSI;

/** True unless NO_COLOR is set or stdout isn't a TTY (FORCE_COLOR overrides). */
export function colorEnabled(): boolean {
  if (process.env.FORCE_COLOR != null) return true;
  if (process.env.NO_COLOR != null) return false;
  return Boolean(process.stdout.isTTY);
}

export function makeStyle(enabled: boolean) {
  const wrap = (name: ColorName) => (s: string) =>
    enabled ? `${ANSI[name]}${s}${ANSI.reset}` : s;
  return {
    enabled,
    bold: wrap("bold"),
    dim: wrap("dim"),
    gray: wrap("gray"),
    red: wrap("red"),
    green: wrap("green"),
    yellow: wrap("yellow"),
    cyan: wrap("cyan"),
  };
}
export type Style = ReturnType<typeof makeStyle>;

/** Utilization severity band, used for coloring. */
export function severity(pct: number): "ok" | "warn" | "crit" {
  if (pct >= 90) return "crit";
  if (pct >= 70) return "warn";
  return "ok";
}

export function severityColor(style: Style, pct: number): (s: string) => string {
  switch (severity(pct)) {
    case "crit":
      return style.red;
    case "warn":
      return style.yellow;
    default:
      return style.green;
  }
}

/** Fixed-width utilization bar, e.g. bar(30) => "███░░░░░░░". */
export function bar(pct: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Round a percent to a short label; <1% and near-100% get honest labels. */
export function pct(n: number): string {
  if (n > 0 && n < 1) return "<1%";
  if (n >= 99.5 && n < 100) return "99%";
  return `${Math.round(n)}%`;
}

/** "resets in 3h 12m · 14:59" from an ISO string or epoch-ms number. */
export function fmtReset(
  resetsAt: string | number | null | undefined,
  now = Date.now(),
): string {
  if (resetsAt == null) return "";
  const t = typeof resetsAt === "number" ? resetsAt : Date.parse(resetsAt);
  if (Number.isNaN(t)) return "";
  // Anthropic returns `resets_at` as now + time-remaining, so it lands a few
  // hundred ms either side of the real boundary (06:29:59.79 on one request,
  // 06:30:00.44 on the next). Truncating that to the minute would flip the
  // printed clock between 11:29 PM and 11:30 PM run to run; round instead.
  const clock = new Date(Math.round(t / 60_000) * 60_000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const delta = t - now;
  if (delta <= 0) return `resetting · ${clock}`;
  return `resets ${humanDelta(delta)} · ${clock}`;
}

/** "in 3h 12m" for a forward duration in ms. */
export function humanDelta(ms: number): string {
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  if (m > 0) return `in ${m}m`;
  return "in <1m";
}

/** "3h ago" for a past duration in ms. */
export function humanAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Locale currency formatting with a safe fallback. */
export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
