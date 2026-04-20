/**
 * Agent authentication flow for happy-cli.
 *
 * Requests an account-scoped credential (agent.key) from the Happy server by
 * displaying a QR code that the user scans with the Happy mobile app.  The
 * resulting {token, secret} pair is written to configuration.agentKeyFile and
 * is consumed by localHappyAgentAuth.ts to enable session-resume features.
 */

import axios, { AxiosError } from 'axios';
import tweetnacl from 'tweetnacl';
import qrcode from 'qrcode-terminal';
import { writeFileSync } from 'node:fs';
import { encodeBase64, encodeBase64Url, decodeBase64, decryptBoxBundle, getRandomBytes } from '@/api/encryption';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

const POLL_INTERVAL_MS = 1000;
const AUTH_TIMEOUT_MS = 120_000; // 2 minutes

interface AuthRequestResponse {
    state: 'requested' | 'authorized';
    token?: string;
    /** base64-encoded encrypted account secret */
    response?: string;
}

function isAuthRequestResponse(val: unknown): val is AuthRequestResponse {
    if (typeof val !== 'object' || val === null) return false;
    const state = (val as Record<string, unknown>).state;
    return state === 'requested' || state === 'authorized';
}

/**
 * Run the agent-auth QR-code flow and write credentials to agent.key.
 *
 * @param serverUrl - Happy server base URL (e.g. https://api.happy-servers.com)
 * @throws if the request fails or times out
 */
export async function requestAgentAuth(serverUrl: string): Promise<void> {
    // 1. Generate ephemeral NaCl box keypair
    const seed = getRandomBytes(32);
    const keypair = tweetnacl.box.keyPair.fromSecretKey(seed);
    const publicKeyBase64 = encodeBase64(keypair.publicKey);

    // 2. POST /v1/auth/account/request to register the public key
    try {
        await axios.post(`${serverUrl}/v1/auth/account/request`, { publicKey: publicKeyBase64 });
    } catch (err) {
        if (err instanceof AxiosError) {
            throw new Error(`Failed to initiate agent auth: ${err.message}`);
        }
        throw err;
    }

    // 3. Display QR code for the mobile app
    const qrData = `happy:///account?${encodeBase64Url(keypair.publicKey)}`;
    console.log('');
    qrcode.generate(qrData, { small: true }, (code: string) => {
        console.log(code);
    });
    console.log('Scan this QR code with the Happy app to enable session resume.');
    console.log('Path: Settings → Account → Link New Device');
    console.log('');

    // 4. Poll until authorized or timeout
    const startTime = Date.now();
    while (Date.now() - startTime < AUTH_TIMEOUT_MS) {
        await sleep(POLL_INTERVAL_MS);

        let result: unknown;
        try {
            const resp = await axios.post(`${serverUrl}/v1/auth/account/request`, {
                publicKey: publicKeyBase64,
            });
            result = resp.data;
        } catch (err) {
            if (err instanceof AxiosError) {
                throw new Error(`Agent auth polling failed: ${err.message}`);
            }
            throw err;
        }

        if (!isAuthRequestResponse(result)) {
            logger.debug('[agentAuth] Unexpected poll response shape, continuing...');
            continue;
        }

        if (result.state === 'authorized' && result.token && result.response) {
            // 5. Decrypt the encrypted account secret with the ephemeral secret key
            const encryptedResponse = decodeBase64(result.response);
            const accountSecret = decryptBoxBundle(encryptedResponse, keypair.secretKey);
            if (!accountSecret) {
                throw new Error('Failed to decrypt agent auth response');
            }

            // 6. Write credentials in the format consumed by AgentCredentialsSchema
            const credentials = JSON.stringify({
                token: result.token,
                secret: encodeBase64(accountSecret),
            });
            writeFileSync(configuration.agentKeyFile, credentials, { encoding: 'utf-8', mode: 0o600 });
            logger.debug('[agentAuth] Credentials written to agent.key');
            return;
        }
    }

    throw new Error('Agent authentication timed out. Please try again.');
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
