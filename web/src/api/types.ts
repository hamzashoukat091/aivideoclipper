// Copied verbatim from docs/UI_SPEC.md sections 4 and 5b (single source of truth). Do not edit here: change the spec first.
export type StageKey = "ingest"|"transcribe"|"diarize"|"sentences"|"select"|"reframe"|"render";
export type StageState = "done"|"missing"|"stale"|"partial"|"skipped"|"running"|"queued"|"failed";
export interface FileEntry { path: string; size: number; mtime: string; kind: "video"|"audio"|"json"|"text"|"image"|"subtitle"|"other"; url: string }
export interface Stage { key: StageKey; label: string; state: StageState; updated: string|null; note: string|null; outputs: FileEntry[] }
export interface ClipCounts { candidates: number; approved: number; rejected: number; pending: number; reframed: number; rendered: number; failed_checks: number }
export interface JobSummary {
  id: string; title: string; channel: string|null; source: string; duration: number|null;
  height: number|null; fps: number|null; created: string; updated: string;
  thumbnail_url: string|null;              // /api/jobs/<id>/thumbnail (server-generated jpg) or null before ingest
  stages: Stage[];                        // always all 7, in order
  clips: ClipCounts; cost_usd: number;     // cost from selection/cost.json, 0 if none
  active_run: RunInfo|null;                // queued or running run for this job
  warnings: string[];                      // meta.warnings + derived (e.g. "No HF_TOKEN: speakers unlabelled")
}
export interface JobDetail extends JobSummary {
  meta: Record<string, unknown>|null; probe: Record<string, unknown>|null;
  heatmap: {start:number; end:number; value:number}[]; chapters: {start:number; end:number; title:string}[];
  source_media: { url: string; playable_hint: boolean; proxy_url: string|null } | null; // playable_hint: mp4/webm with h264/vp9/av1
  info: { webpage_url?: string; upload_date?: string; view_count?: number; thumbnail?: string } | null;
  speakers: {id:string; seconds:number; share:number}[];   // from diarization.json or []
}
export interface Sentence { i:number; start:number; end:number; speaker:string|null; text:string; heat:number|null; loud_z:number; pause_before?:number; pause_after?:number }
export interface Transcript { language: string|null; model: string|null; sentences: Sentence[]; word_count: number }
export interface Scores { hook:number; self_contained:number; payoff:number; ending:number; overall:number }
export interface Candidate {
  rank:number; id:string; approved: boolean|null; start_sentence:number; start_word_offset?:number; end_sentence:number;
  cut_in:number; cut_out:number; duration:number; title:string; on_screen_hook:string; hook_quote:string; category:string;
  why:string; judge_reason:string; scores:Scores; rerank_pos:number; max_heat:number|null; proposed_by:string[]; speakers:string[];
  cut_notes?: string[];                           // e.g. "start moved +0.250s to a camera cut" (clipper/cutsnap.py)
  // added by server:
  text: string;                                   // joined sentence text of the clip
  reframe: { state: StageState; url: string|null; preview_url: string|null; qa: Record<string, unknown>|null; layouts: string[] } ;
  render: { state: StageState; video_url: string|null; download_url: string|null; poster_url: string|null;
            report: RenderReport|null; captions_url: string|null };
}
export interface JudgeRejected { id:string; title:string; start_sentence:number|null; end_sentence:number|null; start:number|null; end:number|null; overall:number|null; reason:string|null; source:string }  // null when judged.json has a missing/out-of-range sentence index
export interface Selection { candidates: Candidate[]; rejected_by_judge: JudgeRejected[]; cost: Record<string, unknown>|null; review_md: string|null }
export interface RenderReport { clip:string; title?:string; source_range:[number,number]; frames_piped:number; frames_planned:number; render_seconds:number; loudness_in: Record<string,string>; output: Record<string, unknown>; checks: Record<string, boolean> }
export interface Shot { f0:number; f1:number; layout:"TRACK"|"GROUP"|"SPLIT"|"FIT"; faces:number; talk_share?:number[]; reason?:string;
  w?:number; h?:number; x?:number[]; speaker_track?:number[]; hard_cuts?:number[]; face_inside?:number;
  crop?:{x:number;y:number;w:number;h:number}; top?:{x:number;y:number;w:number;h:number}; bottom?:{x:number;y:number;w:number;h:number};
  hold_frame?:number }   // clip-relative source frame shown frozen for this whole (edge) shot: a camera cut inside speech
                         // within 0.5 s of the clip edge. The render shows THAT frame with this shot's framing; the UI
                         // overlay draws the crop on the held frame time (seek the source there) and labels it "Held frame".
