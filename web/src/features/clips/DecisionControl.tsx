import { Check, Circle, X } from "lucide-react";
import { Segmented } from "@/components/ui/Segmented";

type V = "yes" | "none" | "no";
const toV = (a: boolean | null): V => (a === true ? "yes" : a === false ? "no" : "none");
const fromV = (v: V): boolean | null => (v === "yes" ? true : v === "no" ? false : null);

/** Approve / undecided / reject segmented control (PATCH candidates/{cid}). */
export function DecisionControl({ value, onChange, disabled, size = "md", clipId }: { value: boolean | null; onChange: (v: boolean | null) => void; disabled?: boolean; size?: "sm" | "md"; clipId: string }) {
  return (
    <Segmented<V>
      size={size}
      label={`Decision for ${clipId}`}
      value={toV(value)}
      disabled={disabled}
      onChange={(v) => onChange(fromV(v))}
      options={[
        { value: "yes", ariaLabel: "Approve", title: "Approve (A)", label: <><Check className="size-3.5" aria-hidden /><span className="hidden 2xl:inline">Approve</span></>, activeClass: "data-[state=on]:text-ok data-[state=on]:bg-ok/15" },
        { value: "none", ariaLabel: "Undecided", title: "Undecided (U)", label: <Circle className="size-3" aria-hidden />, activeClass: "data-[state=on]:text-warn" },
        { value: "no", ariaLabel: "Reject", title: "Reject (R)", label: <><X className="size-3.5" aria-hidden /><span className="hidden 2xl:inline">Reject</span></>, activeClass: "data-[state=on]:text-bad data-[state=on]:bg-bad/15" },
      ]}
    />
  );
}
