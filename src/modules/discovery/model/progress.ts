export type ProgressEvent = {
  phase: 'search' | 'refresh' | 'metadata' | 'activity';
  done: number;
  total: number;
  label: string;
};
/** Reports the export step about to run: `done` of `total` steps finished so far. */
export type ExportProgress = (
  done: number,
  total: number,
  label: string,
) => void;
