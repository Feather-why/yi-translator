export function prepareBuildInfo(root: string): Promise<{ version: string; buildId: string; sourceDigest: string; builtAt: string }>;
