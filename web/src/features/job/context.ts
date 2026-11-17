import { useOutletContext } from "react-router-dom";
import type { JobDetail } from "@/api/types";

export interface JobContext {
  job: JobDetail;
}

export function useJobContext(): JobContext {
  return useOutletContext<JobContext>();
}
