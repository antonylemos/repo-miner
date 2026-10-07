export type ProgressEvent = {
  phase: 'search' | 'metadata' | 'activity';
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
