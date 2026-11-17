import { useMemo, useState } from "react";
import type { Edits, Shot } from "@/api/types";
import { buildCaptionEvents, CAP, wrapHook, type PWord } from "@/lib/captionPreview";
import { containBox } from "@/lib/crop";
import { useElementSize } from "@/lib/useNow";

/**
 * Live caption + hook preview over the 9:16 view, drawn like captions.py renders them (Montserrat Black, caps,
 * #FFE500 active word, 7 px black outline, no shadow; hook = Montserrat ExtraBold 62 in a dark box at y 290).
 * Positions use the 1080×1920 PlayRes scaled to the displayed box.
 */
export function CaptionOverlay({
  words,
  t,
  clipDur,
  layoutAt,
  captions,
  hook,
}: {
  words: PWord[];
  t: number; // clip time
  clipDur: number;
  layoutAt: (t: number) => Shot["layout"] | null;
  captions: Edits["captions"];
  hook: Edits["hook"];
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(el);
  const box = containBox(width, height, 1080, 1920);
  const s = box.h / 1920;
  const events = useMemo(() => (captions.enabled ? buildCaptionEvents(words, clipDur, layoutAt, captions.position, captions.size) : []), [words, clipDur, layoutAt, captions.enabled, captions.position, captions.size]);
  const ev = events.find((e) => t >= e.start && t < e.end) ?? null;
  const showHook = hook.enabled && hook.text.trim() !== "" && t >= 0 && t < Math.min(hook.seconds, clipDur);
  const outline = CAP.outline * s;

  return (
    <div ref={setEl} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {box.w > 0 && ev ? (
        <div
          className="absolute whitespace-nowrap text-center"
          style={{
            left: box.x + box.w / 2,
            top: box.y + ev.y * s,
            transform: "translate(-50%, -50%)",
            fontFamily: '"Caption Black", "Montserrat", sans-serif',
            fontSize: captions.size * s,
            lineHeight: 1.1,
            color: "#FFFFFF",
            WebkitTextStroke: `${outline * 2}px #000`,
            paintOrder: "stroke fill",
          }}
        >
          {ev.tokens.map((tok, i) => (
            <span key={i} style={{ color: i === ev.active ? CAP.activeColor : "#FFFFFF" }}>
              {tok}
              {i < ev.tokens.length - 1 ? " " : ""}
            </span>
          ))}
        </div>
      ) : null}
      {box.w > 0 && showHook ? (
        <div
          className="absolute text-center"
          style={{
            left: box.x + box.w / 2,
            top: box.y + CAP.hookY * s,
            transform: "translate(-50%, -50%)",
            fontFamily: '"Caption ExtraBold", "Montserrat", sans-serif',
            fontSize: CAP.hookSize * s,
            lineHeight: 1.15,
            color: "#FFFFFF",
            background: "rgba(0,0,0,0.84)",
            padding: 22 * s, // BorderStyle 3 box: Outline 22 around the text
            maxWidth: box.w - 160 * s,
          }}
        >
          {wrapHook(hook.text).map((l, i) => (
            <div key={i} className="whitespace-nowrap">
              {l}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
