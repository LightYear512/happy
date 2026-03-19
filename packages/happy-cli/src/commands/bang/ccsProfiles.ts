import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as yaml from 'js-yaml';
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

