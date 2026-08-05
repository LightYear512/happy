import { describe, expect, it } from 'vitest'
import { applyQueryEnvironment } from './query'

describe('applyQueryEnvironment', () => {
    it('overlays subprocess identity without mutating the base environment', () => {
        const base = {
            PATH: '/base/bin',
            HTASK_SESSION_CONFIG_ID: 'stale-native',
            REMOVE_ME: 'value',
        }

        const result = applyQueryEnvironment(base, {
            HTASK_SESSION_CONFIG_ID: 'current-native',
            REMOVE_ME: undefined,
        })

        expect(result).toEqual({
            PATH: '/base/bin',
            HTASK_SESSION_CONFIG_ID: 'current-native',
        })
        expect(base).toEqual({
            PATH: '/base/bin',
            HTASK_SESSION_CONFIG_ID: 'stale-native',
            REMOVE_ME: 'value',
        })
    })
})
