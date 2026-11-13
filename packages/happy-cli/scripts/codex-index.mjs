/** Codex index maintenance. Runs outside the console so SQLite checks never block chat. */
import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, lstatSync, readdirSync, realpathSync, mkdirSync, renameSync, linkSync, unlinkSync, chmodSync, statSync, readFileSync, writeFileSync, openSync, closeSync, copyFileSync, constants } from 'node:fs';
import { join, basename, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const emptyTables = ['sqlite_sequence', 'thread_dynamic_tools', 'remote_control_enrollments', 'external_agent_config_imports', 'rollout_migration_state', 'rollout_migration_skipped_rollouts', 'projects', 'project_roots', 'project_idempotency_keys', 'thread_artifacts'];
const sharedTables = ['_sqlx_migrations', 'backfill_state', 'threads', 'thread_spawn_edges', 'thread_sections'];
const read = path => new DatabaseSync(path, { readOnly: true, timeout: 1000 });
const rows = (db, sql) => db.prepare(sql).all();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel); };
const migrations = db => rows(db, 'SELECT version, hex(checksum) AS checksum, success FROM _sqlx_migrations ORDER BY version');
const schemaRows = db => rows(db, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
const complete = db => same(rows(db, 'SELECT status FROM backfill_state'), [{ status: 'complete' }]);
function validPaths(db, shared) {
    return rows(db, 'SELECT id,rollout_path FROM threads').map(row => {
        const resolved = realpathSync(row.rollout_path);
        if (!inside(shared, resolved) || !statSync(resolved).isFile()) throw new Error('会话索引引用了缺失或不属于共享历史的文件');
        return { ...row, resolved };
    });
}
function healthy(db) {
    if (!same(rows(db, 'PRAGMA quick_check'), [{ quick_check: 'ok' }]) || rows(db, 'PRAGMA foreign_key_check').length) throw new Error('索引完整性检查失败，已保留原库');
}
function sqlPath(home, name) {
    const path = join(home, name);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('索引必须是账号独立文件，不能是链接');
    return path;
}
function stateFile(home) {
    const names = readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name));
    return names.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
}
function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error('无法确认账号是否空闲，未修改索引');
    return result.stdout;
}
/** Read only CODEX_HOME from process environments; never return environment or credentials. */
export function assertIdle(home) {
    if (!['darwin', 'linux'].includes(process.platform)) throw new Error('此平台暂不支持安全索引修复，请在 Mac 或 Linux 主机操作');
    const processes = run('ps', ['-axo', 'pid=,comm=']);
    for (const line of processes.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match || !/(^|\/)codex(?:\.exe)?$/.test(match[2])) continue;
        const result = spawnSync('ps', ['eww', '-p', match[1], '-o', 'command='], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
        if (result.status === 1 && !result.stdout) continue; // process exited
        if (result.error || result.status !== 0) throw new Error('无法确认 Codex 进程所属账号');
        const active = result.stdout.match(/(?:^|\s)CODEX_HOME=(.*?)(?=\s[A-Za-z_][A-Za-z_0-9]*=|$)/)?.[1];
        if (active && existsSync(active) && realpathSync(active) === realpathSync(home)) throw new Error('账号正在使用，请结束该账号的会话后重试；不会强制中断会话');
    }
    const files = readdirSync(home).filter(name => /^state_\d+\.sqlite(?:-wal|-shm)?$/.test(name)).map(name => join(home, name));
    if (files.length) {
        const result = spawnSync('lsof', ['-t', '--', ...files], { encoding: 'utf8', timeout: 10000 });
        if (result.error || ![0, 1].includes(result.status) || result.stdout.trim()) throw new Error('索引正被占用或无法确认空闲，未修改索引');
    }
}

export function inspectIndex(home, reference) {
    const name = stateFile(reference ?? home);
    if (!name || !existsSync(join(home, name))) return { status: 'missing' };
    const db = read(sqlPath(home, name));
    try {
        if (reference) {
            const ref = read(join(reference, name));
            try { if (!same(migrations(db), migrations(ref))) return { status: 'incomplete', file: name }; } finally { ref.close(); }
        }
        if (!complete(db)) return { status: 'incomplete', file: name };
        healthy(db);
        validPaths(db, realpathSync(join(home, 'sessions')));
        return { status: 'ready', file: name, threads: rows(db, 'SELECT count(*) AS n FROM threads')[0].n };
    } finally { db.close(); }
}

