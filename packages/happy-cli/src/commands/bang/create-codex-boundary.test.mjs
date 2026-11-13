import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';

test('codex_menu_creation_keeps_provider_and_session_selection', () => {
  const work = mkdtempSync('/private/tmp/xc-disposable/happy-create-codex-test-');
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mkdir, writeFile, readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { handleCreateCodexCommand, CODEX_CREATE_OPTIONS } from './src/commands/bang/createCodexCommand.ts';
    import { buildConsoleWelcome, executeBangCommand, consoleCommandText, createConsoleMenu } from './src/commands/bang/dispatcher.ts';
    import { handleAuthBangCommand } from './src/commands/bang/authCommand.ts';
    import { parseLoginArgs } from './src/commands/bang/loginCommand.ts';
    import { renderOptionsBlock } from './src/commands/bang/types.ts';
    import { readCodexModelFamily } from './src/codex/defaultModelConfig.ts';
    import { publishAccountIntent, resolveStartupAccountSelection, readAccountIntent,
      writeSessionAccountSelection, readSessionAccountSelection } from './src/commands/bang/accountIntent.ts';
    import { startDaemonControlServer } from './src/daemon/controlServer.ts';
    import { createSessionMetadata } from './src/utils/createSessionMetadata.ts';

    const home = process.env.HAPPY_HOME_DIR;
    const base = join(home, 'auth/codex/instances');
    for (const [name, config] of [['gpt-one', 'model="gpt-6-astra"'], ['gpt-two', 'model="gpt-6-astra"\nmodel_provider="custom-proxy"'], ['deepseek', 'model="deepseek-flash"\nmodel_provider="deepseek"']]) {
      await mkdir(join(base, name), {recursive:true});
      await writeFile(join(base,name,'auth.json'), '{}');
      await writeFile(join(base,name,'config.toml'), config);
    }
    await writeFile(join(base,'config.yaml'), 'default: gpt-one\n');
    const ccsDir = join(home, 'ccs');
    process.env.CCS_DIR = ccsDir;
    await mkdir(join(ccsDir, 'instances', 'claude-one'), {recursive:true});
    await writeFile(join(ccsDir, 'config.yaml'), 'default: claude-one\naccounts:\n  claude-one: {}\n');
    const directory = join(home,'project with 空格 | quotes "');
    await mkdir(directory);
    await mkdir(join(home,'restore'));
    await writeFile(join(home,'restore','one.json'), JSON.stringify({agent:'codex', directory:'/'}));
    await writeFile(join(home,'restore','duplicate.json'), JSON.stringify({agent:'codex', directory:'/'}));
    await writeFile(join(home,'restore','broken.json'), '{broken');
    assert.equal(readCodexModelFamily(join(base,'gpt-one')), 'gpt');
    assert.equal(readCodexModelFamily(join(base,'deepseek')), 'deepseek');

    const events=[];
    const ctx={isConsoleSession:true,flavor:'codex',client:{sendSessionEvent:event=>events.push(event)}};
    const menu = createConsoleMenu();
    const legacyOptions = result => menu.render(result.suggestions ?? []).split('\n').flatMap(line => {
      const match=line.match(/<option>(.*?)<\/option>/);
      return match ? [match[1]] : [];
    });
    const welcome=buildConsoleWelcome();
    assert.equal(legacyOptions(welcome).length,6);
    assert.deepEqual(await executeBangCommand('❇️ @@ 主菜单',ctx),welcome);
    const tools=await executeBangCommand('!help',ctx);
    const main=tools.suggestions.find(option=>option.value==='@@');
    assert.equal(main.label,'❇️ @@ 主菜单');
    assert.deepEqual(await executeBangCommand(main.value,ctx),welcome);
    assert.deepEqual(welcome.suggestions.slice(0,4).map(option=>option.label),[
      '创建codex+GPT会话','创建codex+DeepSeek会话','切换GPT账号','切换DeepSeek账号']);
    for(const option of CODEX_CREATE_OPTIONS) assert.ok(welcome.suggestions.some(s=>s.value===option.value && s.label===option.label));
    assert.match(renderOptionsBlock(welcome.suggestions), /value="!create-codex deepseek"/);
    const gpt=await executeBangCommand(consoleCommandText(legacyOptions(welcome)[0]),ctx);
    assert.ok(gpt.suggestions.some(s=>s.value==='!create-codex gpt gpt-one'));
    assert.ok(!gpt.suggestions.some(s=>s.value?.includes('deepseek')));
    const ds=await executeBangCommand(consoleCommandText(legacyOptions(welcome)[1]),ctx);
    const paths=ds.suggestions.filter(s=>typeof s==='object' && s.label==='/');
    assert.equal(paths.length,1);
    const wrong=await handleCreateCodexCommand('gpt deepseek',ctx);
    assert.match(wrong.message,/不属于/);
    const blocked=await executeBangCommand('!create-codex deepseek',{...ctx,isConsoleSession:false});
    assert.match(blocked.message,/仅在控制台/);

    const global=publishAccountIntent('codex','gpt-one',100,home);
    const claudeButton = legacyOptions(welcome).find(label => label === '切换Claude账号');
    assert.ok(claudeButton);
    assert.equal(menu.resolve(claudeButton), '@aa --Claude');
    const claudeAccounts = await executeBangCommand(menu.resolve(claudeButton), ctx);
    assert.match(claudeAccounts.message, /Claude/);
    assert.match(claudeAccounts.afterSuggestionsMessage, /claude-one/);
    assert.ok(!JSON.stringify(claudeAccounts).includes('gpt-one'));
    const switchedClaude = await executeBangCommand('@aa --Claude claude-one', ctx);
    assert.match(switchedClaude.message.join('\n'), /全局账号已设置为 "claude-one"/);
    const claudeGlobal = readAccountIntent('claude', home);
    assert.equal(claudeGlobal.profileName, 'claude-one');
    assert.equal(resolveStartupAccountSelection(null, claudeGlobal).profileName, 'claude-one');
    assert.deepEqual(readAccountIntent('codex', home), global);
    const codexAccounts = await executeBangCommand('@aa-codex', ctx);
    assert.match(codexAccounts.message, /Codex/);
    assert.ok(!JSON.stringify(codexAccounts).includes('claude-one'));
    assert.match((await executeBangCommand('@aa claude-one', {...ctx, isConsoleSession:false})).message, /仅在控制台/);
    const managementCtx = {...ctx, flavor:undefined};
    assert.deepEqual(parseLoginArgs('--Claude box2601', ctx.flavor), {
      kind:'ok', profileName:'box2601', targetAgent:'claude',
    });
    const claudeLogin = await executeBangCommand('!login --Claude', ctx);
    assert.match(claudeLogin.message.join('\n'), /Claude 账户/);
    assert.match(claudeLogin.message.join('\n'), /claude-one/);
    const codexLogin = await executeBangCommand('!login --codex', managementCtx);
    assert.match(codexLogin.message.join('\n'), /Codex 账户/);
    assert.match(codexLogin.message.join('\n'), /gpt-one/);
    assert.ok(!codexLogin.message.join('\n').includes('claude-one'));
    assert.match((await executeBangCommand('@u --Claude', ctx)).message, /Claude/);
    assert.ok((await executeBangCommand('@u --codex', managementCtx)).suggestions.some(s=>s.includes('gpt-one')));
    assert.match(claudeLogin.message.join('\n'), /!login --Claude/);
    assert.ok(codexAccounts.suggestions.some(s => typeof s === 'string' && s.includes('@aa --codex')));
    assert.ok((await executeBangCommand('@u --codex', ctx)).suggestions.some(s => s.includes('@u --codex gpt-one')));
    assert.deepEqual(await executeBangCommand('@l-codex', managementCtx), codexLogin);
    for (const command of ['!login', '!auth-all', '!usage']) {
      const rejected = await executeBangCommand(command + ' --Claude --codex claude-one', ctx);
      assert.match(rejected.message, /不能同时使用/);
      assert.equal(rejected.action, 'none');
    }
    assert.deepEqual(readAccountIntent('claude', home), claudeGlobal);
    assert.deepEqual(readAccountIntent('codex', home), global);
    for (const command of ['!login', '!auth', '!usage']) {
      const rejected = await executeBangCommand(command + ' --Claude box2601', {...ctx, isConsoleSession:false});
      assert.match(rejected.message, /普通会话不支持 --Claude/);
    }
    const selected=resolveStartupAccountSelection(null,global,'deepseek');
    assert.deepEqual(selected,{profileName:'deepseek',seenGlobalSetAt:100,source:'session'});
    writeSessionAccountSelection('new-session','codex',selected.profileName,selected.seenGlobalSetAt,home);
    const saved=readSessionAccountSelection('new-session','codex',home);
    assert.equal(resolveStartupAccountSelection(saved,global).profileName,'deepseek');
    assert.equal(resolveStartupAccountSelection(saved,{profileName:'gpt-two',setAt:101}).profileName,'gpt-two');
    assert.deepEqual(readAccountIntent('codex',home),global);

    const seen=[];
    const server=await startDaemonControlServer({getChildren:()=>[
      {startedBy:'daemon',happySessionId:'gpt-session',pid:process.pid,inputState:'ready'},
      {startedBy:'daemon',happySessionId:'ds-session',pid:process.pid,inputState:'ready'},
      {startedBy:'daemon',happySessionId:'unregistered-session',pid:process.pid,inputState:'ready'},
    ], stopSession:async()=>true,
      restoreSession:async()=>({type:'error',errorMessage:'unused'}),
      spawnSession:async options=>{seen.push(options);return {type:'success',sessionId:'new-session'};},
      prepareShutdown:async()=>({accepted:true}),requestShutdown:()=>{},onHappySessionWebhook:()=>{}});
    try {
      await writeFile(join(home,'daemon.state.json'),JSON.stringify({pid:process.pid,httpPort:server.port}));
      await writeFile(join(home,'restore','gpt-session.json'),JSON.stringify({directory,agent:'codex',codexProfile:'gpt-one'}));
      await writeFile(join(home,'restore','ds-session.json'),JSON.stringify({directory,agent:'codex',codexProfile:'deepseek'}));
      const gptAccounts=await executeBangCommand('!switch-codex gpt',ctx);
      assert.ok(gptAccounts.suggestions.some(option=>option.value==='!switch-codex gpt gpt-two'));
      assert.ok(!gptAccounts.suggestions.some(option=>option.value?.includes('deepseek')));
      assert.ok(!JSON.stringify(gptAccounts).includes('gpt-session'));
      const dsAccounts=await executeBangCommand('!switch-codex deepseek',ctx);
      const dsButton=legacyOptions(dsAccounts).find(text=>text.startsWith('deepseek'));
      assert.ok(dsButton && !dsButton.includes('!switch-codex'));
      const dsSelected=await executeBangCommand(menu.resolve(dsButton),ctx);
      assert.match(dsSelected.message.join('\n'),/下一次实际输入/);
      assert.deepEqual(readAccountIntent('codex',home),global);
      assert.equal(readAccountIntent('codex',home,'deepseek').profileName,'deepseek');
      const dsBefore=await readFile(join(home,'deepseek-account-intent.json'),'utf8');
      const gptButton=legacyOptions(gptAccounts).find(text=>text.startsWith('gpt-two'));
      assert.ok(gptButton.includes('🔵') && !gptButton.includes('!switch-codex'));
      await executeBangCommand(menu.resolve(gptButton),ctx);
      assert.equal(readAccountIntent('codex',home,'gpt').profileName,'gpt-two');
      assert.deepEqual(readAccountIntent('claude',home),claudeGlobal);
      assert.equal(await readFile(join(home,'deepseek-account-intent.json'),'utf8'),dsBefore);
      for(const command of ['!switch-codex gpt deepseek','!switch-codex deepseek gpt-one','!switch-codex gpt missing']) {
        const rejected=await executeBangCommand(command,ctx);
        assert.match(rejected.message,/不属于/);
      }
      assert.match((await executeBangCommand('!switch-codex gpt',{...ctx,isConsoleSession:false})).message,/仅在控制台/);
      const currentGlobal=readAccountIntent('codex',home);
      process.env.CODEX_HOME=join(base,'gpt-one');
      const sessionCtx={...ctx,isConsoleSession:false,flavor:'codex',deferCodexProfileSwitch:true};
      assert.match((await handleAuthBangCommand('deepseek',sessionCtx)).message,/同一模型类型/);
      const switchGpt=await handleAuthBangCommand('gpt-two',sessionCtx);
      assert.equal(switchGpt.action,'restart-session');
      assert.equal(switchGpt.restartProfile,'gpt-two');
      assert.equal(process.env.CODEX_HOME,join(base,'gpt-one'));
      assert.deepEqual(readAccountIntent('codex',home),currentGlobal);
      const directoryOption=legacyOptions({suggestions:[{label:directory,value:'!create-codex deepseek deepseek '+encodeURIComponent(directory)}]})[0];
      assert.ok(!directoryOption.includes('!create-codex'));
      const created=await executeBangCommand(menu.resolve(directoryOption),ctx);
      assert.ok(created.message.some(text=>text.includes('已创建 Codex + DeepSeek')));
      assert.equal(seen.length,1);
      assert.equal(seen[0].directory,directory);
      assert.equal(seen[0].agent,'codex');
      assert.deepEqual(seen[0].environmentVariables,{CODEX_HOME:join(base,'deepseek')});
      assert.equal(seen[0].restoreSessionId,undefined);
      assert.equal(seen[0].resume,undefined);
      assert.equal(seen[0].title,'Codex + DeepSeek');
      for(const body of [
        {agent:'claude',codexProfile:'deepseek'},
        {agent:'codex',codexProfile:'../deepseek'},
        {agent:'codex',codexProfile:'missing'},
        {agent:'codex',codexProfile:'deepseek',resume:'old-thread'},
        {agent:'codex',codexProfile:'deepseek',sessionId:'old-session'},
      ]) {
        const r=await fetch('http://127.0.0.1:'+server.port+'/spawn-session',{
          method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({directory,...body})});
        assert.equal(r.status,400);
      }
      assert.equal(seen.length,1);
      const configured=await readFile(join(base,'config.yaml'),'utf8');
      assert.equal(configured,'default: gpt-one\n');
      process.env.HAPPY_RESUME_TITLE='Codex + DeepSeek';
      const metadata=createSessionMetadata({flavor:'codex',machineId:'test-machine',startedBy:'daemon'}).metadata;
      assert.equal(metadata.name,'Codex + DeepSeek');
      assert.equal(metadata.currentModelCode,'default');
      const consoleMetadata=createSessionMetadata({flavor:'codex',machineId:'test-machine',consoleSession:true}).metadata;
      assert.equal(consoleMetadata.name,'happy 控制台');
      assert.equal(consoleMetadata.flavor,'codex');
      assert.equal(consoleMetadata.consoleSession,true);
      process.env.HAPPY_RESUME_TITLE='x'.repeat(100);
      assert.notEqual(createSessionMetadata({flavor:'codex',machineId:'test-machine'}).metadata.name,process.env.HAPPY_RESUME_TITLE);
    } finally {await server.stop();}
  `;
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: new URL('../../..', import.meta.url), encoding: 'utf8', timeout: 30000,
      env: {...process.env, HAPPY_HOME_DIR: work, DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: ''},
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {rmSync(work,{recursive:true,force:true});}
});
