import { Check, Keyboard, RotateCcw, X } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router-dom";
import { MOCK } from "@/api/client";
import { useSystem } from "@/api/hooks";
import { Button } from "@/components/ui/Button";
import { ErrorState, SkeletonRows } from "@/components/ui/Feedback";
import { CopyButton, Section, Switch } from "@/components/ui/Misc";
import { Segmented } from "@/components/ui/Segmented";
import { cn } from "@/lib/cn";
import { fmtUsd } from "@/lib/format";
import { JUDGE_MODELS, resetDefaults, setDefaults, useDefaults, type JudgeModel } from "@/lib/settings";
import { setUI } from "@/lib/ui-store";

type Need = "required" | "recommended" | "optional";

function Ok({ ok, need }: { ok: boolean; need: Need }) {
  if (ok) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-ok">
        <Check className="size-4" aria-hidden /> present
      </span>
    );
  }
  // an unset optional key is not an error: no red
  return need === "optional" ? (
    <span className="text-sm text-faint">not set</span>
  ) : (
    <span className={cn("inline-flex items-center gap-1 text-sm", need === "required" ? "text-bad" : "text-warn")}>
      <X className="size-4" aria-hidden /> missing
    </span>
  );
}

const KEY_HELP: Record<string, { env: string; what: string; how: string; need: Need }> = {
  anthropic: { need: "required", env: "ANTHROPIC_API_KEY", what: "Clip selection (PAID).", how: "console.anthropic.com → API keys" },
  hf: { need: "recommended", env: "HF_TOKEN", what: "Speaker diarization (pyannote community-1). Accept the model terms on Hugging Face first.", how: "huggingface.co → Settings → Access tokens" },
  elevenlabs: { need: "optional", env: "ELEVENLABS_API_KEY", what: "Optional: Scribe ASR (PAID, untested here).", how: "elevenlabs.io → API keys" },
};

const ASSET_HELP: Record<string, string> = {
  yunet: "YuNet face model (models/face_detection_yunet_2023mar.onnx)",
  lrasd: "LR-ASD active-speaker model (vendor/LR-ASD)",
  fonts: "Montserrat caption fonts (assets/fonts)",
};

function Defaults() {
  const d = useDefaults();
  const uid = useId();
  return (
    <Section
      title="Defaults"
      id={`${uid}-h`}
      actions={
        <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={resetDefaults}>
          Reset
        </Button>
      }
    >
      <div className="space-y-5">
        <div>
          <div className="mb-2 text-sm text-fg">Judge model for clip selection</div>
          <Segmented<JudgeModel> label="Default judge model" value={d.judgeModel} onChange={(v) => setDefaults({ judgeModel: v })} options={JUDGE_MODELS.map((m) => ({ value: m.id, label: m.label }))} />
          <p className="mt-1.5 text-xs text-muted">{JUDGE_MODELS.find((m) => m.id === d.judgeModel)?.tradeoff} You always confirm the estimate before anything is spent.</p>
        </div>
        <div className="flex items-center justify-between gap-4">
          <label htmlFor={`${uid}-top`} className="text-sm text-fg">
            Top N clips to keep
            <span className="block text-xs text-muted">select_clips.py --top</span>
          </label>
          <input
            id={`${uid}-top`}
            type="number"
            min={1}
            max={50}
            value={d.topN}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 50) setDefaults({ topN: n });
            }}
            className="h-8 w-20 rounded border border-line bg-bg px-2 font-mono text-sm text-fg tnum focus:border-accent/70 focus:outline-none"
          />
        </div>
        <Switch id={`${uid}-fast`} checked={d.fastRenders} onChange={(v) => setDefaults({ fastRenders: v })} label="Fast renders" description="render.py --fast: a quicker encode for checking. Final renders use x264 slow CRF 16." />
        <Switch id={`${uid}-prev`} checked={d.previewReframes} onChange={(v) => setDefaults({ previewReframes: v })} label="Reframe previews" description="reframe.py --preview: also writes reframe/<clip>_preview.mp4 to watch before rendering." />
        <Switch id={`${uid}-scroll`} checked={d.autoScrollLogs} onChange={(v) => setDefaults({ autoScrollLogs: v })} label="Auto-scroll logs" description="Follow new lines in run consoles." />
        <p className="text-xs text-faint">Saved in this browser (localStorage).</p>
      </div>
    </Section>
  );
}

