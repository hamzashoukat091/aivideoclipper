import { useEffect, useState } from "react";

/** requestVideoFrameCallback is in the DOM typings but not in every browser (e.g. older Firefox). */
export function hasRVFC(v: HTMLVideoElement): boolean {
  return typeof (v as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === "function";
}

/**
 * Calls `cb(mediaTime)` for every presented frame (requestVideoFrameCallback where available, which gives the
 * exact media time of the frame on screen) and after seeks / metadata loads. Fallback: rAF while playing.
 */
export function onEachFrame(v: HTMLVideoElement, cb: (mediaTime: number) => void): () => void {
  let stopped = false;
  let handle = 0;
  let raf = 0;
  const emitCurrent = () => cb(v.currentTime);

  const rvfc = hasRVFC(v);
  if (rvfc) {
    const loop: VideoFrameRequestCallback = (_now, meta) => {
      if (stopped) return;
      cb(meta.mediaTime);
      handle = v.requestVideoFrameCallback(loop);
    };
    handle = v.requestVideoFrameCallback(loop);
  } else {
    const tick = () => {
      if (stopped) return;
      if (!v.paused) cb(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  // timeupdate only without rVFC: its currentTime runs ahead of the presented frame and would jitter the overlay.
  const events: ("seeked" | "loadedmetadata" | "timeupdate" | "pause")[] = rvfc ? ["seeked", "loadedmetadata", "pause"] : ["seeked", "loadedmetadata", "timeupdate", "pause"];
  events.forEach((e) => v.addEventListener(e, emitCurrent));
  return () => {
    stopped = true;
    if (rvfc && handle) v.cancelVideoFrameCallback(handle);
    cancelAnimationFrame(raf);
    events.forEach((e) => v.removeEventListener(e, emitCurrent));
  };
}

/** Current time + paused state of a <video>, updated per presented frame. */
export function useMediaTime(v: HTMLVideoElement | null): { time: number; paused: boolean; duration: number } {
  const [state, setState] = useState({ time: 0, paused: true, duration: 0 });
  useEffect(() => {
    if (!v) return;
    const upd = (t: number) =>
      setState((s) => (s.time === t && s.paused === v.paused && s.duration === (v.duration || 0) ? s : { time: t, paused: v.paused, duration: Number.isFinite(v.duration) ? v.duration : 0 }));
    const stop = onEachFrame(v, upd);
    const onPlayState = () => upd(v.currentTime);
    v.addEventListener("play", onPlayState);
    v.addEventListener("durationchange", onPlayState);
    upd(v.currentTime);
    return () => {
      stop();
      v.removeEventListener("play", onPlayState);
      v.removeEventListener("durationchange", onPlayState);
    };
  }, [v]);
  return state;
}

export function mediaErrorText(v: HTMLVideoElement | null): string {
  const code = v?.error?.code;
  switch (code) {
    case 1:
      return "Loading was aborted.";
    case 2:
      return "Network error while loading the media (is the server running?).";
    case 3:
      return "The browser could not decode this media.";
    case 4:
      return "This format or codec is not supported by the browser, or the file is missing.";
    default:
      return "The media could not be loaded.";
  }
}
