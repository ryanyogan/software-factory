/** Flags accepted by every command (spread into each command's `args`). Kept dependency-free. */
export const globalArgs = {
  json: { type: 'boolean', description: 'Machine-readable JSON output' },
  api: {
    type: 'string',
    description: 'API base URL (env SF_API_URL, default http://localhost:5173)',
  },
} as const;

export interface GlobalArgs {
  json?: boolean;
  api?: string;
}
