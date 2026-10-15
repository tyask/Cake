type PublicProof = { leaseId: string; slot: string; prNumber: number; sourceSha: string; deploymentId: string;
  database: { projectId: string; branchId: string; endpointId: string }; databaseHostDigest: string; productionHostDigest: string;
  urlKind: "unique" | "fixed"; url: string; leaseVersion: number; checkedAt: string; aliasId?: string };
type Options = { profile: { appId: string; instanceId: string; repository: { fullName: string }; vercelProjectId: string;
  vercelTeamId: string; neonProjectId: string }; cwd: string; source: { cwd: string; branch: string; sourceSha: string; prNumber: number };
  environment?: Readonly<Record<string, string | undefined>> };
type Dependencies = {
  browser?: () => Promise<{ options: typeof import("./qa-verify").browserOptions;
    smoke: typeof import("./qa-verify").browserSmoke; launch: (options: import("playwright").LaunchOptions) => Promise<import("playwright").Browser> }>;
  launcher?: (environment: Readonly<Record<string, string | undefined>>, cwd: string) => Promise<{ entry: string; guardPath: string }>;
  execute?: (command: string, args: readonly string[], options: { cwd: string; environment: Readonly<Record<string, string>> }) => Promise<{ status: number | null }>;
};
export function createCakeBrowserVerifier(dependencies?: Dependencies): (proof: PublicProof, options: Options) => Promise<{ cases: readonly string[] }>;
export function verifyCakeBrowser(proof: PublicProof, options: Options): Promise<{ cases: readonly string[] }>;
