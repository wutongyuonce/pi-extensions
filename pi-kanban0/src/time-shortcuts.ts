export interface TimeShortcut {
  label: string;
  value?: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localDate(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function cardTimeShortcuts(current = new Date()): TimeShortcut[] {
  const tomorrow = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate() + 1,
  );
  const today = localDate(current);
  const now = `${today} ${pad(current.getHours())}:${pad(current.getMinutes())}`;
  return [
    { label: `Today · ${today}`, value: today },
    { label: `Now · ${now}`, value: now },
    { label: `Tomorrow · ${localDate(tomorrow)}`, value: localDate(tomorrow) },
    { label: "Custom time…" },
  ];
}
