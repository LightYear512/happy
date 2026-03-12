import { MMKV } from 'react-native-mmkv';

// Separate MMKV instance for server config that persists across logouts
const serverConfigStorage = new MMKV({ id: 'server-config' });

const SERVER_KEY = 'custom-server-url';
const DEFAULT_SERVER_URL = 'https://api.cluster-fluster.com';

export function getServerUrl(): string {
    return serverConfigStorage.getString(SERVER_KEY) || 
           process.env.EXPO_PUBLIC_HAPPY_SERVER_URL || 
           DEFAULT_SERVER_URL;
}

export function setServerUrl(url: string | null): void {
    if (url && url.trim()) {
        serverConfigStorage.set(SERVER_KEY, url.trim());
    } else {
        serverConfigStorage.delete(SERVER_KEY);
    }
}

export function isUsingCustomServer(): boolean {
    return getServerUrl() !== DEFAULT_SERVER_URL;
}

export function getServerInfo(): { hostname: string; port?: number; isCustom: boolean } {
    const url = getServerUrl();
    const isCustom = isUsingCustomServer();
    
    try {
        const parsed = new URL(url);
        const port = parsed.port ? parseInt(parsed.port) : undefined;
        return {
            hostname: parsed.hostname,
            port,
            isCustom
        };
    } catch {
        // Fallback if URL parsing fails
        return {
            hostname: url,
            port: undefined,
            isCustom
        };
    }
}

export function validateServerUrl(url: string): { valid: boolean; error?: string } {
    console.log('[validateServerUrl] Input:', url);

    if (!url || !url.trim()) {
        console.log('[validateServerUrl] URL is empty');
        return { valid: false, error: 'Server URL cannot be empty' };
    }

    try {
        console.log('[validateServerUrl] Parsing URL with URL constructor...');
        const parsed = new URL(url);
        console.log('[validateServerUrl] Parsed successfully:', {
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port,
            pathname: parsed.pathname,
            href: parsed.href
        });

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            console.error('[validateServerUrl] Invalid protocol:', parsed.protocol);
            return { valid: false, error: 'Server URL must use HTTP or HTTPS protocol' };
        }

        console.log('[validateServerUrl] ✅ Validation passed');
        return { valid: true };
    } catch (err) {
        console.error('[validateServerUrl] URL parsing failed:', err);
        console.error('[validateServerUrl] Error message:', err instanceof Error ? err.message : String(err));
        return { valid: false, error: 'Invalid URL format' };
    }
}