/** Console index maintenance: existing option buttons, isolated SQLite work, native Codex verification. */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { createCodexAppServerClient, type CodexAppServerClient } from '@/codex/codexAppServerClient';
import { buildCodexChildEnv } from '@/codex/codexEnvBuilder';
import { redactSensitive } from '@/codex/utils/redactSecrets';
import { readCodexProfiles, type CodexProfileInfo } from './ccsProfiles';
import { hasActiveInteractiveSession, registerInteractiveSession, unregisterInteractiveSession } from './interactiveSession';
import { type BangCommandContext, type BangCommandResult } from './types';

const resultSchema = z.object({
    status: z.enum(['ready', 'missing', 'incomplete', 'idle', 'repaired', 'native-required', 'error']),
    error: z.string().optional(),
});
let running = false;

/** The helper is short and atomic: cancellation waits for it, never kills it halfway through installation. */
async function indexHelper(options: Record<string, unknown>): Promise<z.infer<typeof resultSchema>> {
    return await new Promise((resolve, reject) => {
        execFile(process.execPath, [join(projectPath(), 'scripts', 'codex-index.mjs'), JSON.stringify(options)],
            { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
                const parsed = (() => { try { return resultSchema.safeParse(JSON.parse(stdout)); } catch { return null; } })();
                if (!parsed?.success) { reject(new Error('无法运行索引工具；本机需要支持 node:sqlite.backup 的 Node.js 22.16 或更新版本')); return; }
                if (error || parsed.data.status === 'error') { reject(new Error(parsed.data.error ?? '索引工具执行失败')); return; }
                resolve(parsed.data);
            });
    });
}
function environment(home: string): Record<string, string> {
    return buildCodexChildEnv({
        baseEnv: { ...process.env, CODEX_HOME: home }, emitLogs: false,
        keysToDelete: ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TURN_ID', 'CODEX_SQLITE_HOME', 'HAPPY_SESSION_STARTUP_DEADLINE_MS'],
    }).env;
}

/** Real fixed-response check. Uses no user conversation and rejects any model tool call. */
async function verifyReply(client: CodexAppServerClient, cwd: string, signal: AbortSignal): Promise<void> {
    const account = z.object({ account: z.object({ type: z.string() }).nullable() }).parse(await client.request('account/read', { refreshToken: false }));
    if (!account.account) throw new Error('账号认证已失效，请重新登录');
    const started = z.object({ thread: z.object({ id: z.string() }) }).parse(await client.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only' }));
    const threadId = started.thread.id;
    let answer = '';
    let resolveTurn!: () => void;
    let rejectTurn!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    void completed.catch(() => {}); // notification may fail while turn/start is still pending
    const stopOnAbort = () => rejectTurn(new Error('已取消'));
    const offItem = client.registerNotificationHandler('item/completed', params => {
        const event = z.object({ threadId: z.string(), item: z.object({ type: z.string(), text: z.string().optional() }) }).parse(params);
        if (event.threadId !== threadId) return;
        if (event.item.type === 'agentMessage') answer += event.item.text ?? '';
        else if (['commandExecution', 'mcpToolCall', 'fileChange', 'webSearch'].includes(event.item.type)) rejectTurn(new Error('连接测试出现工具调用，已停止测试'));
    });
    const offTurn = client.registerNotificationHandler('turn/completed', params => {
        const event = z.object({ threadId: z.string(), turn: z.object({ status: z.string(), error: z.object({ message: z.string(), codexErrorInfo: z.unknown().optional() }).nullable().optional() }) }).parse(params);
        if (event.threadId !== threadId) return;
        if (event.turn.error?.codexErrorInfo === 'usageLimitExceeded') rejectTurn(new Error('额度已用完；索引修复成功，但账号暂时不能聊天'));
        else if (event.turn.status !== 'completed' || answer.trim() !== 'INDEX_RECOVERY_OK') rejectTurn(new Error(event.turn.error?.message ?? '模型未返回预期的连接测试结果'));
        else resolveTurn();
    });
    const timer = setTimeout(() => rejectTurn(new Error('模型回复超时；索引状态与网络、额度需分别检查')), 90000);
    signal.addEventListener('abort', stopOnAbort, { once: true });
    try {
        signal.throwIfAborted();
        await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'This is a connectivity check. Do not use tools, browse, read files, or make changes. Reply with exactly INDEX_RECOVERY_OK and nothing else.' }], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, effort: 'low' });
        await completed;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', stopOnAbort); offItem(); offTurn(); }
}

