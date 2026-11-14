// Real Chromium, HTTP routes, product controller and Win32 callbacks in an isolated host.
const {spawn} = require('node:child_process');
const {createRequire} = require('node:module');
const {mkdir, writeFile} = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../../..');
const {chromium, expect} = createRequire(path.join(root, 'frontend/plugin-manager/package.json'))('@playwright/test');
const child = spawn(path.join(root,'.venv/Scripts/python.exe'), ['-u',path.join(__dirname,'safety_host_fixture.py')], {cwd:root,windowsHide:true});
let stderr = ''; child.stderr.on('data',chunk=>stderr+=chunk);
const ready = new Promise((resolve,reject)=>{
  let text='';const timer=setTimeout(()=>reject(new Error('Fixture did not start: '+stderr)),20000);
  child.stdout.on('data',chunk=>{text+=chunk;const match=text.match(/\{"port":\s*(\d+),\s*"pid":\s*(\d+)\}/);if(match){clearTimeout(timer);resolve({port:+match[1],pid:+match[2]});}});
  child.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exited '+code+': '+stderr));});
});
(async()=>{
  let browser, base; const results={environment:'isolated source host; no Steam host changes; no TTS', checks:[]};
  try {
    const identity=await ready;base='http://127.0.0.1:'+identity.port;results.fixture=identity;
    const post=async(url,data={})=>{const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(r.ok,true,await r.text());};
    const state=async()=>await (await fetch(base+'/__test__/state')).json();
    browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(10000);
    let failPolls=false, blockHostedUi=false;
    await page.route('**/hosted-ui/action/desktop_command',async route=>{
      if(blockHostedUi || failPolls && route.request().postDataJSON().args.command==='poll')await route.abort('internetdisconnected');
      else await route.continue();
    });
    await page.route('**/hosted-ui/context?*',async route=>{
      if(blockHostedUi)await route.abort('internetdisconnected');
      else await route.continue();
    });
    results.page_errors=[];page.on('pageerror',error=>results.page_errors.push(error.message));
    await page.goto(base);const launcher=page.locator('#neko-ads-launcher'),cards=page.locator('.neko-ad-placeholder');
    const openDialog=async()=>{if(!await page.locator('#neko-ads-dialog').evaluate(el=>el.open))await launcher.click();};
    const defaultKey=process.env.NEKO_ADS_TEST_DEFAULT_KEY || 'Ctrl+Shift+1';
    const customKey=process.env.NEKO_ADS_TEST_CUSTOM_KEY || 'Ctrl+Alt+K';
    const start=async(shortcut=defaultKey)=>{
      await expect(launcher).toContainText('待机中');await openDialog();
      const key=page.locator('#neko-ads-key');
      if(await key.inputValue()!==shortcut)await key.press(shortcut.replaceAll('Ctrl','Control'));
      await page.locator('#neko-ads-voice').uncheck();await page.locator('#neko-ads-start').click();
      try { await expect(cards.first()).toBeVisible(); }
      catch (error) {
        error.message += '\nStart status: ' + await page.locator('#neko-ads-state').textContent();
        throw error;
      }
      const round=await state();
      assert.equal(round.shortcut,shortcut);
      return round.round_id;
    };
    const checkRetired=async(id)=>{
      const next=await state();
      assert.equal(next.active,false);
      assert.ok(next.retired_round_ids.includes(id),'backend must retire the original round');
      await expect(cards).toHaveCount(0);
    };
    for(const shortcut of [defaultKey,customKey]){
      await post('/__test__/mode',{poll_delay:0});const id=await start(shortcut);
      if(shortcut===customKey){
        failPolls=true;
        await expect(launcher).toContainText('重连',{timeout:12000});
      }else{
        await post('/__test__/mode',{poll_delay:8});
        await page.waitForRequest(request=>request.url().endsWith('/action/desktop_command') && request.postDataJSON().args.command==='poll');
      }
      const began=Date.now();await post('/__test__/native-exit');
      await expect(cards).toHaveCount(0,{timeout:1800});
      const clear_ms=Date.now()-began;
      await checkRetired(id);
      failPolls=false;
      await post('/__test__/mode',{poll_delay:0});await expect(launcher).toContainText('待机中',{timeout:12000});
      await checkRetired(id);
      results.checks.push({name:(shortcut===customKey?'native key during reconnection ':'native key with hung action ')+shortcut,clear_ms,passed:true});
    }
    const reconnectRound=await start(customKey);failPolls=true;
    await expect(launcher).toContainText('重连',{timeout:12000});
    const chat=await context.newPage();await chat.goto(base+'/chat');
    await chat.getByRole('textbox',{name:'聊天输入'}).fill('广告下班');
    await expect(cards).toHaveCount(0,{timeout:1000});await expect.poll(async()=>(await state()).active).toBe(false);
    results.checks.push({name:'fresh chat safety word during reconnection, local and backend',passed:true});
    await chat.close();failPolls=false;
    await expect(launcher).toContainText('待机中',{timeout:12000});
    await checkRetired(reconnectRound);

    await openDialog();await post('/__test__/mode',{start_before:2});
    await page.locator('#neko-ads-start').click();
    await expect(page.locator('#neko-ads-dialog')).toHaveAttribute('data-phase','starting');
    const pendingChat=await context.newPage();await pendingChat.goto(base+'/chat');
    await pendingChat.getByRole('textbox',{name:'聊天输入'}).fill('广告下班！');
    await page.waitForTimeout(3000);assert.equal((await state()).active,false);await expect(cards).toHaveCount(0);
    results.checks.push({name:'stop arrives before delayed start executes; no backend revival',passed:true});
    await post('/__test__/mode',{start_before:0});
    await pendingChat.close();
    await expect(launcher).toContainText('待机中');await openDialog();
    await post('/__test__/mode',{start_after:4});
    const delayedReply=page.waitForResponse(response=>response.url().endsWith('/action/desktop_command') && response.request().postDataJSON().args.command==='start');
    await page.locator('#neko-ads-start').click();
    await expect(page.locator('#neko-ads-dialog')).toHaveAttribute('data-phase','starting');
    await expect.poll(async()=>(await state()).active).toBe(true);
    const pending=await state();
    assert.equal(pending.shortcut,customKey);
    await post('/__test__/native-exit');
    await expect.poll(async()=>(await state()).active).toBe(false);
    assert.equal((await delayedReply).ok(),true);
    await checkRetired(pending.round_id);
    results.checks.push({name:'custom exit while accepted start acknowledgement is delayed; no revival',passed:true});

    await post('/__test__/mode',{start_after:0});
    for(const exit of ['safety word','custom key']){
      const id=await start(customKey);
      blockHostedUi=true;
      await expect(launcher).toContainText('重连');
      const input=page.getByRole('textbox',{name:'聊天输入'});
      if(exit==='safety word')await input.fill('广告下班');
      else await input.press(customKey.replaceAll('Ctrl','Control'));
      await expect(cards).toHaveCount(0,{timeout:1000});
      assert.equal((await state()).round_id,id,'blocked stop cannot have reached the backend yet');
      blockHostedUi=false;
      await expect.poll(async()=>(await state()).active).toBe(false);
      await expect(launcher).toContainText('待机中',{timeout:12000});
      await checkRetired(id);
      results.checks.push({name:'local '+exit+' clears the desktop while all Hosted UI requests fail; backend retires round after recovery',passed:true});
    }
    assert.deepEqual(results.page_errors,[]);
    const output=process.env.NEKO_ADS_SAFETY_OUT || path.join(root,'tmp/neko-ads-install/v0.2.0-step5');await mkdir(output,{recursive:true});
    await writeFile(path.join(output,'safety-browser.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify(results));
  } finally {
    if(browser)await browser.close();
    if(base)await fetch(base+'/__test__/shutdown',{method:'POST'}).catch(()=>{});
    const ended=new Promise(resolve=>child.once('exit',resolve));
    await Promise.race([ended,new Promise(resolve=>setTimeout(resolve,5000))]);
    if(child.exitCode===null)child.kill();
  }
})().catch(error=>{console.error(error,stderr.slice(-1000));process.exitCode=1;});
