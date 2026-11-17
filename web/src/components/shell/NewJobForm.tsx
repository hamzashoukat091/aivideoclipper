import { Globe, HardDrive, Link2, Youtube } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, describeError } from "@/api/client";
import { useCreateJob } from "@/api/hooks";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Misc";
import { cn } from "@/lib/cn";
import { detectSource, JOB_ID_RE } from "@/lib/source";
import { ACTION_LABEL } from "@/lib/stages";
import { toast } from "@/lib/toast";

const LANGS: [string, string][] = [
  ["en", "English"],
  ["auto", "Auto-detect"],
  ["de", "German"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["ja", "Japanese"],
];

const KIND_ICON = { youtube: Youtube, url: Globe, local: HardDrive, empty: Link2, invalid: Link2 } as const;

const inputCls =
  "h-9 w-full rounded border border-line bg-bg px-3 text-sm text-fg placeholder:text-faint transition-colors focus:border-accent/70 focus:outline-none focus-visible:outline-none focus:ring-2 focus:ring-accent/30 aria-[invalid=true]:border-bad/60";

export function NewJobForm({ initialSource = "", onDone, onCancel, autoFocus }: { initialSource?: string; onDone?: () => void; onCancel?: () => void; autoFocus?: boolean }) {
  const uid = useId();
  const navigate = useNavigate();
  const create = useCreateJob();
  const [source, setSource] = useState(initialSource);
  const [idEdited, setIdEdited] = useState(false);
  const [jobId, setJobId] = useState("");
  const [language, setLanguage] = useState("en");
  const [speakers, setSpeakers] = useState("");
  const [allowLower, setAllowLower] = useState(false);
  const [touched, setTouched] = useState(false);

  const det = detectSource(source);
  useEffect(() => {
    if (!idEdited) setJobId(det.id);
  }, [det.id, idEdited]);

  const sourceErr: string | null = !touched ? null : (det.kind === "empty" ? "Paste a YouTube URL or a local file path." : det.kind === "invalid" ? det.detail : null);
  const idErr = jobId && !JOB_ID_RE.test(jobId) ? "Lowercase letters, digits, - and _ only; must start with a letter or digit (max 64)." : null;
  const spk = speakers.trim() === "" ? undefined : Number(speakers);
  const spkErr = spk !== undefined && (!Number.isInteger(spk) || spk < 1 || spk > 20) ? "Whole number from 1 to 20, or leave empty." : null;
  const serverErr = create.error;
  const exists = serverErr instanceof ApiError && serverErr.code === "exists";
  const Icon = KIND_ICON[det.kind];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (det.kind === "empty" || det.kind === "invalid" || idErr || spkErr) return;
    create.mutate(
      {
        source: source.trim().replace(/^"(.*)"$/, "$1"),
        ...(jobId ? { id: jobId } : {}),
        language,
        ...(spk !== undefined ? { speakers: spk } : {}),
        allow_lower: allowLower,
      },
      {
        onSuccess: (res) => {
          toast({ tone: "running", title: `${ACTION_LABEL[res.run.action]} started`, description: res.job.id, href: `/jobs/${res.job.id}`, hrefLabel: "Open job" });
          onDone?.();
          navigate(`/jobs/${res.job.id}`);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div>
        <label htmlFor={`${uid}-src`} className="mb-1.5 block text-sm font-medium text-fg">
          Source <span className="text-bad" aria-hidden>*</span>
        </label>
        <input
          id={`${uid}-src`}
          autoFocus={autoFocus}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onBlur={() => source && setTouched(true)}
          placeholder="https://www.youtube.com/watch?v=…  or  C:\videos\episode.mp4"
          aria-invalid={!!sourceErr}
          aria-describedby={`${uid}-src-help`}
          autoComplete="off"
          spellCheck={false}
          className={cn(inputCls, "font-mono")}
        />
        <p id={`${uid}-src-help`} className={cn("mt-1.5 flex items-center gap-1.5 text-xs", sourceErr ? "text-bad" : "text-muted")}>
          <Icon className="size-3.5 shrink-0" aria-hidden />
          {sourceErr ?? (det.kind === "empty" ? "YouTube, any yt-dlp URL, or a local video file on this machine." : det.detail)}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <label htmlFor={`${uid}-id`} className="mb-1.5 block text-sm font-medium text-fg">
            Job id
          </label>
          <input
            id={`${uid}-id`}
            value={jobId}
            onChange={(e) => {
              setIdEdited(true);
              setJobId(e.target.value.toLowerCase());
            }}
            placeholder="auto"
            aria-invalid={!!idErr}
            aria-describedby={`${uid}-id-help`}
            spellCheck={false}
            className={cn(inputCls, "font-mono")}
          />
          <p id={`${uid}-id-help`} className={cn("mt-1.5 text-xs", idErr ? "text-bad" : "text-muted")}>
            {idErr ?? (
              <>
                Folder <span className="font-mono">data/jobs/{jobId || "…"}</span>
                {idEdited ? (
                  <button type="button" className="ml-2 text-accent hover:underline" onClick={() => setIdEdited(false)}>
                    reset to default
                  </button>
                ) : null}
              </>
            )}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:w-64">
          <div>
            <label htmlFor={`${uid}-lang`} className="mb-1.5 block text-sm font-medium text-fg">
              Language
            </label>
            <select id={`${uid}-lang`} value={language} onChange={(e) => setLanguage(e.target.value)} className={cn(inputCls, "px-2")}>
              {LANGS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-spk`} className="mb-1.5 block text-sm font-medium text-fg">
              Speakers
            </label>
            <input
              id={`${uid}-spk`}
              type="number"
              inputMode="numeric"
              min={1}
              max={20}
              value={speakers}
              onChange={(e) => setSpeakers(e.target.value)}
              placeholder="auto"
              aria-invalid={!!spkErr}
              className={cn(inputCls, "font-mono tnum")}
            />
          </div>
        </div>
      </div>
      {spkErr ? <p className="-mt-2 text-xs text-bad">{spkErr}</p> : null}

      <div className="rounded border border-line bg-bg/60 p-3">
        <Switch
          id={`${uid}-lower`}
          checked={allowLower}
          onChange={setAllowLower}
          label="Allow lower quality"
          description="Ingest fails when YouTube serves a lower height than it lists (a silent SABR downgrade). Turn on to accept the lower master anyway — clips may look soft."
        />
      </div>

      {serverErr ? (
        <div role="alert" className="rounded border border-bad/30 bg-bad/[0.07] px-3 py-2 text-sm">
          <span className="text-bad">{describeError(serverErr).message}</span>
          <span className="ml-2 font-mono text-xs text-faint">{describeError(serverErr).code}</span>
          {exists ? (
            <Link to={`/jobs/${jobId}`} onClick={onDone} className="ml-2 font-medium text-accent hover:underline">
              Open existing job
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-xs text-muted">Starts the free <span className="font-mono">prepare</span> run: ingest → transcribe → diarize → sentences.</p>
        <div className="flex shrink-0 gap-2">
          {onCancel ? (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create job
          </Button>
        </div>
      </div>
    </form>
  );
}
