"""Stage 2b - clip selection with Claude (PAID API): propose -> judge -> rerank. Rank, don't predict.

Usage:
  python clipper/select_clips.py --id JOB [--top 10] [--min-s 15] [--max-s 90] [--dry-run]

Needs ANTHROPIC_API_KEY in .env (or any credential the SDK resolves). --dry-run needs none: it writes every
proposal prompt to selection/ and prints a token/cost estimate.

Pipeline (research/03, CLAUDE.md "Chosen stack"):
  1. propose  - Haiku 5.5 over overlapping ~12-min windows (coverage) + Sonnet 5.5 over the whole transcript
                (cross-video arcs). Clips are sentence-index ranges; hook_quote must match the first sentence.
  2. pool     - validate, drop near-duplicates (IoU), clamp to the duration window.
  3. judge    - Sonnet 5.5 by default (--judge-model haiku|sonnet|opus) per candidate with +-8 sentences of context: keep/reject, may move start/end by a few
                sentences to get a stronger hook or a clean ending, writes title + on-screen hook.
  4. rerank   - judge model, listwise over all kept clips, 3 shuffled orders, Borda average (kills position bias).
  5. finalize - silence-snapped cut points (sentences.snap_cut), diversity filter, top N.

Writes selection/proposals.json, selection/judged.json, selection/rerank.json, candidates.json (final, ranked),
review.md (human review sheet), selection/cost.json (tokens and USD).
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import job_dir, load_env, read_json, stage_banner, write_json  # noqa: E402
from sentences import frame_db, snap_cut  # noqa: E402
import cutsnap  # noqa: E402

HAIKU, SONNET, OPUS = "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"
PRICE = {HAIKU: (0.10, 0.50), SONNET: (2.00, 10.00), OPUS: (4.00, 20.00)}   # USD per MTok in/out (2026-11)
FALLBACK_OK = {SONNET, OPUS}          # server-side refusal fallback; Haiku 5.5 has none
MODELS = {"haiku": HAIKU, "sonnet": SONNET, "opus": OPUS}
JUDGE_MODEL = SONNET                  # judge + rerank; user asked for cheaper than Opus (2026-11-17). --judge-model
WINDOW_S, OVERLAP_S = 720, 120
JUDGE_CONTEXT = 8
RERANK_PASSES = 3
CATEGORIES = ["story", "insight", "funny", "hot_take", "emotional", "advice", "reveal", "other"]

RUBRIC = """\
You pick moments from a long video to post as vertical short clips (YouTube Shorts / TikTok / Reels) on a
top-tier channel. A viewer scrolling past has never seen this video. A clip is only worth posting if ALL hold:
1. HOOK - the first sentence (first 1-3 seconds) makes a cold viewer stop scrolling: a bold claim, a question,
   a surprising fact, conflict, or the start of a story with stakes. Not "so", "yeah", "anyway", or a reply to
   something we didn't hear.
2. SELF-CONTAINED - it makes sense with zero context: no unexplained "he/that/this thing" referring to earlier
   parts, no inside references the viewer can't follow.
