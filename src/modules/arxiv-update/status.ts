import { UpdateStatus } from "../../types";

/**
 * Single source of truth for what each update status means for display and
 * row management. Both the manager (sorting, reopen-retention) and the dialog
 * (emoji, color) derive their behavior from this one map, so a new status is
 * added here and nowhere else.
 */
export const STATUS_META: Record<
  UpdateStatus,
  {
    rank: number;
    active: boolean;
    emoji: string;
    color: string;
  }
> = {
  "download-error": {
    rank: 0,
    active: false,
    emoji: "🔴",
    color: "#ff6666",
  },
  "general-error": {
    rank: 0,
    active: false,
    emoji: "🔴",
    color: "#ff6666",
  },
  "needs-confirmation": {
    rank: 1,
    active: true,
    emoji: "🟠",
    color: "#f6c342",
  },
  "finding-update": {
    rank: 2,
    active: true,
    emoji: "🔵",
    color: "#2ea8e5",
  },
  "downloading-metadata": {
    rank: 2,
    active: true,
    emoji: "🔵",
    color: "#2ea8e5",
  },
  "downloading-pdf": {
    rank: 2,
    active: true,
    emoji: "🔵",
    color: "#2ea8e5",
  },
  pending: { rank: 3, active: true, emoji: "⚪", color: "#999999" },
  updated: { rank: 4, active: false, emoji: "🟢", color: "#5fb236" },
  "up-to-date": {
    rank: 4,
    active: false,
    emoji: "🟢",
    color: "#5fb236",
  },
};
