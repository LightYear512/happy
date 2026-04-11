import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as yaml from 'js-yaml';
import { randomBytes } from 'node:crypto';
import { logger } from '@/ui/logger';

export interface CcsProfileInfo {
    name: string;
    /** Claude instance directory (~/.ccs/instances/<profile>/) */
    instancePath: string;
    contextMode?: 'isolated' | 'shared';
    contextGroup?: string;
}

/** Agent flavor for auth operations. */
export type AuthFlavor = 'claude' | 'codex' | 'gemini';

export interface CcsProfilesResult {
    profiles: CcsProfileInfo[];
    defaultProfile: string | null;
}

/**
 * Get the CCS directory path, respecting environment overrides.
 * Mirrors CCS's own getCcsDir() logic.
 */
function getCcsDir(): string {
    if (process.env.CCS_DIR) return process.env.CCS_DIR;
    if (process.env.CCS_HOME) return join(process.env.CCS_HOME, '.ccs');
    return join(homedir(), '.ccs');
}

/**
 * Sanitize a profile name to a filesystem-safe format.
 * Mirrors CCS's InstanceManager.sanitizeName().
 */
function sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

/**
 * Get the instance path for a given profile name.
 */
export function getInstancePath(profileName: string): string {
    return join(getCcsDir(), 'instances', sanitizeName(profileName));
}

/**
 * Read all CCS profiles from the filesystem.
 * Reads from profiles.json (legacy) and config.yaml (unified) if available.
 */
export function readCcsProfiles(): CcsProfilesResult {
    const ccsDir = getCcsDir();
    const result: CcsProfilesResult = { profiles: [], defaultProfile: null };

    if (!existsSync(ccsDir)) {
        logger.debug('[ccsProfiles] CCS directory not found:', ccsDir);
        return result;
    }

    // Try legacy profiles.json first
    const profilesJsonPath = join(ccsDir, 'profiles.json');
    if (existsSync(profilesJsonPath)) {
        try {
            const raw = readFileSync(profilesJsonPath, 'utf-8');
            const data = JSON.parse(raw);

            if (data.default) {
                result.defaultProfile = data.default;
            }

            // Profiles are stored as keys in the JSON object (excluding 'default')
            for (const [name, meta] of Object.entries(data)) {
                if (name === 'default') continue;
                if (typeof meta !== 'object' || meta === null) continue;

                const profileMeta = meta as Record<string, unknown>;
                // Only include account-type profiles
                if (profileMeta.type && profileMeta.type !== 'account') continue;

                const instancePath = getInstancePath(name);
                result.profiles.push({
                    name,
                    instancePath,
                    contextMode: profileMeta.context_mode as 'isolated' | 'shared' | undefined,
                    contextGroup: profileMeta.context_group as string | undefined,
                });
            }
        } catch (error) {
            logger.debug('[ccsProfiles] Failed to read profiles.json:', error);
        }
    }

    // Try unified config.yaml (takes precedence for default)
    const configYamlPath = join(ccsDir, 'config.yaml');
    if (existsSync(configYamlPath)) {
        try {
            const config = yaml.load(readFileSync(configYamlPath, 'utf-8')) as Record<string, unknown> | null;
            if (config) {
                if (typeof config.default === 'string') {
                    result.defaultProfile = config.default;
                }

                const accounts = config.accounts as Record<string, Record<string, unknown> | null> | undefined;
                if (accounts && typeof accounts === 'object') {
                    const existingNames = new Set(result.profiles.map(p => p.name));
                    for (const [name, props] of Object.entries(accounts)) {
                        if (existingNames.has(name)) continue;
                        const profile: CcsProfileInfo = {
                            name,
                            instancePath: getInstancePath(name),
                        };
                        if (props) {
                            if (props.context_mode === 'shared' || props.context_mode === 'isolated') {
                                profile.contextMode = props.context_mode;
                            }
                            if (typeof props.context_group === 'string') {
                                profile.contextGroup = props.context_group;
                            }
                        }
                        result.profiles.push(profile);
                    }
                }
            }
        } catch (error) {
            logger.debug('[ccsProfiles] Failed to read config.yaml:', error);
        }
    }

    return result;
}

/**
 * Determine the currently active CCS profile by inspecting CLAUDE_CONFIG_DIR.
 */
export function getCurrentCcsProfile(): string | null {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    if (!configDir) return null;

    const ccsDir = getCcsDir();
    const instancesDir = join(ccsDir, 'instances');

    // Normalize paths for comparison
    const normalizedConfigDir = configDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedInstancesDir = instancesDir.replace(/\\/g, '/').replace(/\/+$/, '');

    if (!normalizedConfigDir.startsWith(normalizedInstancesDir)) return null;

    // Extract profile name from path: ~/.ccs/instances/<profile-name>/
    const relativePath = normalizedConfigDir.slice(normalizedInstancesDir.length + 1);
    const profileDirName = relativePath.split('/')[0];
    if (!profileDirName) return null;

    // Find the profile whose sanitized name matches the directory
    const profiles = readCcsProfiles();
    for (const profile of profiles.profiles) {
        if (sanitizeName(profile.name) === profileDirName) {
            return profile.name;
        }
    }

    // Return the directory name as fallback
    return profileDirName;
}

// ---------------------------------------------------------------------------
// Codex instance management (happy-managed, independent of CCS)
// ---------------------------------------------------------------------------

/**
 * Resolve the happy home directory, respecting HAPPY_HOME_DIR override.
 * Mirrors configuration.ts logic without importing it (side-effects).
 */