3. PAYOFF - it delivers: a punchline, a reveal, a lesson, a strong opinion, an emotional beat.
4. CLEAN ENDING - it ends right after the payoff on a finished thought, not mid-story or on a trailing "and".
Most of any video is NOT clippable. Be selective; never pad the list.
Clips start and end on whole sentences: give the index of the first and last sentence (inclusive).
"""

TRANSCRIPT_NOTE = """\
Transcript format, one sentence per line:  S<index> [mm:ss] <speaker>: <text>  (+ optional signals)
Signals: (replayed 0.xx) = YouTube "Most replayed" level for that moment (1.0 = most replayed part of the video);
(LOUD) = noticeably louder than usual (laughter, shouting, excitement). Signals are hints, not proof.
"""


# ---------------------------------------------------------------- schemas

def _obj(props: dict, req: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": req or list(props), "additionalProperties": False}


SCORE = {"type": "integer", "description": "1-10"}   # structured outputs reject minimum/maximum; clamped in code
SCORE_KEYS = {"hook", "self_contained", "payoff", "ending", "overall"}


def clamp_scores(x):
    if isinstance(x, dict):
        return {k: (min(10, max(1, v)) if k in SCORE_KEYS and isinstance(v, int) else clamp_scores(v))
                for k, v in x.items()}
    if isinstance(x, list):
        return [clamp_scores(v) for v in x]
    return x
CANDIDATE = _obj({
    "start_sentence": {"type": "integer"}, "end_sentence": {"type": "integer"},
    "hook_quote": {"type": "string", "description": "first 6-12 words of the start sentence, copied verbatim"},
    "title": {"type": "string"}, "category": {"type": "string", "enum": CATEGORIES},
    "why": {"type": "string", "description": "one sentence: what makes it work"},
    "hook": SCORE, "self_contained": SCORE, "payoff": SCORE, "ending": SCORE})
PROPOSALS = _obj({"clips": {"type": "array", "items": CANDIDATE}})
JUDGEMENT = _obj({
    "verdict": {"type": "string", "enum": ["keep", "reject"]},
    "reason": {"type": "string"},
    "start_sentence": {"type": "integer"}, "end_sentence": {"type": "integer"},
    "hook_quote": {"type": "string"},
    "title": {"type": "string", "description": "<= 60 chars, curiosity without clickbait lies"},
    "on_screen_hook": {"type": "string", "description": "<= 8 words of text overlay for the first seconds"},
    "hook": SCORE, "self_contained": SCORE, "payoff": SCORE, "ending": SCORE, "overall": SCORE})
RANKING = _obj({"order": {"type": "array", "items": {"type": "string"}}})


# ---------------------------------------------------------------- Claude calls

class Claude:
    def __init__(self, cost_path: Path):
        import anthropic
        self.client = anthropic.Anthropic(max_retries=4)
        self.cost_path = cost_path
        self.usage: dict[str, dict] = {}
        self.lock = threading.Lock()

    def json(self, model: str, system: str, prompt: str, schema: dict, effort: str, label: str) -> dict:
        """One structured-output call; one retry with the validation error if the JSON is unusable."""
        msgs = [{"role": "user", "content": prompt}]
        for attempt in range(2):
            kw = dict(model=model, max_tokens=32000, system=system, messages=msgs,
                      output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}})
            if model in FALLBACK_OK:
                kw.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
            with self.client.beta.messages.stream(**kw) as stream:
                msg = stream.get_final_message()
            self._account(model, msg.usage)
            if msg.stop_reason == "refusal":
                raise RuntimeError(f"{label}: refused ({getattr(msg.stop_details, 'category', None)})")
            text = next((b.text for b in msg.content if b.type == "text"), "")
            try:
                if msg.stop_reason == "max_tokens":
                    raise ValueError("output hit max_tokens")
                return clamp_scores(json.loads(text))
            except ValueError as e:
                if attempt:
                    raise RuntimeError(f"{label}: unusable output: {e}") from e
                msgs = msgs + [{"role": "assistant", "content": text or "(empty)"},
                               {"role": "user", "content": f"That output was unusable ({e}). Reply again with "
                                                           f"complete JSON matching the schema."}]
        raise AssertionError

    def _account(self, model: str, u) -> None:
        with self.lock:
            a = self.usage.setdefault(model, {"calls": 0, "input": 0, "output": 0, "cache_read": 0})
            a["calls"] += 1
            a["input"] += (u.input_tokens or 0) + (getattr(u, "cache_creation_input_tokens", 0) or 0)
            a["output"] += u.output_tokens or 0
            a["cache_read"] += getattr(u, "cache_read_input_tokens", 0) or 0

    def save_cost(self) -> float:
        total = 0.0
        out = {}
        for m, a in self.usage.items():
            pin, pout = PRICE.get(m, (0, 0))
            usd = (a["input"] * pin + a["cache_read"] * pin * 0.1 + a["output"] * pout) / 1e6
            out[m] = {**a, "usd": round(usd, 4)}
            total += usd
        write_json(self.cost_path, {"models": out, "total_usd": round(total, 4)})
        # cost.json is this run only; the history keeps every paid run so spend totals are true
        with (self.cost_path.parent / "cost_history.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "judge_model": JUDGE_MODEL,
                                "models": out, "total_usd": round(total, 4)}) + "\n")
        return total


# ---------------------------------------------------------------- transcript rendering

def mmss(t: float) -> str:
    return f"{int(t // 60):02d}:{int(t % 60):02d}"


def render(sents: list[dict], a: int = 0, b: int | None = None, mark: tuple[int, int] | None = None) -> str:
    lines = []
    for s in sents[a:b]:
        sig = []
        if s.get("heat") is not None and s["heat"] >= 0.5:
            sig.append(f"(replayed {s['heat']:.2f})")
        if s.get("loud_z", 0) >= 1.5:
            sig.append("(LOUD)")
        tag = ""
        if mark:
            tag = ">> " if mark[0] <= s["i"] <= mark[1] else "   "
        lines.append(f"{tag}S{s['i']} [{mmss(s['start'])}] {s.get('speaker') or 'SPK'}: {s['text']}"
                     + (" " + " ".join(sig) if sig else ""))
    return "\n".join(lines)


def header(meta: dict, min_s: int, max_s: int) -> str:
    return (f"Video: \"{meta.get('title')}\" ({meta.get('channel') or 'unknown channel'}), "
            f"{meta['duration'] / 60:.0f} min.\nClip length must be {min_s}-{max_s} seconds "
            f"(sweet spot 25-60 s).\n")


def windows(sents: list[dict]) -> list[tuple[int, int]]:
    out, t, end = [], 0.0, sents[-1]["end"]
    while t < end:
        a = next(i for i, s in enumerate(sents) if s["end"] > t)
        b = max((i for i, s in enumerate(sents) if s["start"] < t + WINDOW_S), default=a) + 1
        out.append((a, b))
        if t + WINDOW_S >= end:
            break
        t += WINDOW_S - OVERLAP_S
    return out


# ---------------------------------------------------------------- validation helpers

def norm(t: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", t.lower()).strip()


MAX_HOOK_OFFSET = 6     # proposals: hook must start within this many words of the sentence (judge edits: anywhere)
MIN_TRIM_GAP_S = 0.10   # ...but only where there is a real pause to cut in


def hook_offset(quote: str, sents: list[dict], a: int, anywhere: bool = True) -> int | None:
    """Word offset inside sentence a where the verbatim hook_quote starts, or None if it isn't there.
    Tokens of sentence text map 1:1 to words.json words (sentence text = words joined by spaces)."""
    q = [t for t in (norm(w) for w in quote.split()) if t][:8]
    if not q:
        return None
    toks = [norm(w) for w in (sents[a]["text"] + " " + (sents[a + 1]["text"] if a + 1 < len(sents) else "")).split()]
    limit = len(sents[a]["text"].split()) - 1 if anywhere else min(MAX_HOOK_OFFSET, len(sents[a]["text"].split()) - 1)
    ks = range(0, limit + 1)
    score = {k: SequenceMatcher(None, " ".join(q), " ".join(toks[k: k + len(q)])).ratio() for k in ks}
    best = max(score, key=lambda k: (score[k], -k))     # closest match; ties go to the earlier start
    return best if score[best] >= 0.8 else None


def dur(sents, a, b) -> float:
    return sents[b]["end"] - sents[a]["start"]


def iou(a: tuple[int, int], b: tuple[int, int]) -> float:
    inter = max(0, min(a[1], b[1]) - max(a[0], b[0]) + 1)
    return inter / (max(a[1], b[1]) - min(a[0], b[0]) + 1)


def clean(c: dict, sents: list[dict], min_s: float, max_s: float, slack: float = 1.3,
          check_hook: bool = True) -> str | None:
    """Return a rejection reason, or None if the candidate is usable."""
    a, b = c["start_sentence"], c["end_sentence"]
    if not (0 <= a <= b < len(sents)):
        return f"sentence range {a}-{b} out of bounds"
    if check_hook and hook_offset(c["hook_quote"], sents, a, anywhere=False) is None:
        return f"hook_quote does not match S{a}"
    d = dur(sents, a, b)
    if d < min_s * 0.8 or d > max_s * slack:
        return f"duration {d:.0f}s outside {min_s}-{max_s}s"
    return None


# ---------------------------------------------------------------- stages

def propose(cl: Claude | None, sents, meta, min_s, max_s, outdir: Path, dry: bool) -> list[dict]:
    hdr = header(meta, min_s, max_s)
    jobs = []
    for k, (a, b) in enumerate(windows(sents)):
        prompt = (hdr + f"\nThis is part {k + 1} (S{a}-S{b - 1}) of the video. Propose every clip in THIS part "
                  "that meets the bar (often 0-4). Propose, don't filter hard: a stronger model reviews each one.\n\n"
                  + TRANSCRIPT_NOTE + "\n" + render(sents, a, b))
        jobs.append((f"window{k + 1:02d}", HAIKU, "medium", prompt))
    jobs.append(("fullpass", SONNET, "high",
                 hdr + "\nThis is the WHOLE video. Propose the 8-15 best clips anywhere in it, including ones that "
                 "only work because you can see the whole conversation (a setup and its payoff that are close "
                 "together). Order them best first.\n\n" + TRANSCRIPT_NOTE + "\n" + render(sents)))
    for label, model, _, prompt in jobs:
        (outdir / f"prompt_{label}.txt").write_text(RUBRIC + "\n---\n" + prompt, encoding="utf-8")
    if dry:
        return [{"_job": (label, model, len(RUBRIC + prompt) // 4)} for label, model, _, prompt in jobs]

    def run(job):
        label, model, effort, prompt = job
        try:
            res = cl.json(model, RUBRIC, prompt, PROPOSALS, effort, label)
        except Exception as e:     # one failed window must not sink the run
            print(f"  {label}: FAILED {e}", file=sys.stderr)
            return []
        print(f"  {label} ({model}): {len(res['clips'])} proposals", flush=True)
        return [dict(c, source=label) for c in res["clips"]]

    with ThreadPoolExecutor(4) as ex:
        return [c for batch in ex.map(run, jobs) for c in batch]


def pool(props: list[dict], sents, min_s, max_s) -> tuple[list[dict], list[dict]]:
    kept, dropped = [], []
    # Sonnet full-pass first: it saw the whole video, so on duplicates its version wins
    props = sorted(props, key=lambda c: (c["source"] != "fullpass",
                                         -(c["hook"] + c["self_contained"] + c["payoff"] + c["ending"])))
    for c in props:
        why = clean(c, sents, min_s, max_s)
        if why is None:
            dup = next((k for k in kept if iou((c["start_sentence"], c["end_sentence"]),
                                               (k["start_sentence"], k["end_sentence"])) >= 0.5), None)
            if dup:
                dup.setdefault("also_proposed_by", []).append(c["source"])
                why = f"duplicate of {dup['id']}"
            else:
                c["id"] = f"c{len(kept) + 1:02d}"
                kept.append(c)
                continue
        dropped.append(dict(c, dropped=why))
    return kept, dropped


def judge(cl: Claude, cands, sents, meta, min_s, max_s) -> list[dict]:
    hdr = header(meta, min_s, max_s)

    def run(c):
        a, b = c["start_sentence"], c["end_sentence"]
        lo, hi = max(0, a - JUDGE_CONTEXT), min(len(sents), b + JUDGE_CONTEXT + 1)
        prompt = (hdr + f"\nA first-pass model proposed this clip: S{a}-S{b} ({dur(sents, a, b):.0f} s), "
                  f"\"{c['title']}\" - {c['why']}\nLines marked >> are the proposed clip; the rest is context "
                  f"the viewer will NOT see.\n\n" + TRANSCRIPT_NOTE + "\n" + render(sents, lo, hi, mark=(a, b)) +
                  "\n\nJudge it as the final editor. You may move the start and end to any sentence shown "
                  f"(S{lo}-S{hi - 1}) if that gives a stronger hook or a cleaner ending; the result must still be "
                  f"{min_s}-{max_s} s. Reject it if no version meets every point of the bar. Score honestly: "
                  "overall 8+ only for clips you would post on a top channel today.")
        try:
            j = cl.json(JUDGE_MODEL, RUBRIC, prompt, JUDGEMENT, "high", f"judge {c['id']}")
        except Exception as e:
            print(f"  judge {c['id']}: FAILED {e}", file=sys.stderr)
            return dict(c, judge=None, judge_error=str(e))
        if j["verdict"] == "keep":
            # Judge edits are trusted on the hook: a quote we can't locate only means "start at the whole
            # sentence" (flagged for review), never a rejection. Range and duration errors still reject.
            why = clean(j, sents, min_s, max_s, slack=1.0, check_hook=False)
            if why:
                j = dict(j, verdict="reject", reason=f"judge's own edit invalid: {why}")
            elif hook_offset(j["hook_quote"], sents, j["start_sentence"]) is None:
                j = dict(j, hook_quote_unmatched=True)
        print(f"  judge {c['id']}: {j['verdict']} {j['overall']}/10", flush=True)
        return dict(c, judge=j)

    with ThreadPoolExecutor(4) as ex:
        return list(ex.map(run, cands))


def rerank(cl: Claude, kept, sents, meta) -> dict[str, float]:
    if len(kept) < 2:
        return {c["id"]: 0.0 for c in kept}
    ids = [c["id"] for c in kept]
    by = {c["id"]: c for c in kept}
    ranks: dict[str, list[int]] = {i: [] for i in ids}
    rng = random.Random(7)
    for p in range(RERANK_PASSES):
        order = ids[:]
        rng.shuffle(order)
        blocks = []
        for i in order:
            j = by[i]["judge"]
            blocks.append(f"[{i}] {dur(sents, j['start_sentence'], j['end_sentence']):.0f} s - \"{j['title']}\"\n"
                          + "\n".join(s["text"] for s in sents[j["start_sentence"]: j["end_sentence"] + 1]))
        prompt = (f"Video: \"{meta.get('title')}\". Below are {len(ids)} finished clips. Order ALL of them from "
                  "the one you would post first to the one you would post last, judging them against each "
                  "other on the bar (hook strength above all, then payoff, then self-containment). Return every "
                  "id exactly once.\n\n" + "\n\n".join(blocks))
        try:
            res = cl.json(JUDGE_MODEL, RUBRIC, prompt, RANKING, "high", f"rerank {p + 1}")
        except Exception as e:
            print(f"  rerank {p + 1}: FAILED {e}", file=sys.stderr)
            continue
        seen = [i for i in dict.fromkeys(res["order"]) if i in ranks]
        seen += [i for i in order if i not in seen]          # missing ids go last
        for r, i in enumerate(seen):
            ranks[i].append(r)
        print(f"  rerank {p + 1}: top {seen[:3]}", flush=True)
    return {i: (sum(v) / len(v) if v else float(len(ids))) for i, v in ranks.items()}


# ---------------------------------------------------------------- main

def write_review(d: Path, final: list[dict], meta: dict, sents: list[dict], cost: float) -> None:
    L = [f"# Clip review - {meta.get('title')}", "",
         f"Source: {meta.get('source')}  ", f"Selection cost: ${cost:.2f}. Edit `candidates.json` "
         "(`approved: true/false`) after watching; the render stage only renders approved clips.", ""]
    for c in final:
        L += [f"## {c['rank']}. {c['title']}  ({c['duration']:.0f} s, {mmss(c['cut_in'])}-{mmss(c['cut_out'])})", "",
              f"- **On-screen hook:** {c['on_screen_hook']}",
              f"- **Scores:** overall {c['scores']['overall']} | hook {c['scores']['hook']} | self-contained "
              f"{c['scores']['self_contained']} | payoff {c['scores']['payoff']} | ending {c['scores']['ending']}"
              f" | rerank avg position {c['rerank_pos'] + 1:.1f}",
              f"- **Why:** {c['why']}  ", f"- **Judge:** {c['judge_reason']}",
              f"- **Replay heat:** {c['max_heat'] if c['max_heat'] is not None else 'n/a'} | category {c['category']}",
              "", "> " + " ".join(s["text"] for s in sents[c["start_sentence"]: c["end_sentence"] + 1]), ""]
    if not final:
        L += ["**The judge kept no clips.** Check the rejected list below before trusting that.", ""]
    rejected = [c for c in read_json(d / "selection" / "judged.json")
                if not (c.get("judge") and c["judge"]["verdict"] == "keep")]
    if rejected:
        L += ["---", "", "## Rejected by the judge (check these too: judges can be too strict)", ""]
        for c in sorted(rejected, key=lambda c: -((c.get("judge") or {}).get("overall") or 0)):
            j = c.get("judge") or {}
            a, b = c["start_sentence"], c["end_sentence"]
            L += [f"- **{c['title']}** ({mmss(sents[a]['start'])}-{mmss(sents[b]['end'])}, "
                  f"{dur(sents, a, b):.0f} s, overall {j.get('overall', '?')}): {j.get('reason') or c.get('judge_error')}"]
    (d / "review.md").write_text("\n".join(L) + "\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--min-s", type=int, default=15)
    ap.add_argument("--max-s", type=int, default=90)
    ap.add_argument("--dry-run", action="store_true", help="write prompts + cost estimate, call nothing")
    ap.add_argument("--judge-model", choices=list(MODELS), default="sonnet",
                    help="model for judge + rerank: haiku (cheapest), sonnet (default), opus (best, ~2x sonnet)")
    args = ap.parse_args()
    global JUDGE_MODEL
    JUDGE_MODEL = MODELS[args.judge_model]

    t0 = stage_banner("select", args.id)
    d = job_dir(args.id)
    out = d / "selection"
    out.mkdir(exist_ok=True)
    if not (d / "sentences.json").exists():
        sys.exit("run clipper/sentences.py first")
    sents, meta = read_json(d / "sentences.json"), read_json(d / "meta.json")

    if args.dry_run:
        jobs = [p["_job"] for p in propose(None, sents, meta, args.min_s, args.max_s, out, dry=True)]
        est = sum(n * PRICE[m][0] / 1e6 for _, m, n in jobs)
        n_judge = min(30, 4 * len(jobs))
        # per-call sizes measured on the first real run (2026-11-17): judge ~2.2k in / ~0.5k out
        pj = PRICE[JUDGE_MODEL]
        est += n_judge * (2500 * pj[0] + 800 * pj[1]) / 1e6
        est += RERANK_PASSES * (n_judge * 300 * pj[0] + 1000 * pj[1]) / 1e6
        est += sum(4000 * PRICE[m][1] / 1e6 for _, m, _ in jobs)                         # proposal outputs
        print(f"{len(jobs)} proposal calls ({sum(n for *_, n in jobs):,} input tokens), ~{n_judge} judge calls, "
              f"{RERANK_PASSES} rerank calls.\nEstimated cost: ~${est:.2f} (PAID; rough - thinking tokens vary). "
              f"Prompts written to {out}")
        return

    load_env()
    cl = Claude(out / "cost.json")
    print("1/4 propose", flush=True)
    props = propose(cl, sents, meta, args.min_s, args.max_s, out, dry=False)
    cands, dropped = pool(props, sents, args.min_s, args.max_s)
    write_json(out / "proposals.json", {"kept": cands, "dropped": dropped})
    print(f"   {len(props)} proposals -> {len(cands)} unique valid candidates", flush=True)
    if not cands:
        sys.exit("no usable candidates")

    print("2/4 judge", flush=True)
    judged = judge(cl, cands, sents, meta, args.min_s, args.max_s)
    write_json(out / "judged.json", judged)
    kept = [c for c in judged if c.get("judge") and c["judge"]["verdict"] == "keep"]
    print(f"   {len(kept)}/{len(judged)} kept", flush=True)

    print("3/4 rerank", flush=True)
    pos = rerank(cl, kept, sents, meta)
    write_json(out / "rerank.json", pos)

    print("4/4 finalize", flush=True)
    db = frame_db(d / "audio16k.wav")
    words = read_json(d / "words.json")["words"]
    media = Path(meta["media"])
    fps_render = read_json(d / "probe.json")["fps_render"]
    final: list[dict] = []
    for c in sorted(kept, key=lambda c: (pos[c["id"]], -c["judge"]["overall"])):
        j = c["judge"]
        a, b = j["start_sentence"], j["end_sentence"]
        k = hook_offset(j["hook_quote"], sents, a) or 0
        w = sents[a]["w0"] + k
        if k and words[w]["start"] - words[w - 1]["end"] >= MIN_TRIM_GAP_S:
            cut_in, cut_out = snap_cut(sents, a, b, db, start=words[w]["start"], prev_end=words[w - 1]["end"])
        else:
            k = 0                                      # no pause to cut in: keep the whole first sentence
            cut_in, cut_out = snap_cut(sents, a, b, db)
        # start/end exactly on a camera cut that falls in the silence (no sliver of the previous shot)
        cut_in, cut_out, cut_notes = cutsnap.snap(media, fps_render, cut_in, cut_out,
                                                  words[sents[a]["w0"] + k]["start"], sents[b]["end"])
        if any(max(0.0, min(cut_out, f["cut_out"]) - max(cut_in, f["cut_in"]))
               > 0.3 * min(cut_out - cut_in, f["cut_out"] - f["cut_in"]) for f in final):
            continue                    # diversity: no two clips sharing >30% of the shorter one (same story twice)
        heats = [s["heat"] for s in sents[a: b + 1] if s.get("heat") is not None]
        final.append({"rank": len(final) + 1, "id": c["id"], "approved": None,
                      "start_sentence": a, "start_word_offset": k, "end_sentence": b, "cut_in": cut_in, "cut_out": cut_out,
                      "duration": round(cut_out - cut_in, 2), "title": j["title"],
                      "on_screen_hook": j["on_screen_hook"], "hook_quote": j["hook_quote"],
                      "category": c["category"], "why": c["why"], "judge_reason": j["reason"],
                      "scores": {k: j[k] for k in ("hook", "self_contained", "payoff", "ending", "overall")},
                      "rerank_pos": round(pos[c["id"]], 2), "max_heat": max(heats) if heats else None,
                      "proposed_by": [c["source"], *c.get("also_proposed_by", [])],
                      "speakers": sorted({s["speaker"] for s in sents[a: b + 1] if s.get("speaker")}),
                      "cut_notes": cut_notes})
        if len(final) >= args.top:
            break
    cost = cl.save_cost()
    # A new selection reuses clip ids (c01, c02, ...) for different moments, so earlier edits must not attach to
    # them. Archive (never delete) the previous edits folder.
    if (d / "edits").is_dir() and any((d / "edits").iterdir()):
        (d / "edits_superseded").mkdir(exist_ok=True)
        (d / "edits").rename(d / "edits_superseded" / time.strftime("%Y%m%d-%H%M%S"))
    write_json(d / "candidates.json", final)
    write_review(d, final, meta, sents, cost)
    print(f"{len(final)} clips -> {d / 'review.md'}  (${cost:.2f}, {time.perf_counter() - t0:.0f}s)")


if __name__ == "__main__":
    main()