export interface ReframePlan { clip:string; cut_in:number; cut_out:number; duration:number; fps:string; frames:number; src_w:number; src_h:number; out_w:number; out_h:number; speaker_evidence:string; asd_seconds?:number; analysis_seconds?:number; shots:Shot[]; qa:Record<string, unknown> }
export interface CaptionEvent { start:number; end:number; text:string; active:number|null; kind:"caption"|"hook" }
export interface Captions { events: CaptionEvent[]; url: string }   // url = raw .ass
export type RunAction = "prepare"|"ingest"|"transcribe"|"diarize"|"sentences"|"select"|"reframe"|"render"|"produce"|"proxy";
export interface RunStep { name: string; command: string[]; state: "queued"|"running"|"done"|"failed"|"skipped"|"cancelled"; started: string|null; ended: string|null; exit_code: number|null }
export interface RunInfo { id:string; job_id:string; action:RunAction; params:Record<string, unknown>; state:"queued"|"running"|"done"|"failed"|"cancelled";
  created:string; started:string|null; ended:string|null; steps:RunStep[]; current_step:number|null; log_url:string; stream_url:string; error:string|null }
export interface Estimate { usd:number|null; proposal_calls:number|null; judge_calls:number|null; input_tokens:number|null; judge_model:string; raw:string }
export interface SystemInfo { version:string; root:string; jobs_dir:string;
  tools: Record<string, {ok:boolean; version:string|null}>;            // ffmpeg, ffprobe, yt-dlp, deno, python, node
  keys: { anthropic:boolean; hf:boolean; elevenlabs:boolean };          // presence only, NEVER values
  assets: { yunet:boolean; lrasd:boolean; fonts:boolean };
  queue: { running: RunInfo|null; queued: RunInfo[] };
  spend: { total_usd:number; by_job: {job_id:string; usd:number}[] } }

// --- section 5b: clip editing ---
export interface ShotEdit { at: number;                 // source time (s) inside the shot it applies to (stable key)
  layout: "AUTO"|"TRACK"|"FIXED"|"GROUP"|"SPLIT"|"FIT";  // AUTO = keep the automatic plan for this shot
  x?: number;                                           // FIXED: crop left edge in source px (crop w = h*9/16, full height)
  crop?: {x:number;y:number;w:number;h:number} }        // GROUP: 9:16 crop box in source px
export interface Edits { version: 1;
  trim: { cut_in: number; cut_out: number } | null;     // null = the selection's cut
  shots: ShotEdit[];
  words: Record<string, string>;                        // global word index -> replacement text ("" hides the word)
  hook: { text: string; enabled: boolean; seconds: number };      // defaults: candidate.on_screen_hook, true, 3
  captions: { enabled: boolean; position: "auto"|"upper"|"middle"|"lower"; size: number };  // size px, 64-110, default 84
  title: string | null }                                // null = candidate.title
export interface EditContext { edits: Edits; original: { cut_in:number; cut_out:number; title:string; hook:string };
  words: { i:number; w:string; start:number; end:number }[];   // words from 10 s before cut_in to 10 s after cut_out
  limits: { min_s:number; max_s:number; source_duration:number };
  plan_range: { cut_in:number; cut_out:number } | null;        // range the current reframe plan covers
  needs: ("reframe"|"render")[] }                       // what must run for the saved edits to show in the video
