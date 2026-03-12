import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

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
 * Avoids needing js-yaml dependency.
 */
function parseYamlDefault(yaml: string): string | null {
    const match = yaml.match(/^default:\s*["']?([^"'\n\r]+?)["']?\s*$/m);
    return match ? match[1].trim() : null;
}

/**
 * Simple YAML parser to extract account entries from `accounts:` section.
 * Only extracts name and instance path — not a full YAML parser.
 */
function parseYamlAccounts(yaml: string): CcsProfileInfo[] {
    const accounts: CcsProfileInfo[] = [];
    const lines = yaml.split('\n');
    let inAccounts = false;
    let current: CcsProfileInfo | null = null;

    for (const line of lines) {
        // Detect accounts: section
        if (/^accounts:\s*$/.test(line)) {
            inAccounts = true;
            continue;
        }

        // Exit accounts section when a new top-level key appears
        if (inAccounts && /^\S/.test(line) && !line.startsWith('#')) {
            if (current) accounts.push(current);
            inAccounts = false;
            continue;
        }

        if (inAccounts) {
            // Match account entries like "  my-account:" or "  work:"
            const accountMatch = line.match(/^\s{2}(\S+):\s*$/);
            if (accountMatch) {
                if (current) accounts.push(current);
                current = {
                    name: accountMatch[1],
                    instancePath: getInstancePath(accountMatch[1]),
                };
                continue;
            }

            // Match nested properties (4-space indent) for the current account
            if (current) {
                const propMatch = line.match(/^\s{4}(\w+):\s*(.+)$/);
                if (propMatch) {
                    const [, key, rawValue] = propMatch;
                    const value = rawValue.replace(/^["']|["']$/g, '').trim();
                    if (key === 'context_mode' && (value === 'shared' || value === 'isolated')) {
                        current.contextMode = value;
                    } else if (key === 'context_group') {
                        current.contextGroup = value;
                    }
                }
            }
        }
    }

    // Don't forget the last account
    if (current) accounts.push(current);

    return accounts;
}
