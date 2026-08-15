import type { UpdateStatus, UpdateTableData } from "../../types";

export type SimpleUpdateStatus =
  | "pending"
  | "processing"
  | "needs-confirmation"
  | "up-to-date"
  | "updated"
  | "error";

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
