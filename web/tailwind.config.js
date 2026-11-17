/** @type {import('tailwindcss').Config} */
const c = (v) => `rgb(var(--${v}) / <alpha-value>)`;
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: c("bg"),
        panel: c("panel"),
        panel2: c("panel-2"),
        raised: c("raised"),
        line: c("line"),
        fg: c("fg"),
        muted: c("muted"),
        faint: c("faint"),
        accent: c("accent"),
        "accent-ink": c("accent-ink"),
        ok: c("ok"),
        run: c("run"),
        warn: c("warn"),
        bad: c("bad"),
        idle: c("idle"),
      },
      fontFamily: {
        sans: ["Geist", "ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
        mono: ["Geist Mono", "ui-monospace", "Cascadia Mono", "Consolas", "monospace"],
      },
      fontSize: {
        xs: ["12px", "16px"],
        sm: ["13px", "18px"],
        base: ["14px", "20px"],
        md: ["16px", "22px"],
        lg: ["20px", "28px"],
        xl: ["28px", "34px"],
      },
      borderRadius: { DEFAULT: "6px", sm: "4px", md: "6px", lg: "6px" },
      transitionTimingFunction: { out: "cubic-bezier(0.16, 1, 0.3, 1)" },
      transitionDuration: { 120: "120ms", 150: "150ms", 180: "180ms" },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "pulse-dot": { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.35" } },
        shimmer: { "0%": { backgroundPosition: "-400px 0" }, "100%": { backgroundPosition: "400px 0" } },
        // `scale` (not `transform`) so the fill does not override -translate-x-1/2 centering on dialogs/palette or toast swipe
        "pop-in": { from: { opacity: "0", scale: ".98" }, to: { opacity: "1", scale: "1" } },
      },
      animation: {
        "fade-in": "fade-in 120ms ease-out both",
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
        shimmer: "shimmer 1.4s linear infinite",
        "pop-in": "pop-in 150ms cubic-bezier(0.16, 1, 0.3, 1) both",
      },
    },
  },
  plugins: [],
};
