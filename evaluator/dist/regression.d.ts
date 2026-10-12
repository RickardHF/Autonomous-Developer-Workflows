type ArtifactKind = "agent" | "skill";
type Definition = {
    path: string;
    kind: ArtifactKind;
};
type Artifact = Definition & {
    mainPath: string | null;
};
type Change = {
    status: string;
    path: string;
    previousPath?: string;
};
type Manifest = {
    mainSha: string;
    headSha: string;
    artifacts: Artifact[];
    deleted: Definition[];
};
type Result = {
    fileName: string;
    score: number;
    reasoning: string;
};
type Comparison = Artifact & {
    mainScore: number;
    score: number;
    delta: number;
    regression: boolean;
    mainReasoning: string;
    reasoning: string;
};
type EvaluationProcess = {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
    signal?: NodeJS.Signals | null;
};
type Evaluator = (targets: string[], directory: string) => EvaluationProcess;
export declare function parseChanges(output: string): Change[];
export declare function selectArtifacts(mainFiles: string[], headFiles: string[], baseFiles: string[], changes: Change[]): {
    artifacts: Artifact[];
    deleted: Definition[];
};
export declare function discover(repository: string, mainRef: string, headRef: string): Manifest;
export declare function parseResults(output: string, expected: string[], snapshotDirectory: string, cliDirectory: string): Map<string, Result>;
export declare function compareScores(mainScore: number, score: number): {
    delta: number;
    regression: boolean;
};
export declare function compareResults(artifacts: Artifact[], main: Map<string, Result>, candidate: Map<string, Result>): Comparison[];
export declare function escapeMarkdown(value: string): string;
export declare function escapeAnnotation(value: string): string;
export declare function writeManifest(manifest: Manifest, outputDirectory: string): void;
export declare function evaluateRegression(manifest: Manifest, mainDirectory: string, candidateDirectory: string, outputDirectory: string, evaluator?: Evaluator): Comparison[];
export {};
//# sourceMappingURL=regression.d.ts.map