import { describe, expect, it, vi } from 'vitest'

const queryMock = vi.hoisted(() => vi.fn())

vi.mock('./query', () => ({ query: queryMock }))

import { extractSDKMetadata } from './metadataExtractor'

describe('extractSDKMetadata', () => {
    it('passes native htask identity to the metadata subprocess without mutating process.env', async () => {
        const original = process.env.HTASK_SESSION_CONFIG_ID
        const environment = {
            HTASK_SESSION_CONFIG_ID: 'cmr-native-session',
            HTASK_CODEX_HAPPY: 'codex-HT-0371',
        }

        queryMock.mockReturnValue((async function* () {
            yield {
                type: 'system',
                subtype: 'init',
                tools: ['Bash'],
                slash_commands: ['/help'],
            }
        })())

        const metadata = await extractSDKMetadata(environment)

        expect(metadata).toEqual({ tools: ['Bash'], slashCommands: ['/help'] })
        expect(queryMock).toHaveBeenCalledWith({
            prompt: 'hello',
            options: expect.objectContaining({ environment }),
        })
        expect(process.env.HTASK_SESSION_CONFIG_ID).toBe(original)
    })
})
