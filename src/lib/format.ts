export type DateDisplay = {
  dateFormat?: "mdy" | "dmy" | "ymd";
  timeZone?: string;
  clock?: "12" | "24";
  withTime?: boolean;
};

export function formatMoney(value: { toString(): string } | string | number | null | undefined, currency = "USD"): string {
  if (value == null || value === "") return "—";
  const amount = Number(value.toString());
  if (!Number.isFinite(amount)) return "—";
  const code = currency || "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(amount);
  } catch {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
  }
}

export function formatDate(value: Date | string | null | undefined, display?: DateDisplay): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  if (!display) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  }
  const timeZone = display.timeZone || "UTC";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
      ...(display.withTime ? { hour: "numeric" as const, minute: "2-digit" as const, hour12: display.clock !== "24" } : {}),
    }).formatToParts(date);
  } catch {
    return formatDate(date);
  }
  const grab = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const month = grab("month");
  const day = grab("day");
  const year = grab("year");
  const dateText =
    display.dateFormat === "dmy" ? `${day} ${month} ${year}` : display.dateFormat === "ymd" ? `${year} ${month} ${day}` : `${month} ${day}, ${year}`;
  if (!display.withTime) return dateText;
  const dayPeriod = grab("dayPeriod");
  const time = dayPeriod ? `${grab("hour")}:${grab("minute")} ${dayPeriod}` : `${grab("hour")}:${grab("minute")}`;
  return `${dateText}, ${time}`;
}

export function formatIssue(issueNo: string | null | undefined): string {
  if (!issueNo) return "—";
  return `#${issueNo}`;
}

export function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
