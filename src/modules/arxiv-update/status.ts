import type { UpdateStatus, UpdateTableData } from "../../types";

export type SimpleUpdateStatus =
  | "pending"
  | "processing"
  | "needs-confirmation"
  | "up-to-date"
  | "updated"
  | "error";

/** Display color per status, shared by the table's status cell and the drawer. */
export const STATUS_COLOR: Record<SimpleUpdateStatus, string> = {
  pending: "#999999",
  processing: "#2ea8e5",
  "needs-confirmation": "#f6c342",
  updated: "#5fb236",
  "up-to-date": "#5fb236",
  error: "#ff6666",
};

/** Emoji fallback for the table cell on Zotero < 7.1, next to `STATUS_COLOR`. */
export const STATUS_EMOJI: Record<SimpleUpdateStatus, string> = {
  pending: "⚪",
  processing: "🔵",
  "needs-confirmation": "🟠",
  "up-to-date": "🟢",
  updated: "🟢",
  error: "🔴",
};

// Group the granular task statuses into the display categories used for
// sorting, emoji, and cell colors.
export function simplifyUpdateStatus(status: UpdateStatus): SimpleUpdateStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "finding-update":
    case "downloading-metadata":
    case "downloading-pdf":
      return "processing";
    case "needs-confirmation":
      return "needs-confirmation";
    case "up-to-date":
      return "up-to-date";
    case "updated":
      return "updated";
    case "download-error":
    case "general-error":
      return "error";
  }
}

export function sortByStatusPriority(
  tableData: UpdateTableData[],
): UpdateTableData[] {
  const newTableData: UpdateTableData[] = [];
  for (const status of [
    "error",
    "needs-confirmation",
    "processing",
    "pending",
    "updated",
    "up-to-date",
  ]) {
    for (const tableDatum of tableData) {
      if (simplifyUpdateStatus(tableDatum.status) === status) {
        newTableData.push(tableDatum);
      }
    }
  }
  return newTableData;
}
