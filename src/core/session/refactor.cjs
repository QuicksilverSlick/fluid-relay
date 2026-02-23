const fs = require('fs');
const path = require('path');

const stateReducerPath = path.join(__dirname, 'session-state-reducer.ts');
const reducerPath = path.join(__dirname, 'session-reducer.ts');

const stateReducerLines = fs.readFileSync(stateReducerPath, 'utf8').split('\n');

// The block starts at line 43 (index 42) and ends at line 347 (index 346 - inclusive)
// Let's verify start/end via regex to be safe
const startIdx = stateReducerLines.findIndex(l => l.includes('// Public API'));
const endIdx = stateReducerLines.findIndex(l => l.includes('export function reduce('));

if (startIdx === -1 || endIdx === -1) {
    console.error('Could not find boundaries');
    process.exit(1);
}

// Extract the block (leaving a few blank lines above export function reduce)
const extractedLines = stateReducerLines.slice(startIdx, endIdx - 2);
const newStateReducerLines = [
    ...stateReducerLines.slice(0, startIdx),
    ...stateReducerLines.slice(endIdx - 2)
];

// In the extracted block, rename `reduceSessionData` to `reduceBackendMessage`
const renamedExtractedLines = extractedLines.map(line => {
    if (line.includes('export function reduceSessionData(')) {
        return 'function reduceBackendMessage(';
    }
    return line;
});

// Update session-reducer.ts
let reducerLines = fs.readFileSync(reducerPath, 'utf8').split('\n');

// 1. In session-reducer.ts, replace `import { reduceSessionData }` with `import { reduce }`
reducerLines = reducerLines.map(line => {
    if (line.includes('import { reduceSessionData }')) {
        return 'import { reduce } from "./session-state-reducer.js";';
    }
    return line;
});

// 2. Add extra imports needed by the extracted block
const extraImports = `
import type { PermissionRequest } from "../../types/cli-messages.js";
import type { ConsumerMessage } from "../../types/consumer-messages.js";
import { CONSUMER_PROTOCOL_VERSION } from "../../types/consumer-messages.js";
import type { SessionState } from "../../types/session-state.js";
import {
  mapAssistantMessage,
  mapAuthStatus,
  mapConfigurationChange,
  mapPermissionRequest,
  mapResultMessage,
  mapSessionLifecycle,
  mapStreamEvent,
  mapToolProgress,
  mapToolUseSummary,
} from "../messaging/consumer-message-mapper.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import { upsertAssistantMessage, upsertToolUseSummary } from "./history-reducer.js";
`;
const firstImportIdx = reducerLines.findIndex(l => l.startsWith('import'));
reducerLines.splice(firstImportIdx, 0, extraImports.trim(), '');

// 3. Rename call of `reduceSessionData(...)` to `reduceBackendMessage(...)`
reducerLines = reducerLines.map(line => {
    if (line.includes('return reduceSessionData(data, event.message, correlationBuffer);')) {
        return line.replace('reduceSessionData', 'reduceBackendMessage');
    }
    return line;
});

// 4. Append extracted lines to the bottom
const finalReducerLines = [...reducerLines, '', ...renamedExtractedLines];

fs.writeFileSync(stateReducerPath, newStateReducerLines.join('\n'));
fs.writeFileSync(reducerPath, finalReducerLines.join('\n'));
console.log('Successfully refactored both files.');
