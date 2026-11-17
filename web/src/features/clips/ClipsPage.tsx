import { ArrowUpRight, CheckCircle2, ChevronDown, ChevronRight, Clapperboard, Download, FileText, Gavel, ListChecks, Play, Receipt } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, withDownload } from "@/api/client";
import { usePatchCandidate, useSelection } from "@/api/hooks";
import type { Candidate, JudgeRejected, Selection } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/Feedback";
import { CopyButton, ScoreBar } from "@/components/ui/Misc";
import { Chip, StateBadge } from "@/components/ui/Status";
import { Tooltip } from "@/components/ui/Tooltip";
import { useJobContext } from "@/features/job/context";
import { useRunAction } from "@/features/job/useRunAction";
import { cn } from "@/lib/cn";
import { fmtClock, fmtNumber, fmtSeconds, fmtUsd, num } from "@/lib/format";
import { useHotkeys } from "@/lib/hotkeys";
import { useDefaults } from "@/lib/settings";
import { isActive } from "@/lib/stages";
import { toast } from "@/lib/toast";
import { DecisionControl } from "./DecisionControl";

const COLS = "grid-cols-[28px_minmax(0,1fr)_64px_118px_150px] xl:grid-cols-[28px_minmax(0,1fr)_64px_118px_150px_96px_150px]";

function MiniScores({ c }: { c: Candidate }) {
  const s = c.scores;
  const items: [string, number][] = [
    ["H", s.hook],
    ["S", s.self_contained],
    ["P", s.payoff],
    ["E", s.ending],
  ];
  return (
    <div className="flex items-center gap-2" aria-label={`Scores: overall ${s.overall}, hook ${s.hook}, self-contained ${s.self_contained}, payoff ${s.payoff}, ending ${s.ending}`}>
      <div className="flex h-6 items-end gap-0.5" aria-hidden>
        {items.map(([k, v]) => (
          <Tooltip key={k} content={`${{ H: "Hook", S: "Self-contained", P: "Payoff", E: "Ending" }[k]}: ${v}/10`}>
            <span className="flex w-2.5 flex-col items-center">
              <span className="w-full rounded-sm bg-raised" style={{ height: 18 }}>
                <span className={cn("block w-full rounded-sm", v >= 8 ? "bg-ok" : v >= 6 ? "bg-accent" : v >= 4 ? "bg-warn" : "bg-bad")} style={{ height: `${(v / 10) * 18}px`, marginTop: `${18 - (v / 10) * 18}px` }} />
              </span>
            </span>
          </Tooltip>
        ))}
      </div>
      <span className="font-mono text-md font-semibold text-fg tnum">{s.overall}</span>
      <span className="text-xs text-faint">/10</span>
    </div>
  );
}

