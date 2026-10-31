export function generateFixture(options: {
  dest: string;
  size?: string;
  seed?: string;
  plan?: {
    files: number;
    fileBytes: number;
    commits: number;
    modifications: number;
    textBytes: number;
    binaryBytes: number;
  };
}): Promise<{
  verified: boolean;
  files: number;
  commits: number;
  modifications: number;
  sampleBytes: number;
  repo: string;
}>;
