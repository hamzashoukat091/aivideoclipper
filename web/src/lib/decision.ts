export type Decision = boolean | null;
export function decisionStyle(v: Decision): { label: string; text: string; bg: string; stroke: string } {
  if (v === true) return { label: "Approved", text: "text-ok", bg: "bg-ok", stroke: "rgb(var(--ok))" };
  if (v === false) return { label: "Rejected", text: "text-bad", bg: "bg-bad", stroke: "rgb(var(--bad))" };
  return { label: "Undecided", text: "text-warn", bg: "bg-warn", stroke: "rgb(var(--warn))" };
}