export function getHappyHome(): string {
    const raw = process.env.HAPPY_HOME_DIR;
    return raw ? raw.replace(/^~/, homedir()) : join(homedir(), '.happy');
}

/** Base directory for all happy-managed codex instances. */
function getCodexInstancesBase(): string {
    return join(getHappyHome(), 'codex-instances');
}

/**
 * Get the CODEX_HOME-equivalent directory for a given profile name.
 * Layout: <happyHomeDir>/codex-instances/<sanitized-name>/
 */
export function getCodexInstancePath(profileName: string): string {
    return join(getCodexInstancesBase(), sanitizeName(profileName));
}

/**
 * Determine the currently active codex profile by inspecting CODEX_HOME.
 * Returns null when CODEX_HOME is not set or doesn't point to a happy-managed instance.
 */
export function getCurrentCodexProfile(): string | null {
    const codexHome = process.env.CODEX_HOME;
    if (!codexHome) return null;

    const base = getCodexInstancesBase();
    const normalizedHome = codexHome.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedBase = base.replace(/\\/g, '/').replace(/\/+$/, '');

    if (!normalizedHome.startsWith(normalizedBase)) return null;

    const relativePath = normalizedHome.slice(normalizedBase.length + 1);
    const profileDirName = relativePath.split('/')[0];
    if (!profileDirName) return null;

    // Reverse-lookup: find CCS profile whose sanitized name matches
    const { profiles } = readCcsProfiles();
    for (const profile of profiles) {
        if (sanitizeName(profile.name) === profileDirName) {
            return profile.name;
        }
    }

    return profileDirName;
}

/**
 * Get the current profile name for a given agent flavor.
 */
export function getCurrentProfileForFlavor(flavor: AuthFlavor): string | null {
    switch (flavor) {
        case 'codex': return getCurrentCodexProfile();
        case 'claude':
        default: return getCurrentCcsProfile();
    }
}

/**
 * Perform the env-level switch for a given agent flavor.
 * - claude: sets CLAUDE_CONFIG_DIR to the CCS instance path
 * - codex: sets CODEX_HOME to the happy-managed codex instance path (derived from profileName)
 */
export function applyProfileSwitch(profileName: string, flavor: AuthFlavor, claudeInstancePath?: string): void {
    switch (flavor) {
        case 'codex': {
            const codexPath = getCodexInstancePath(profileName);
            process.env.CODEX_HOME = codexPath;
            logger.debug(`[!auth] Switched CODEX_HOME to: ${codexPath}`);
            break;
        }
        case 'claude':
        default:
            if (!claudeInstancePath) {
                logger.warn(`[!auth] applyProfileSwitch called for ${flavor} without instancePath — skipping`);
                return;
            }
            process.env.CLAUDE_CONFIG_DIR = claudeInstancePath;
            logger.debug(`[!auth] Switched CLAUDE_CONFIG_DIR to: ${claudeInstancePath}`);
            break;
    }
}


// ---------------------------------------------------------------------------
// Codex-independent profile management
// ---------------------------------------------------------------------------

export interface CodexProfileInfo {
    /** Profile name (directory name under codex-instances/). */
    name: string;
    /** Full path to the codex instance directory. */
    codexHome: string;
}

/**
 * Scan ~/.happy-dev/codex-instances/ and return every sub-directory that
 * contains an auth.json file, representing a logged-in Codex account.
 */
export function readCodexProfiles(): CodexProfileInfo[] {
    const base = getCodexInstancesBase();
    const results: CodexProfileInfo[] = [];
    let entries: string[];
    try {
        entries = readdirSync(base);
    } catch {
        return [];
    }

    for (const entry of entries) {
        const dirPath = join(base, entry);
        try {
            if (!statSync(dirPath).isDirectory()) continue;
        } catch {
            continue;
        }
        if (existsSync(join(dirPath, 'auth.json'))) {
            results.push({ name: entry, codexHome: dirPath });
        }
    }
    return results;
}

/** Shape of ~/.happy-dev/codex-instances/config.yaml */
interface CodexInstancesConfig {
    accounts?: Record<string, {
        created?: string;
        context_mode?: 'isolated' | 'shared';
        context_group?: string;
        [key: string]: unknown;
    }>;
}

/**
 * Register (or update) a Codex account's metadata in the independent
 * config file at ~/.happy-dev/codex-instances/config.yaml.
 *
 * - Incremental merge: preserves existing `created` and extra fields.
 * - Atomic write: writes to a temp file then renames.
 */
export function registerCodexProfile(
    profileName: string,
    contextMode: 'isolated' | 'shared',
    contextGroup?: string,
): void {
    const base = getCodexInstancesBase();
    mkdirSync(base, { recursive: true });

    const configPath = join(base, 'config.yaml');

    let config: CodexInstancesConfig;
    try {
        config = (yaml.load(readFileSync(configPath, 'utf-8')) as CodexInstancesConfig) ?? {};
    } catch {
        config = {};
    }

    if (!config.accounts) config.accounts = {};

    const existing = config.accounts[profileName];
    config.accounts[profileName] = {
        ...existing,
        created: existing?.created ?? new Date().toISOString(),
        context_mode: contextMode,
        ...(contextGroup ? { context_group: contextGroup } : {}),
    };

    const content = yaml.dump(config, { indent: 2, lineWidth: -1, quotingType: '"' });
    const tmpPath = configPath + '.' + randomBytes(4).toString('hex') + '.tmp';
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, configPath);
    logger.debug(`[codex] Registered codex profile "${profileName}" in ${configPath}`);
}