async function maintainIndex(profile: CodexProfileInfo, profiles: CodexProfileInfo[], signal: AbortSignal, report: (text: string) => void): Promise<void> {
    const root = process.platform === 'darwin' ? '/private/tmp/xc-disposable' : join(tmpdir(), 'xc-disposable');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const work = await mkdtemp(join(root, 'happy-index-'));
    const reference = join(work, 'native-schema');
    await mkdir(reference, { mode: 0o700 });
    const native = await createCodexAppServerClient({ processEnv: environment(reference), cwd: work, signal });
    await native.dispose();
    signal.throwIfAborted();
    const result = await indexHelper({ action: 'repair', home: profile.codexHome, reference, sources: profiles.map(p => p.codexHome), work, backups: join(configuration.happyHomeDir, 'incidents', `index-${Date.now()}-${profile.name}`) });
    if (result.status === 'ready') { report(`✅ ${profile.name}：索引正常，无需修复。未进行模型调用。`); return; }
    signal.throwIfAborted();
    if (result.status === 'native-required') {
        await indexHelper({ action: 'idle', home: profile.codexHome });
        signal.throwIfAborted();
        report(`⏳ ${profile.name}：没有兼容的共享索引，正在由 Codex 原生初始化。历史较多时会较慢，可点取消。`);
        const initializing = await createCodexAppServerClient({ processEnv: environment(profile.codexHome), cwd: work, signal, initializeTimeoutMs: 30 * 60 * 1000 });
        await initializing.dispose();
    }
    const state = await indexHelper({ action: 'inspect', home: profile.codexHome, reference });
    if (state.status !== 'ready') throw new Error('索引回填尚未完成，请稍后重试');
    report(`✅ ${profile.name}：索引已修复，正在验证真实模型回复（会产生少量用量）。`);
    signal.throwIfAborted();
    const start = Date.now();
    const client = await createCodexAppServerClient({ processEnv: environment(profile.codexHome), cwd: work, signal, initializeTimeoutMs: 15000 });
    const elapsed = Date.now() - start;
    try {
        await verifyReply(client, work, signal);
        report(`✅ ${profile.name}：索引和真实聊天验证通过，初始化 ${elapsed} 毫秒。可返回 App 聊天。`);
    } finally { await client.dispose(); }
}

export async function handleIndexBangCommand(args: string, ctx: BangCommandContext): Promise<BangCommandResult> {
    const profiles = readCodexProfiles();
    const name = args.trim();
    if (!name) return {
        action: 'none', message: '检查并修复 Codex 索引\n请选择账号。正常索引会跳过；修复后会发送一条连接测试消息，产生少量用量。',
        suggestions: profiles.map(profile => ({ label: `检查并修复 ${profile.name}`, value: `!index ${profile.name}` })),
    };
    const profile = profiles.find(item => item.name === name);
    if (!profile) return { action: 'none', message: '❌ 未找到已登录的 Codex 账号，请从列表选择。', suggestions: ['!index'] };
    if (running || hasActiveInteractiveSession()) return { action: 'none', message: '⏳ 已有操作正在进行，请等待完成或取消。' };
    running = true;
    const controller = new AbortController();
    const report = (message: string): void => { ctx.client.sendCodexMessage({ type: 'message', message }); };
    registerInteractiveSession(text => {
        if (['!cancel', '取消'].includes(text.trim())) { controller.abort(); report('正在取消；已开始的索引安装会先安全完成。'); }
        else report('索引检查正在进行，完成后会自动显示结果。可使用 !cancel 取消。');
    });
    void maintainIndex(profile, profiles, controller.signal, report)
        .catch((error: unknown) => report(controller.signal.aborted ? '索引操作已取消；已完成的修复会保留。' : `⚠️ ${profile.name}：${redactSensitive(error instanceof Error ? error.message : String(error))}`))
        .finally(() => { running = false; unregisterInteractiveSession(); });
    return { action: 'none', message: `⏳ 正在检查 ${profile.name} 的索引…`, suggestions: [{ label: '取消索引操作', value: '!cancel' }] };
}
