// Shared safety bounds for text sent to the CLI adapters. The tool allowance is an upper bound,
// not a fixed truncation of results saved in the notebook.
export const maxPromptChars = 600_000;
export const maxToolContextChars = 160_000;
export const promptReserveChars = 40_000;
