export type UpdateStatus =
  | "pending"
  | "finding-update"
  | "downloading-metadata"
  | "downloading-pdf"
  | "up-to-date"
  | "updated"
  | "download-error"
  | "general-error";

export type UpdateTableData = {
  id: number;
  title: string;
  status: UpdateStatus;
  message?: string;
};
