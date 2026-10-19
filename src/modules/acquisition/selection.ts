import { type Annotation, valueAt } from './annotations.js';

/** A `cloned` row of clones.csv: the commit is the one the researcher classified. */
export type ClonedRepository = {
  rank: number;
  id: string;
  fullName: string;
  commit: string;
  /** Branch the clone was made from. */
  branch: string;
};

export type SelectedRepository = {
  annotation: Annotation;
  clone: ClonedRepository;
};

export type SelectionRules = {
  include: { classification: string[]; status: string[] };
  required: string[];
};

export type Selection = {
  /** In rank order. */
  selected: SelectedRepository[];
  /** Annotations that match the sample but are left out by classification or state. */
  unselected: number;
  /** Everything wrong with the inputs; the run is refused when it is not empty. */
  problems: string[];
};

function missing(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Crosses the annotations with the clones and the catalog, collecting every
 * inconsistency, and selects the annotations the configuration includes.
 * `catalog` maps a repository id to its (possibly empty) classification.
 */
export function selectRepositories(
  annotations: Annotation[],
  clones: ClonedRepository[],
  catalog: Map<string, string>,
  rules: SelectionRules,
): Selection {
  const problems: string[] = [];
  const cloneById = new Map(clones.map((clone) => [clone.id, clone]));
  const annotated = new Map<string, Annotation>();
  const selected: SelectedRepository[] = [];
  let unselected = 0;

  for (const annotation of annotations) {
    const { file, id } = annotation;
    const earlier = annotated.get(id);
    if (earlier !== undefined) {
      problems.push(`${file}: id ${id} is already used by ${earlier.file}`);
      continue;
    }
    annotated.set(id, annotation);
    const clone = cloneById.get(id);
    if (clone === undefined) {
      problems.push(
        `${file}: id ${id} is not a cloned repository of the sample (clones.csv)`,
      );
      continue;
    }
    let consistent = true;
    if (annotation.fullName !== clone.fullName) {
      problems.push(
        `${file}: full_name ${annotation.fullName} differs from clones.csv (${clone.fullName})`,
      );
      consistent = false;
    }
    if (annotation.commit !== clone.commit) {
      problems.push(
        `${file}: commit ${annotation.commit} differs from clones.csv (${clone.commit})`,
      );
      consistent = false;
    }
    const catalogued = catalog.get(id) ?? '';
    if (catalogued === '') {
      problems.push(
        `${file}: catalog.csv has no classification for id ${id}, but the annotation says ${annotation.classification}`,
      );
      consistent = false;
    } else if (catalogued !== annotation.classification) {
      problems.push(
        `${file}: classification ${annotation.classification} differs from catalog.csv (${catalogued})`,
      );
      consistent = false;
    }
    if (!consistent) continue;

    const included =
      rules.include.classification.includes(annotation.classification) &&
      rules.include.status.includes(annotation.status);
    if (!included) {
      unselected += 1;
      continue;
    }
    const empty = rules.required.filter((field) =>
      missing(valueAt(annotation.data, field)),
    );
    for (const field of empty)
      problems.push(`${file}: required field ${field} is missing or empty`);
    if (empty.length === 0) selected.push({ annotation, clone });
  }

  for (const [id, classification] of catalog)
    if (
      rules.include.classification.includes(classification) &&
      !annotated.has(id)
    )
      problems.push(
        `catalog.csv: id ${id} is classified ${classification} but has no annotation`,
      );

  selected.sort((a, b) => a.clone.rank - b.clone.rank);
  return { selected, unselected, problems };
}