function Expanded({ c, jobId }: { c: Candidate; jobId: string }) {
  return (
    <div className="grid gap-4 border-t border-line/70 bg-bg/40 px-4 py-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="space-y-3 text-sm">
        <div>
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Why</h4>
          <p className="text-fg/90">{c.why}</p>
        </div>
        <div>
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Judge reason</h4>
          <p className="text-fg/90">{c.judge_reason}</p>
        </div>
        <div>
          <h4 className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-faint">
            Full text <CopyButton text={c.text} label="Copy clip text" />
          </h4>
          <p className="max-h-48 overflow-y-auto rounded border border-line bg-panel p-2.5 leading-relaxed text-muted">{c.text}</p>
        </div>
      </div>
      <div className="space-y-3 text-sm">
        <div>
          <h4 className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-faint">
            On-screen hook <CopyButton text={c.on_screen_hook} label="Copy on-screen hook" />
          </h4>
          <p className="font-semibold uppercase tracking-wide text-fg">{c.on_screen_hook}</p>
        </div>
        <div>
          <h4 className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-faint">
            Hook quote <CopyButton text={c.hook_quote} label="Copy hook quote" />
          </h4>
          <blockquote className="border-l-2 border-accent/60 pl-3 italic text-fg/90">“{c.hook_quote}”</blockquote>
        </div>
        <div className="space-y-1.5 rounded border border-line bg-panel p-3">
          <ScoreBar label="Hook" value={c.scores.hook} />
          <ScoreBar label="Self-contained" value={c.scores.self_contained} />
          <ScoreBar label="Payoff" value={c.scores.payoff} />
          <ScoreBar label="Ending" value={c.scores.ending} />
          <ScoreBar label="Overall" value={c.scores.overall} />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted">Cut</dt>
          <dd className="font-mono text-fg tnum">
            {c.cut_in.toFixed(3)} → {c.cut_out.toFixed(3)} s ({fmtSeconds(c.duration, 2)})
          </dd>
          <dt className="text-muted">Sentences</dt>
          <dd className="font-mono text-fg tnum">
            S{c.start_sentence}
            {c.start_word_offset ? `+${c.start_word_offset}w` : ""} – S{c.end_sentence}
          </dd>
          <dt className="text-muted">Rerank</dt>
          <dd className="font-mono text-fg tnum">avg position {c.rerank_pos.toFixed(2)}</dd>
          <dt className="text-muted">Max heat</dt>
          <dd className="font-mono text-fg tnum">{c.max_heat === null ? "—" : c.max_heat.toFixed(3)}</dd>
          <dt className="text-muted">Proposed by</dt>
          <dd className="font-mono text-fg">{c.proposed_by.join(", ") || "—"}</dd>
          <dt className="text-muted">Speakers</dt>
          <dd className="font-mono text-fg">{c.speakers.length ? c.speakers.join(", ") : "unlabelled"}</dd>
          <dt className="text-muted">Layouts</dt>
          <dd className="font-mono text-fg">{c.reframe.layouts.join(", ") || "—"}</dd>
        </dl>
        <Link to={`/jobs/${jobId}/clips/${c.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
          Open in Studio <ArrowUpRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

function CostCard({ sel, jobId }: { sel: Selection; jobId: string }) {
  const models = sel.cost && typeof sel.cost.models === "object" && sel.cost.models !== null ? (sel.cost.models as Record<string, Record<string, unknown>>) : {};
  const total = num(sel.cost?.total_usd);
  return (
    <section aria-labelledby="cost-h" className="rounded border border-line bg-panel">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Receipt className="size-4 text-muted" aria-hidden />
        <h2 id="cost-h" className="text-sm font-medium text-fg">
          Selection cost
        </h2>
        <span className="ml-auto font-mono text-md font-semibold text-fg tnum">{fmtUsd(total)}</span>
      </header>
      {Object.keys(models).length ? (
        <table className="w-full text-sm">
          <caption className="sr-only">Cost per model</caption>
          <thead>
            <tr className="text-left text-xs text-faint">
              <th scope="col" className="px-4 py-2 font-medium">Model</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Calls</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">In</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Out</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">USD</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(models).map(([m, v]) => (
              <tr key={m} className="border-t border-line/60">
                <td className="break-all px-4 py-1.5 font-mono text-xs text-fg">
                  {m}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-xs text-muted tnum">{fmtNumber(num(v.calls))}</td>
                <td className="px-2 py-1.5 text-right font-mono text-xs text-muted tnum">{fmtNumber(num(v.input))}</td>
                <td className="px-2 py-1.5 text-right font-mono text-xs text-muted tnum">{fmtNumber(num(v.output))}</td>
                <td className="px-4 py-1.5 text-right font-mono text-xs text-fg tnum">{fmtUsd(num(v.usd), 4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-4 py-3 text-sm text-muted">No cost.json for this job.</p>
      )}
      <div className="flex gap-3 border-t border-line px-4 py-2 text-xs">
        <Link to={`/jobs/${jobId}/files?path=selection%2Fcost.json`} className="text-muted hover:text-fg">
          cost.json
        </Link>
        {sel.review_md ? (
          <Link to={`/jobs/${jobId}/files?path=review.md`} className="inline-flex items-center gap-1 text-muted hover:text-fg">
            <FileText className="size-3" aria-hidden /> review.md
          </Link>
        ) : null}
      </div>
    </section>
  );
}

function JudgeRejectedList({ items, jobId }: { items: JudgeRejected[]; jobId: string }) {
  return (
    <section aria-labelledby="rej-h" className="rounded border border-line bg-panel">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Gavel className="size-4 text-muted" aria-hidden />
        <h2 id="rej-h" className="text-sm font-medium text-fg">
          Rejected by the judge
        </h2>
        <span className="ml-auto text-xs text-muted">{items.length}</span>
      </header>
      {items.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted">The judge kept every proposal.</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {items.map((r) => (
            <li key={r.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-xs text-faint">{r.id}</span>
                <span className="min-w-0 flex-1 text-sm text-fg">{r.title}</span>
                {r.overall !== null ? <Chip mono>{r.overall}/10</Chip> : null}
                <Chip mono title="Proposed by">{r.source}</Chip>
              </div>
              <p className="mt-1 text-sm text-muted">{r.reason ?? "No reason recorded."}</p>
              <p className="mt-1 flex items-center gap-3 font-mono text-xs text-faint tnum">
                {r.start !== null ? fmtClock(r.start) : "—"}–{r.end !== null ? fmtClock(r.end) : "—"} · S{r.start_sentence ?? "—"}–S{r.end_sentence ?? "—"}
                {r.start !== null ? (
                  <Link to={`/jobs/${jobId}/source?t=${r.start.toFixed(2)}`} className="font-sans text-accent hover:underline">
                    Watch in source
                  </Link>
                ) : (
                  <span className="font-sans text-faint">no valid sentence range</span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function ClipsPage() {
  const { job } = useJobContext();
  const navigate = useNavigate();
  const sel = useSelection(job.id);
  const patch = usePatchCandidate(job.id);
  const actions = useRunAction(job.id);
  const defaults = useDefaults();
  const [focus, setFocus] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const cands = useMemo(() => sel.data?.candidates ?? [], [sel.data]);
  const busy = isActive(job.active_run);

  useEffect(() => {
    if (focus >= cands.length && cands.length) setFocus(cands.length - 1);
  }, [cands.length, focus]);

  const decide = (c: Candidate, v: boolean | null) => {
    if (c.approved === v) return;
    patch.mutate(
      { cid: c.id, approved: v },
      {
        onError: (e) =>
          toast({ tone: "error", title: `Could not update ${c.id}`, description: e instanceof ApiError ? `${e.message} (${e.code})` : String(e) }),
      },
    );
  };
  const move = (d: number) => {
    if (!cands.length) return;
    const n = Math.max(0, Math.min(cands.length - 1, focus + d));
    setFocus(n);
    rowRefs.current[n]?.focus();
    rowRefs.current[n]?.scrollIntoView({ block: "nearest" });
  };
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  useHotkeys(
    {
      j: () => move(1),
      k: () => move(-1),
      a: () => cands[focus] && decide(cands[focus], true),
      r: () => cands[focus] && decide(cands[focus], false),
      u: () => cands[focus] && decide(cands[focus], null),
      x: () => cands[focus] && toggle(cands[focus].id),
      enter: () => cands[focus] && navigate(`/jobs/${job.id}/clips/${cands[focus].id}`),
    },
    cands.length > 0,
  );

  if (sel.isLoading) return <SkeletonRows rows={6} className="p-6" />;
  if (sel.isError) {
    if (sel.error instanceof ApiError && sel.error.status === 404) {
      return (
        <EmptyState
          icon={ListChecks}
          title="No clips selected yet"
          className="py-20"
          action={
            <Link to={`/jobs/${job.id}`} className="press inline-flex h-8 items-center rounded bg-accent px-3 text-sm font-medium text-accent-ink hover:bg-accent/90">
              Go to the pipeline
            </Link>
          }
        >
          Clip selection is the PAID step. Run it from the Overview after checking the free estimate.
        </EmptyState>
      );
    }
    return <ErrorState error={sel.error} onRetry={() => void sel.refetch()} className="py-20" />;
  }
  const data = sel.data!;
  const approved = cands.filter((c) => c.approved === true);
  const rendered = cands.filter((c) => c.render.state === "done" || c.render.state === "failed");
  const exportIds = (approved.some((c) => rendered.includes(c)) ? approved.filter((c) => rendered.includes(c)) : rendered).map((c) => c.id);
  const counts = { yes: approved.length, no: cands.filter((c) => c.approved === false).length, none: cands.filter((c) => c.approved === null).length };

  return (
    <div className="grid gap-4 p-4 sm:p-6 2xl:grid-cols-[minmax(0,1fr)_380px] 2xl:items-start">
      <section aria-labelledby="clips-h" className="min-w-0 rounded border border-line bg-panel">
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
          <h2 id="clips-h" className="text-sm font-medium text-fg">
            Candidates
          </h2>
          <span className="text-xs text-muted">
            <span className="text-ok">{counts.yes} approved</span> · <span className="text-warn">{counts.none} undecided</span> · <span className="text-bad">{counts.no} rejected</span>
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Tooltip content={busy ? "A run is active for this job" : approved.length ? `render.py --clip ${approved.map((c) => c.id).join(" ")}${defaults.fastRenders ? " --fast" : ""}` : "Approve clips first"}>
              <span tabIndex={busy || !approved.length ? 0 : -1} className="inline-flex">
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Play className="size-3.5" aria-hidden />}
                  disabled={busy || !approved.length || actions.pending}
                  onClick={() => actions.run({ action: "render", clips: approved.map((c) => c.id), fast: defaults.fastRenders })}
                >
                  Render approved ({approved.length})
                </Button>
              </span>
            </Tooltip>
            <Tooltip content={exportIds.length ? `Zip: ${exportIds.join(", ")} (MP4, report, captions, candidates.json, review.md)` : "Nothing rendered yet"}>
              {exportIds.length ? (
                <a
                  href={`/api/jobs/${encodeURIComponent(job.id)}/export.zip?clips=${exportIds.join(",")}`}
                  download
                  className="press inline-flex h-7 items-center gap-1.5 rounded border border-line px-2.5 text-sm text-fg hover:bg-fg/[0.05]"
                >
                  <Download className="size-3.5" aria-hidden /> Export zip
                </a>
              ) : (
                <span tabIndex={0} className="inline-flex h-7 cursor-not-allowed items-center gap-1.5 rounded border border-line px-2.5 text-sm text-fg opacity-45">
                  <Download className="size-3.5" aria-hidden /> Export zip
                </span>
              )}
            </Tooltip>
          </div>
        </header>

        {cands.length === 0 ? (
          <EmptyState icon={Clapperboard} title="Selection returned no clips">
            The judge rejected every proposal. See the list of rejections and their reasons.
          </EmptyState>
        ) : (
          <div role="list" aria-label="Clip candidates">
            <div className={cn("grid items-center gap-3 border-b border-line px-4 py-2 text-xs text-faint", COLS)} aria-hidden>
              <span>#</span>
              <span>Clip</span>
              <span className="text-right">Length</span>
              <span>Cut (source)</span>
              <span>Scores</span>
              <span className="hidden xl:block">Pipeline</span>
              <span className="hidden text-right xl:block">Decision</span>
            </div>
            {cands.map((c, i) => {
              const isOpen = open.has(c.id);
              return (
                <div key={c.id} role="listitem" className={cn("border-b border-line/60 last:border-b-0", c.approved === false && "opacity-60")}>
                  <div
                    ref={(el) => {
                      rowRefs.current[i] = el;
                    }}
                    tabIndex={focus === i ? 0 : -1}
                    onFocus={() => setFocus(i)}
                    aria-label={`Rank ${c.rank}: ${c.title}`}
                    className={cn("row-hover grid items-center gap-3 px-4 py-2.5 focus-visible:outline-offset-[-2px]", COLS, focus === i && "bg-fg/[0.03] shadow-[inset_2px_0_0_rgb(var(--accent)/0.7)]")}
                  >
                    <span className="font-mono text-sm text-muted tnum">{c.rank}</span>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setFocus(i);
                            toggle(c.id);
                          }}
                          aria-expanded={isOpen}
                          aria-label={isOpen ? `Collapse ${c.id}` : `Expand ${c.id}`}
                          className="press -ml-1 rounded p-0.5 text-faint hover:text-fg"
                        >
                          {isOpen ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
                        </button>
                        <Link to={`/jobs/${job.id}/clips/${c.id}`} className="truncate text-sm font-medium text-fg hover:text-accent" title={c.title}>
                          {c.title}
                        </Link>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 pl-5">
                        <span className="font-mono text-xs text-faint">{c.id}</span>
                        <Chip>{c.category}</Chip>
                        <span className="truncate text-xs text-muted" title={c.on_screen_hook}>
                          “{c.on_screen_hook}”
                        </span>
                        <span className="flex items-center gap-1.5 xl:hidden">
                          {c.render.state !== "done" ? <StateBadge state={c.render.state} label={`render ${c.render.state}`} /> : null}
                          <DecisionControl size="sm" clipId={c.id} value={c.approved} onChange={(v) => decide(c, v)} />
                        </span>
                      </div>
                    </div>
                    <span className="text-right font-mono text-sm text-fg tnum">{fmtSeconds(c.duration)}</span>
                    <span className="font-mono text-xs text-muted tnum">
                      {fmtClock(c.cut_in, { ms: true })}
                      <br />
                      {fmtClock(c.cut_out, { ms: true })}
                    </span>
                    <div className="min-w-0">
                      <MiniScores c={c} />
                      <div className="mt-0.5 font-mono text-xs text-faint tnum">
                        rr {c.rerank_pos.toFixed(1)} · heat {c.max_heat === null ? "—" : c.max_heat.toFixed(2)}
                      </div>
                    </div>
                    <div className="hidden flex-col items-start gap-1 xl:flex">
                      {c.reframe.state === "done" && c.render.state === "done" ? (
                        <Tooltip content="Reframed and rendered">
                          <span tabIndex={0} className="inline-flex items-center gap-1 text-xs text-ok">
                            <CheckCircle2 className="size-3.5" aria-hidden /> ready
                          </span>
                        </Tooltip>
                      ) : (
                        <>
                          {c.reframe.state !== "done" ? <StateBadge state={c.reframe.state} label={`reframe ${c.reframe.state}`} /> : null}
                          {c.render.state !== "done" ? <StateBadge state={c.render.state} label={`render ${c.render.state}`} /> : null}
                        </>
                      )}
                    </div>
                    <div className="hidden justify-end xl:flex">
                      <DecisionControl clipId={c.id} value={c.approved} onChange={(v) => decide(c, v)} />
                    </div>
                  </div>
                  {isOpen ? <Expanded c={c} jobId={job.id} /> : null}
                </div>
              );
            })}
          </div>
        )}
      </section>
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-1">
        <CostCard sel={data} jobId={job.id} />
        <JudgeRejectedList items={data.rejected_by_judge} jobId={job.id} />
      </div>
      {rendered.length ? (
        <p className="text-xs text-muted 2xl:col-span-2">
          Single files:{" "}
          {rendered.map((c, i) => (
            <span key={c.id}>
              {i ? " · " : ""}
              {c.render.download_url ? (
                <a href={c.render.download_url} className="font-mono hover:text-fg" download>
                  {c.id}.mp4
                </a>
              ) : null}
              {c.render.captions_url ? (
                <a href={withDownload(c.render.captions_url)} className="ml-1.5 font-mono hover:text-fg" download>
                  .ass
                </a>
              ) : null}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
