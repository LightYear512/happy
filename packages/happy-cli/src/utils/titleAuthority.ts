/** Selects whether the model or an external session controller owns the Happy title. */
export type SessionTitleAuthority = 'model' | 'external';

export function sessionTitleAuthority(env: NodeJS.ProcessEnv = process.env): SessionTitleAuthority {
    const value = env.HAPPY_TITLE_AUTHORITY;
    if (value === undefined || value === '') return 'model';
    if (value === 'external') return value;
    throw new Error(`Invalid Happy title authority: ${value}`);
}

export function modelMayChangeTitle(env: NodeJS.ProcessEnv = process.env): boolean {
    return sessionTitleAuthority(env) === 'model';
}
