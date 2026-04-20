import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as yaml from 'js-yaml';
import { logger } from '@/ui/logger';

export type AuthFlavor = 'claude' | 'codex';

export interface CcsProfileInfo {
    name: string;
    instancePath: string;
    contextMode?: 'isolated' | 'shared';
    contextGroup?: string;
}

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
            const raw = readFileSync(configYamlPath, 'utf-8');
            const yamlDefault = parseYamlDefault(raw);
            if (yamlDefault) {
                result.defaultProfile = yamlDefault;
            }

            const yamlAccounts = parseYamlAccounts(raw);
            // Merge: add any accounts from YAML that aren't already in profiles
            const existingNames = new Set(result.profiles.map(p => p.name));
            for (const account of yamlAccounts) {
                if (!existingNames.has(account.name)) {
                    result.profiles.push(account);
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

/**
 * Simple YAML parser to extract the `default:` field value.
 */
function parseYamlDefault(yamlStr: string): string | null {
    const match = yamlStr.match(/^default:\s*["']?([^"'\n\r]+?)["']?\s*$/m);
    return match ? match[1].trim() : null;
}

/**
 * Simple YAML parser to extract account entries from `accounts:` section.
 */
function parseYamlAccounts(yamlStr: string): CcsProfileInfo[] {
    const accounts: CcsProfileInfo[] = [];
    const lines = yamlStr.split('\n');
    let inAccounts = false;

    for (const line of lines) {
        if (/^accounts:\s*$/.test(line)) {
            inAccounts = true;
            continue;
        }
        if (inAccounts && /^\S/.test(line) && !line.startsWith('#')) {
            inAccounts = false;
            continue;
        }
        if (inAccounts) {
            const accountMatch = line.match(/^\s{2}(\S+):\s*$/);
            if (accountMatch) {
                const name = accountMatch[1];
                accounts.push({ name, instancePath: getInstancePath(name) });
            }
        }
    }

    return accounts;
}

/**
 * Persist the default CCS profile name.
 * Writes to config.yaml (unified, takes precedence) and legacy profiles.json if present.
 */
export function setCcsDefaultProfile(profileName: string): void {
    const ccsDir = getCcsDir();
    let wrote = false;

    const configYamlPath = join(ccsDir, 'config.yaml');
    try {
        const raw = readFileSync(configYamlPath, 'utf-8');
        const config = (yaml.load(raw) as Record<string, unknown>) ?? {};
        config.default = profileName;
        const content = yaml.dump(config, { indent: 2, lineWidth: -1, quotingType: '"' });
        const tmpPath = configYamlPath + '.' + randomBytes(4).toString('hex') + '.tmp';
        writeFileSync(tmpPath, content, 'utf-8');
        renameSync(tmpPath, configYamlPath);
        logger.debug(`[ccs] Set default CCS profile to "${profileName}" (config.yaml)`);
        wrote = true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }

    const profilesJsonPath = join(ccsDir, 'profiles.json');
    try {
        const raw = readFileSync(profilesJsonPath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        data.default = profileName;
        const content = JSON.stringify(data, null, 2);
        const tmpPath = profilesJsonPath + '.' + randomBytes(4).toString('hex') + '.tmp';
        writeFileSync(tmpPath, content, 'utf-8');
        renameSync(tmpPath, profilesJsonPath);
        logger.debug(`[ccs] Set default CCS profile to "${profileName}" (profiles.json)`);
        wrote = true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            logger.debug('[ccs] Failed to update profiles.json default:', error);
        }
    }

    if (!wrote) {
        throw new Error(`No CCS config file found in ${ccsDir} (expected config.yaml or profiles.json)`);
    }
}

// ---------------------------------------------------------------------------
// Codex instance management (happy-managed, independent of CCS)
// ---------------------------------------------------------------------------

/**
 * Resolve the happy home directory, respecting HAPPY_HOME_DIR override.
 */
export function getHappyHome(): string {
    const raw = process.env.HAPPY_HOME_DIR;
    return raw ? raw.replace(/^~/, homedir()) : join(homedir(), '.happy');
}

/** Base directory for all happy-managed codex instances. */
function getCodexInstancesBase(): string {
    return join(getHappyHome(), 'auth', 'codex', 'instances');
}

/**
 * Get the CODEX_HOME-equivalent directory for a given profile name.
 * Layout: <happyHomeDir>/auth/codex/instances/<sanitized-name>/
 */
export function getCodexInstancePath(profileName: string): string {
    return join(getCodexInstancesBase(), sanitizeName(profileName));
}

/**
 * Determine the currently active codex profile by inspecting CODEX_HOME.
 */
export function getCurrentCodexProfile(): string | null {
    const codexHome = process.env.CODEX_HOME;
    if (!codexHome) return null;

    const base = getCodexInstancesBase();
    const normalizedHome = codexHome.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedBase = base.replace(/\\/g, '/').replace(/\/+$/, '');

    if (!normalizedHome.startsWith(normalizedBase + '/')) return null;

    const profileDirName = normalizedHome.slice(normalizedBase.length + 1).split('/')[0];
    if (!profileDirName) return null;

    // Try to map dir name back to a registered profile
    const profiles = readCodexProfiles();
    for (const profile of profiles) {
        if (sanitizeName(profile.name) === profileDirName) return profile.name;
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
                logger.warn(`[!auth] applyProfileSwitch(claude) called without claudeInstancePath`);
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
    /** Profile name (directory name under auth/codex/instances/). */
    name: string;
    /** Full path to the codex instance directory. */
    codexHome: string;
}

/**
 * Scan ~/.happy/auth/codex/instances/ and return every sub-directory that
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

/** Shape of ~/.happy/auth/codex/instances/config.yaml */
interface CodexInstancesConfig {
    default?: string;
    accounts?: Record<string, { created?: string; [key: string]: unknown }>;
}

/**
 * Atomic read-modify-write for ~/.happy/auth/codex/instances/config.yaml.
 */
function updateCodexConfig(mutate: (config: CodexInstancesConfig) => void): void {
    const base = getCodexInstancesBase();
    mkdirSync(base, { recursive: true });

    const configPath = join(base, 'config.yaml');
    let config: CodexInstancesConfig;
    try {
        config = (yaml.load(readFileSync(configPath, 'utf-8')) as CodexInstancesConfig) ?? {};
    } catch {
        config = {};
    }

    mutate(config);

    const content = yaml.dump(config, { indent: 2, lineWidth: -1, quotingType: '"' });
    const tmpPath = configPath + '.' + randomBytes(4).toString('hex') + '.tmp';
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, configPath);
}

/**
 * Register (or update) a Codex account's metadata in the independent
 * config file at ~/.happy/auth/codex/instances/config.yaml.
 */
export function registerCodexProfile(profileName: string): void {
    updateCodexConfig(config => {
        if (!config.accounts) config.accounts = {};
        const existing = config.accounts[profileName];
        config.accounts[profileName] = {
            created: existing?.created ?? new Date().toISOString(),
        };
    });
    logger.debug(`[codex] Registered codex profile "${profileName}"`);
}

/**
 * Read the default Codex profile name from config.yaml.
 */
export function readCodexDefaultProfile(): string | null {
    const configPath = join(getCodexInstancesBase(), 'config.yaml');
    try {
        const config = yaml.load(readFileSync(configPath, 'utf-8')) as CodexInstancesConfig | null;
        return config?.default ?? null;
    } catch {
        return null;
    }
}

/**
 * Persist the default Codex profile name in config.yaml.
 */
export function setCodexDefaultProfile(profileName: string): void {
    updateCodexConfig(config => { config.default = profileName; });
    logger.debug(`[codex] Set default codex profile to "${profileName}"`);
}
