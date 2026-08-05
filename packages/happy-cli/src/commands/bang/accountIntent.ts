import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getHappyHome, type AuthFlavor } from './ccsProfiles';

const INTENT_SCHEMA = 'happy.account-intent/1';
const SELECTION_SCHEMA = 'happy.session-account-selection/1';

export type AccountIntentFlavor = Exclude<AuthFlavor, 'gemini'>;

export type AccountIntent = Readonly<{
    profileName: string;
    setAt: number;
}>;

type AccountIntentDocument = {
    schema: typeof INTENT_SCHEMA;
    claude?: AccountIntent;
    codex?: AccountIntent;
};

type SessionAccountSelectionDocument = {
    schema: typeof SELECTION_SCHEMA;
    claude?: SessionAccountSelection;
    codex?: SessionAccountSelection;
};

export type SessionAccountSelection = Readonly<{
    profileName: string;
    seenGlobalSetAt: number;
}>;

export type StartupAccountSelection = SessionAccountSelection & Readonly<{
    source: 'session' | 'global';
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(value).every((key) => allowed.includes(key));
}

function parseIntent(value: unknown): AccountIntent {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['profileName', 'setAt'])
        || typeof value.profileName !== 'string'
        || value.profileName.trim() !== value.profileName
        || value.profileName.length === 0
        || !Number.isSafeInteger(value.setAt)
        || Number(value.setAt) <= 0) {
        throw new Error('Account intent entry is invalid');
    }
    return { profileName: value.profileName, setAt: Number(value.setAt) };
}

function readIntentDocument(home: string): AccountIntentDocument {
    const path = join(home, 'account-intent.json');
    if (!existsSync(path)) return { schema: INTENT_SCHEMA };
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['schema', 'claude', 'codex'])
        || value.schema !== INTENT_SCHEMA) {
        throw new Error('Account intent file is invalid');
    }
    return {
        schema: INTENT_SCHEMA,
        ...(value.claude === undefined ? {} : { claude: parseIntent(value.claude) }),
        ...(value.codex === undefined ? {} : { codex: parseIntent(value.codex) }),
    };
}

function parseSelection(value: unknown): SessionAccountSelection {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['profileName', 'seenGlobalSetAt'])
        || typeof value.profileName !== 'string'
        || value.profileName.trim() !== value.profileName
        || value.profileName.length === 0
        || !Number.isSafeInteger(value.seenGlobalSetAt)
        || Number(value.seenGlobalSetAt) < 0) {
        throw new Error('Session account selection is invalid');
    }
    return {
        profileName: value.profileName,
        seenGlobalSetAt: Number(value.seenGlobalSetAt),
    };
}

function sessionSelectionPath(home: string, sessionId: string): string {
    if (!sessionId) throw new Error('Happy session ID is required');
    const key = createHash('sha256').update(sessionId).digest('hex');
    return join(home, 'session-account-selection', `${key}.json`);
}

function readSelectionDocument(home: string, sessionId: string): SessionAccountSelectionDocument {
    const path = sessionSelectionPath(home, sessionId);
    if (!existsSync(path)) return { schema: SELECTION_SCHEMA };
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['schema', 'claude', 'codex'])
        || value.schema !== SELECTION_SCHEMA) {
        throw new Error('Session account selection is invalid');
    }
    return {
        schema: SELECTION_SCHEMA,
        ...(value.claude === undefined ? {} : { claude: parseSelection(value.claude) }),
        ...(value.codex === undefined ? {} : { codex: parseSelection(value.codex) }),
    };
}

function writeJsonAtomically(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
        writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
        renameSync(temporary, path);
    } catch (error) {
        try { unlinkSync(temporary); } catch { /* best effort */ }
        throw error;
    }
}

export function readAccountIntent(
    flavor: AccountIntentFlavor,
    home = getHappyHome(),
): AccountIntent | null {
    return readIntentDocument(home)[flavor] ?? null;
}

export function publishAccountIntent(
    flavor: AccountIntentFlavor,
    profileName: string,
    now = Date.now(),
    home = getHappyHome(),
): AccountIntent {
    if (!profileName || profileName.trim() !== profileName) {
        throw new Error('Account profile name is invalid');
    }
    if (!Number.isSafeInteger(now) || now <= 0) {
        throw new Error('Account intent timestamp is invalid');
    }
    const current = readIntentDocument(home);
    const previous = current[flavor]?.setAt ?? 0;
    if (previous === Number.MAX_SAFE_INTEGER) {
        throw new Error('Account intent timestamp is exhausted');
    }
    const setAt = Math.max(now, previous + 1);
    const intent = { profileName, setAt } as const;
    writeJsonAtomically(join(home, 'account-intent.json'), {
        ...current,
        [flavor]: intent,
    });
    return intent;
}

export function readSessionAccountSelection(
    sessionId: string,
    flavor: AccountIntentFlavor,
    home = getHappyHome(),
): SessionAccountSelection | null {
    return readSelectionDocument(home, sessionId)[flavor] ?? null;
}

export function writeSessionAccountSelection(
    sessionId: string,
    flavor: AccountIntentFlavor,
    profileName: string,
    seenGlobalSetAt: number,
    home = getHappyHome(),
): void {
    const validated = parseSelection({ profileName, seenGlobalSetAt });
    const path = sessionSelectionPath(home, sessionId);
    const current = readSelectionDocument(home, sessionId);
    if ((current[flavor]?.seenGlobalSetAt ?? 0) > validated.seenGlobalSetAt) {
        throw new Error('Session account selection cannot move backwards');
    }
    writeJsonAtomically(path, {
        ...current,
        [flavor]: validated,
    });
}

export function accountIntentIsNewer(intent: AccountIntent | null, seenSetAt: number): intent is AccountIntent {
    return intent !== null && intent.setAt > seenSetAt;
}

export function resolveStartupAccountSelection(
    session: SessionAccountSelection | null,
    global: AccountIntent | null,
): StartupAccountSelection | null {
    if (accountIntentIsNewer(global, session?.seenGlobalSetAt ?? 0)) {
        return {
            profileName: global.profileName,
            seenGlobalSetAt: global.setAt,
            source: 'global',
        };
    }
    return session ? { ...session, source: 'session' } : null;
}