/** Copy a completed native index only when the current native schema and shared history agree. */
export async function repairIndex({ home, reference, sources, work, backups }) {
    const name = stateFile(reference);
    if (!name) throw new Error('当前 Codex 未生成索引，无法校验数据库版本');
    const target = sqlPath(home, name);
    const ref = read(join(reference, name));
    const expected = migrations(ref);
    const sections = rows(ref, 'SELECT * FROM thread_sections');
    const schema = schemaRows(ref);
    ref.close();
    const shared = realpathSync(join(home, 'sessions'));
    const originalPaths = new Map();
    let incompatible = !existsSync(target) && Boolean(stateFile(home));
    let old;
    if (existsSync(target)) {
        old = read(target);
        try {
            if (complete(old) && same(migrations(old), expected)) { healthy(old); validPaths(old, shared); return { status: 'ready' }; }
            incompatible = !same(migrations(old), expected) || !same(schemaRows(old), schema);
            if (!incompatible) {
                incompatible = emptyTables.some(table => rows(old, `SELECT count(*) AS n FROM ${table}`)[0].n !== 0) || !same(rows(old, 'SELECT * FROM thread_sections'), sections);
                for (const row of validPaths(old, shared)) originalPaths.set(row.id, row.resolved);
            }
        } finally { old.close(); }
    }
    assertIdle(home);
    const lock = join(home, '.happy-index-repair.lock');
    acquireLock(lock);
    try {
        for (const sourceHome of incompatible ? [] : sources) {
            if (realpathSync(sourceHome) === realpathSync(home)) continue;
            let source;
            let stage;
            const stagePath = join(work, 'prepared.sqlite');
            try {
                if (realpathSync(join(sourceHome, 'sessions')) !== shared) continue;
                const sourcePath = sqlPath(sourceHome, name);
                if (!existsSync(sourcePath)) continue;
                source = read(sourcePath);
                if (!complete(source) || !same(migrations(source), expected)) continue;
                if (!same(rows(source, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(r => r.name), [...emptyTables, ...sharedTables].sort())) continue;
                if (!same(schemaRows(source), schema)) continue;
                if (!same(rows(source, 'SELECT * FROM thread_sections'), sections)) continue;
                if (emptyTables.some(table => rows(source, `SELECT count(*) AS n FROM ${table}`)[0].n !== 0)) continue;
                if (existsSync(stagePath)) unlinkSync(stagePath);
                await backup(source, stagePath);
                source.close(); source = undefined;
                stage = new DatabaseSync(stagePath);
                // Validate the actual snapshot, not a source that may have changed during backup.
                healthy(stage);
                if (!complete(stage) || !same(migrations(stage), expected) || !same(schemaRows(stage), schema)) continue;
                if (emptyTables.some(table => rows(stage, `SELECT count(*) AS n FROM ${table}`)[0].n !== 0)) continue;
                if (!same(rows(stage, 'SELECT * FROM thread_sections'), sections)) continue;
                const paths = validPaths(stage, shared);
                const copiedPaths = new Map(paths.map(row => [row.id, row.resolved]));
                if ([...originalPaths].some(([id, path]) => copiedPaths.get(id) !== path)) continue;
                const update = stage.prepare('UPDATE threads SET rollout_path=? WHERE id=?');
                stage.exec('BEGIN');
                for (const row of paths) update.run(row.resolved, row.id);
                stage.exec('COMMIT');
                stage.exec('PRAGMA wal_checkpoint(TRUNCATE)');
                stage.exec('PRAGMA journal_mode=DELETE');
                healthy(stage); stage.close(); stage = undefined;
            } catch { continue; }
            finally { stage?.close(); source?.close(); }
            // A continue inside the candidate checks skips this installation block.
            assertIdle(home);
            const snapshot = read(stagePath);
            try {
                if (existsSync(target)) {
                    const current = read(target);
                    try {
                        if (complete(current)) { healthy(current); validPaths(current, shared); return { status: 'ready' }; }
                        if (emptyTables.some(table => rows(current, `SELECT count(*) AS n FROM ${table}`)[0].n !== 0) || !same(rows(current, 'SELECT * FROM thread_sections'), sections)) throw new Error('目标账号专属记录已变化，未替换');
                        const snapshotPaths = new Map(validPaths(snapshot, shared).map(row => [row.id, row.resolved]));
                        if (!same(migrations(current), expected) || !same(schemaRows(current), schema) || validPaths(current, shared).some(row => snapshotPaths.get(row.id) !== row.resolved)) throw new Error('目标索引已变化，未替换');
                    } finally { current.close(); }
                }
                healthy(snapshot);
            } finally { snapshot.close(); }
            mkdirSync(backups, { recursive: true, mode: 0o700 });
            const saved = [];
            try {
                if (existsSync(target)) {
                    const original = read(target);
                    try { await backup(original, join(backups, 'before.sqlite')); } finally { original.close(); }
                }
                assertIdle(home);
                for (const suffix of ['', '-wal', '-shm']) {
                    const path = target + suffix;
                    if (existsSync(path)) { const dest = join(backups, basename(path)); renameSync(path, dest); saved.push([dest, path]); }
                }
                // link + unlink installs without overwriting a newly-created database; source is never linked.
                chmodSync(stagePath, 0o600); linkSync(stagePath, target); unlinkSync(stagePath);
            } catch (error) {
                if (!existsSync(target)) for (const [savedPath, path] of saved) renameSync(savedPath, path);
                throw error;
            }
            const installed = read(target);
            try { healthy(installed); validPaths(installed, shared); if (!complete(installed)) throw new Error('修复后索引仍未完成'); }
            finally { installed.close(); }
            return { status: 'repaired', backup: backups };
        }
        assertIdle(home);
        mkdirSync(backups, { recursive: true, mode: 0o700 });
        // Native migration/backfill retains its own database; keep an untouched recovery copy first.
        for (const file of readdirSync(home).filter(file => /^state_\d+\.sqlite(?:-wal|-shm)?$/.test(file))) {
            copyFileSync(sqlPath(home, file), join(backups, file), constants.COPYFILE_EXCL);
        }
        return { status: 'native-required' };
    } finally { unlinkSync(lock); }
}

function acquireLock(path) {
    try {
        const fd = openSync(path, 'wx', 0o600);
        try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(readFileSync(path, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('修复锁无效，请检查本机锁文件');
        try { process.kill(pid, 0); } catch (error) {
            if (error.code === 'ESRCH') { unlinkSync(path); return acquireLock(path); }
            throw new Error('无法确认索引修复进程状态');
        }
        throw new Error('此账号已有索引修复在运行');
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.umask(0o077);
    try {
        const options = JSON.parse(process.argv[2]);
        const result = options.action === 'inspect' ? inspectIndex(options.home, options.reference)
            : options.action === 'idle' ? (assertIdle(options.home), { status: 'idle' })
            : await repairIndex(options);
        process.stdout.write(JSON.stringify(result));
    } catch (error) {
        process.stdout.write(JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : '索引检查失败' }));
        process.exitCode = 1;
    }
}
