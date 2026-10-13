/** Type surface for validate-storyboard.mjs (consumed by test/validate.test.ts). */
export declare const STEP_TYPES: Record<string, string[]>;
export declare const VO_STATUS: Set<string>;
export declare const FIT_VERDICTS: Set<string>;
export declare const RUNNER_MANAGED: string[];

export declare class Report {
  errors: string[];
  warnings: string[];
  err(scope: string, msg: string): void;
  warn(scope: string, msg: string): void;
  get ok(): boolean;
}

/** Validate a parsed storyboard document. Returns the set of scene ids. */
export declare function validateStoryboard(sb: object, report: Report): Set<string>;

/** Validate a parsed vo.yaml document against the storyboard scene ids. */
export declare function validateVo(vo: object, report: Report, sbIds: Set<string>): void;
