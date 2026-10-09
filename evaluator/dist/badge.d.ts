import type { EvaluationResult } from "./evaluate.js";
export type BadgeEntry = EvaluationResult & {
    fileName: string;
};
export declare function generateBadgeSvg(entries: BadgeEntry[], runDate?: string): string;
//# sourceMappingURL=badge.d.ts.map