export default function SettingsPage() {
  const sys = useSystem();
  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-lg font-semibold text-fg">Settings</h1>
        <Button size="sm" icon={<Keyboard className="size-3.5" aria-hidden />} onClick={() => setUI({ shortcuts: true })}>
          Keyboard shortcuts
        </Button>
      </div>
      {MOCK ? (
        <p className="rounded border border-warn/30 bg-warn/[0.07] px-3 py-2 text-sm text-fg">
          Mock mode (VITE_MOCK=1): data comes from fixtures built from data/jobs/test_fallon. Runs are simulated and nothing is spent.
        </p>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          {sys.isLoading ? (
            <SkeletonRows rows={8} />
          ) : sys.isError ? (
            <div className="rounded border border-line bg-panel">
              <ErrorState error={sys.error} onRetry={() => void sys.refetch()} />
            </div>
          ) : sys.data ? (
            <>
              <Section title="System checks" bodyClass="p-0">
                <table className="w-full text-sm">
                  <caption className="sr-only">Tools</caption>
                  <tbody>
                    {Object.entries(sys.data.tools).map(([name, t]) => (
                      <tr key={name} className="border-b border-line/60 last:border-b-0">
                        <th scope="row" className="px-4 py-2 text-left font-mono font-normal text-fg">
                          {name}
                        </th>
                        <td className="px-2 py-2 font-mono text-xs text-muted">{t.version ?? "—"}</td>
                        <td className="px-4 py-2 text-right">
                          {t.ok ? (
                            <span className="inline-flex items-center gap-1 text-ok">
                              <Check className="size-4" aria-hidden /> ok
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-bad">
                              <X className="size-4" aria-hidden /> not found
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
              <Section title="API keys" bodyClass="p-0">
                <ul className="divide-y divide-line/60">
                  {(Object.keys(sys.data.keys) as (keyof typeof sys.data.keys)[]).map((k) => {
                    const h = KEY_HELP[k];
                    const ok = sys.data!.keys[k];
                    return (
                      <li key={k} className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-fg">{h?.env ?? k}</span>
                          <span className="ml-auto">
                            <Ok ok={ok} need={h?.need ?? "required"} />
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-muted">{h?.what}</p>
                        {!ok ? (
                          <div className="mt-2 rounded border border-line bg-bg/70 p-2 text-xs text-muted">
                            Add to <span className="font-mono text-fg">.env</span> in the project root, then restart the server:
                            <div className="mt-1 flex items-center gap-2">
                              <code className="flex-1 font-mono text-fg">{h?.env ?? k}=…</code>
                              <CopyButton text={`${h?.env ?? k}=`} label={`Copy ${h?.env ?? k} line`} />
                            </div>
                            <span className="mt-1 block text-faint">Get one at {h?.how}. Keys never leave the server; this page only sees present / missing.</span>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </Section>
              <Section title="Assets" bodyClass="p-0">
                <ul className="divide-y divide-line/60">
                  {Object.entries(sys.data.assets).map(([k, ok]) => (
                    <li key={k} className="flex items-center gap-2 px-4 py-2.5">
                      <span className="text-sm text-fg">{ASSET_HELP[k] ?? k}</span>
                      <span className="ml-auto">
                        <Ok ok={ok} need="required" />
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            </>
          ) : null}
        </div>
        <div className="space-y-4">
          <Defaults />
          {sys.data ? (
            <>
              <Section title="Spend ledger" actions={<span className="font-mono text-md font-semibold text-fg tnum">{fmtUsd(sys.data.spend.total_usd)}</span>} bodyClass="p-0">
                {sys.data.spend.by_job.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-muted">Nothing spent yet.</p>
                ) : (
                  <ul className="divide-y divide-line/60">
                    {[...sys.data.spend.by_job]
                      .sort((a, b) => b.usd - a.usd)
                      .map((j) => (
                        <li key={j.job_id} className="flex items-center gap-2 px-4 py-2">
                          <Link to={`/jobs/${j.job_id}/clips`} className="font-mono text-sm text-fg hover:text-accent">
                            {j.job_id}
                          </Link>
                          <span className="ml-auto font-mono text-sm text-fg tnum">{fmtUsd(j.usd)}</span>
                        </li>
                      ))}
                  </ul>
                )}
                <p className="border-t border-line px-4 py-2 text-xs text-faint">From each job’s selection/cost.json. Clip selection is the only paid step.</p>
              </Section>
              <Section title="Paths & version" bodyClass="space-y-2">
                {[
                  ["Project root", sys.data.root],
                  ["Jobs folder", sys.data.jobs_dir],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2 text-sm">
                    <span className="w-28 shrink-0 text-muted">{k}</span>
                    <code className={cn("min-w-0 flex-1 truncate font-mono text-xs text-fg")} title={v}>
                      {v}
                    </code>
                    <CopyButton text={v} label={`Copy ${k.toLowerCase()}`} />
                  </div>
                ))}
                <div className="flex items-center gap-2 text-sm">
                  <span className="w-28 shrink-0 text-muted">Server version</span>
                  <code className="font-mono text-xs text-fg">{sys.data.version}</code>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="w-28 shrink-0 text-muted">UI version</span>
                  <code className="font-mono text-xs text-fg">0.1.0</code>
                </div>
              </Section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
