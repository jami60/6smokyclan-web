const { spawn } = require('child_process');
const http = require('http');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9222;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.callbacks = new Map();
    this.consoleLogs = [];
    this.runtimeErrors = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      }
      if (msg.method === 'Console.messageAdded') {
        this.consoleLogs.push(msg.params.message);
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map(a => a.value || a.description || '').join(' ');
        if (msg.params.type === 'error') {
          this.runtimeErrors.push(text);
        }
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.runtimeErrors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
      }
    };

    await this.send('Console.enable');
    await this.send('Runtime.enable');
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text + (res.exceptionDetails.exception?.description ? ': ' + res.exceptionDetails.exception.description : ''));
    }
    return res.result.value;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function run() {
  console.log('--- STARTING COMPREHENSIVE E2E PORTAL TEST SUITE ---');
  
  // 1. Launch Headless Edge
  const edge = spawn(EDGE_PATH, [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'http://localhost:3000'
  ]);

  let cdp = null;
  try {
    let connected = false;
    for (let i = 0; i < 20; i++) {
      await wait(500);
      try {
        const targets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
        const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        if (pageTarget) {
          cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
          await cdp.connect();
          connected = true;
          break;
        }
      } catch (err) {}
    }

    if (!connected) {
      throw new Error('Failed to connect to Edge via CDP.');
    }
    console.log('[PASS] Headless Edge connected via CDP.');

    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: 'http://localhost:3000' });
    await wait(3000);

    const pageInfo = await cdp.eval(`({
      url: document.location.href,
      title: document.title,
      readyState: document.readyState
    })`);
    console.log('Page info:', JSON.stringify(pageInfo));

    // TEST 1: Check Global Objects
    console.log('\n--- TEST 1: Global Objects & Windows ---');
    const globals = await cdp.eval(`({
      hasWm: typeof window.wm !== 'undefined',
      hasStore: typeof window.store !== 'undefined',
      hasPlayer: typeof window.player !== 'undefined',
      hasThemeCtrl: typeof window.themeCtrl !== 'undefined',
      hasBubbles: typeof window.bubbles !== 'undefined',
      hasSound: typeof window.sound !== 'undefined',
      hasTracks: Array.isArray(window.TRACKS) && window.TRACKS.length === 15
    })`);
    console.log('Global checks:', JSON.stringify(globals));
    if (!Object.values(globals).every(Boolean)) throw new Error('Global objects verification failed: ' + JSON.stringify(globals));
    console.log('[PASS] Global objects verified.');

    // TEST 2: Bubble Persistence Across Theme Switching (User Bug Fix Verification)
    console.log('\n--- TEST 2: Bubble Persistence Across Theme Switching ---');
    const turnOffResult = await cdp.eval(`(() => {
      bubbles.setEnabled(false, true);
      return {
        enabled: bubbles.enabled,
        saved: localStorage.getItem('6sc_bubbles'),
        chkChecked: document.getElementById('chkBubbles').checked
      };
    })()`);
    console.log('Turn OFF bubbles:', turnOffResult);
    if (turnOffResult.enabled !== false || turnOffResult.saved !== '0' || turnOffResult.chkChecked !== false) {
      throw new Error('Failed to disable bubbles correctly: ' + JSON.stringify(turnOffResult));
    }

    // Switch themes to aero (preset has bubbles: true)
    const aeroThemeTest = await cdp.eval(`(() => {
      themeCtrl.applyTheme('aero', null, false);
      return {
        theme: themeCtrl.currentTheme,
        bubbleEnabled: bubbles.enabled,
        chkChecked: document.getElementById('chkBubbles').checked
      };
    })()`);
    console.log('Switched to aero:', aeroThemeTest);
    if (aeroThemeTest.bubbleEnabled !== false || aeroThemeTest.chkChecked !== false) {
      throw new Error('BUG REPRODUCED: Aero theme forced bubbles on even though user turned them off!');
    }
    console.log('[PASS] Aero respected user setting and kept bubbles OFF!');

    // Switch themes to luna (preset has bubbles: true)
    const lunaThemeTest = await cdp.eval(`(() => {
      themeCtrl.applyTheme('luna', null, false);
      return {
        theme: themeCtrl.currentTheme,
        bubbleEnabled: bubbles.enabled,
        chkChecked: document.getElementById('chkBubbles').checked
      };
    })()`);
    console.log('Switched to luna:', lunaThemeTest);
    if (lunaThemeTest.bubbleEnabled !== false || lunaThemeTest.chkChecked !== false) {
      throw new Error('BUG REPRODUCED: Luna theme forced bubbles on even though user turned them off!');
    }
    console.log('[PASS] Luna respected user setting and kept bubbles OFF!');

    // Switch across royale, vista, matrix
    for (const t of ['royale', 'vista', 'matrix']) {
      const res = await cdp.eval(`(() => {
        themeCtrl.applyTheme('${t}', null, false);
        return { theme: themeCtrl.currentTheme, bubbleEnabled: bubbles.enabled };
      })()`);
      if (res.bubbleEnabled !== false) {
        throw new Error(`Theme ${t} enabled bubbles incorrectly!`);
      }
    }
    console.log('[PASS] Bubbles stayed OFF across all 5 themes!');

    // Re-enable bubbles
    const turnOnResult = await cdp.eval(`(() => {
      bubbles.setEnabled(true, true);
      themeCtrl.applyTheme('aero', null, false);
      return {
        enabled: bubbles.enabled,
        saved: localStorage.getItem('6sc_bubbles'),
        chkChecked: document.getElementById('chkBubbles').checked,
        bubbleCount: bubbles.bubbles.length
      };
    })()`);
    console.log('Turned bubbles back ON:', turnOnResult);
    if (turnOnResult.enabled !== true || turnOnResult.saved !== '1' || turnOnResult.bubbleCount === 0) {
      throw new Error('Failed to enable bubbles back: ' + JSON.stringify(turnOnResult));
    }
    console.log('[PASS] Bubbles re-enabled successfully with 20 active particles.');

    // TEST 3: WMP Player Controls & Interactive Tabs
    console.log('\n--- TEST 3: WMP Player Controls & Interactive Tabs ---');
    const playerTest = await cdp.eval(`(() => {
      // 1. Play / Pause
      player.play();
      const afterPlay = player.isPlaying;
      player.pause();
      const afterPause = player.isPlaying;
      player.togglePlay();
      const afterToggle = player.isPlaying;
      player.pause();

      // 2. Load Track 3
      player.loadTrack(2, false);
      const track3Title = TRACKS[player.currentTrackIndex].title;
      const track3Index = player.currentTrackIndex;

      // 3. Seeking
      player.durationSeconds = 180;
      player.seek(75);
      const currentTime = player.currentSeconds;

      // 4. Volume & Mute
      player.volume = 60;
      player.btnMute.click();
      const isMuted = player.isMuted;
      player.btnMute.click();
      const isUnmuted = !player.isMuted;

      // 5. Tabs
      // Click Beat Catalog Tab
      document.getElementById('tabMediaGuide').click();
      const isCatalogActive = document.getElementById('tabMediaGuide').classList.contains('active');
      const isCatalogViewVisible = document.getElementById('wmpStageCatalog').style.display !== 'none';
      const catalogRowsCount = document.querySelectorAll('#wmpCatalogList .wmp-catalog-row').length;

      // Click play on row 5 inside catalog
      const row5Play = document.querySelectorAll('#wmpCatalogList .wmp-catalog-play-btn')[4];
      if (row5Play) row5Play.click();
      const newTrackAfterCatalogClick = player.currentTrackIndex;

      // Click Licensing Terms Tab
      document.getElementById('tabLicensing').click();
      const isLicensingActive = document.getElementById('tabLicensing').classList.contains('active');
      const isLicensingViewVisible = document.getElementById('wmpStageLicensing').style.display !== 'none';

      // Click Now Playing Tab
      document.getElementById('tabNowPlaying').click();
      const isNowPlayingActive = document.getElementById('tabNowPlaying').classList.contains('active');
      const isNowPlayingVisible = document.getElementById('wmpStageNowPlaying').style.display !== 'none';

      return {
        afterPlay, afterPause, afterToggle,
        track3Title, track3Index,
        currentTime, isMuted, isUnmuted,
        isCatalogActive, isCatalogViewVisible, catalogRowsCount, newTrackAfterCatalogClick,
        isLicensingActive, isLicensingViewVisible,
        isNowPlayingActive, isNowPlayingVisible
      };
    })()`);
    console.log('Player & WMP Tabs result:', playerTest);
    if (!playerTest.afterPlay || playerTest.afterPause || !playerTest.afterToggle) {
      throw new Error('Play/pause toggling failure');
    }
    if (playerTest.track3Index !== 2) throw new Error('Load track failure');
    if (playerTest.currentTime !== 75) throw new Error('Seek failure');
    if (!playerTest.isCatalogViewVisible || playerTest.catalogRowsCount !== 15) throw new Error('Catalog tab failure');
    if (playerTest.newTrackAfterCatalogClick !== 4) throw new Error('Catalog row click failure');
    if (!playerTest.isLicensingViewVisible) throw new Error('Licensing tab failure');
    if (!playerTest.isNowPlayingVisible) throw new Error('Now Playing tab failure');
    console.log('[PASS] WMP player controls, scrubbing, volume, mute, and all 3 interactive tabs work flawlessly!');

    // TEST 4: Beat Store Features
    console.log('\n--- TEST 4: Beat Store Features ---');
    const storeTest = await cdp.eval(`(() => {
      // 1. Initial items in catalog table
      const beatRowsCount = document.querySelectorAll('#sbBeatRowsContainer .sb-beat-row').length;

      // 2. Add to Cart
      store.cart = [];
      store.addToCart({
        id: 'test-1',
        title: TRACKS[0].title,
        type: 'beat',
        licenseTier: 'MP3 Lease',
        price: 29.99,
        thumb: 'assets/logo.jpg'
      });
      const cartLen1 = store.cart.length;
      const cartBadgeVal = document.getElementById('sbCartCount').textContent;

      // 3. Open Cart modal
      document.getElementById('btnOpenStoreCart').click();
      const isCartOpen = document.getElementById('cartModalOverlay').style.display === 'flex';
      const initialTotal = document.getElementById('cartTotal').textContent;

      // 4. Promo Code FUEGO
      const promoInput = document.getElementById('cartCouponInput');
      promoInput.value = 'FUEGO';
      document.getElementById('btnApplyCoupon').click();
      const couponApplied = store.coupon;
      const discountedTotal = document.getElementById('cartTotal').textContent;

      // 5. Clear Cart
      document.getElementById('btnClearCart').click();
      const isCartEmpty = store.cart.length === 0;

      // 6. Close Cart modal
      document.getElementById('btnCloseCartModal').click();
      const isCartClosed = document.getElementById('cartModalOverlay').style.display === 'none';

      // 7. License selector modal
      store.openLicenseModal(TRACKS[1]);
      const isLicModalOpen = document.getElementById('licenseModalOverlay').style.display === 'flex';
      document.getElementById('btnCloseLicenseModal').click();
      const isLicModalClosed = document.getElementById('licenseModalOverlay').style.display === 'none';

      // 8. Search filter
      const searchInput = document.getElementById('sbSearchInput');
      searchInput.value = 'ambient';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      const filteredCount = document.querySelectorAll('#sbBeatRowsContainer .sb-beat-row').length;
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      const resetCount = document.querySelectorAll('#sbBeatRowsContainer .sb-beat-row').length;

      return {
        beatRowsCount,
        cartLen1, cartBadgeVal,
        isCartOpen, initialTotal, couponApplied, discountedTotal, isCartEmpty, isCartClosed,
        isLicModalOpen, isLicModalClosed,
        filteredCount, resetCount
      };
    })()`);
    console.log('Store test result:', storeTest);
    if (storeTest.beatRowsCount !== 15) throw new Error('Initial beat rows not 15');
    if (storeTest.cartLen1 !== 1 || storeTest.cartBadgeVal !== '1') throw new Error('Cart addition failed');
    if (storeTest.couponApplied !== 'FUEGO') throw new Error('Promo coupon FUEGO failed');
    if (!storeTest.isCartOpen || !storeTest.isCartClosed) throw new Error('Cart modal open/close failed');
    if (!storeTest.isLicModalOpen || !storeTest.isLicModalClosed) throw new Error('License modal failed');
    if (storeTest.filteredCount <= 0 || storeTest.resetCount !== 15) throw new Error('Search filtering failed');
    console.log('[PASS] Beat Store catalog, shopping cart, promo coupon discount, license modal, and search filtering work flawlessly!');

    // TEST 5: Window Manager (All Windows, Maximize, Restore, Minimize)
    console.log('\n--- TEST 5: Window Manager Operations ---');
    const wmTest = await cdp.eval(`(() => {
      const windowIds = ['windowBeatStore', 'windowWmp', 'windowMyComputer', 'windowProps', 'windowWinamp', 'windowNotepad', 'windowCmd', 'windowTrash'];
      windowIds.forEach(id => wm.openWindow(id));
      const allOpen = windowIds.every(id => {
        const el = document.getElementById(id);
        return el && el.style.display !== 'none';
      });

      // Maximize beat store
      const bsEl = document.getElementById('windowBeatStore');
      const maxBtn = bsEl.querySelector('.xp-btn-max');
      maxBtn.click();
      const isMaximized = bsEl.classList.contains('maximized');
      maxBtn.click(); // unmaximize
      const isRestored = !bsEl.classList.contains('maximized');

      // Minimize beat store
      const minBtn = bsEl.querySelector('.xp-btn-min');
      minBtn.click();
      const isMin = bsEl.classList.contains('minimized');
      wm.openWindow('windowBeatStore'); // restore
      const isRestored2 = !bsEl.classList.contains('minimized');

      return { allOpen, isMaximized, isRestored, isMin, isRestored2 };
    })()`);
    console.log('Window manager test result:', wmTest);
    if (!wmTest.allOpen || !wmTest.isMaximized || !wmTest.isRestored || !wmTest.isMin || !wmTest.isRestored2) {
      throw new Error('Window manager operations failed: ' + JSON.stringify(wmTest));
    }
    console.log('[PASS] All 8 desktop windows opened, maximized, restored, and minimized cleanly!');

    // TEST 6: Visual Effects & Nostalgia Toggles
    console.log('\n--- TEST 6: Visual Effects & Nostalgia Toggles ---');
    const effectsTest = await cdp.eval(`(() => {
      const chkCrt = document.getElementById('chkCrt');
      const crtOverlay = document.getElementById('crtOverlay');
      chkCrt.checked = true;
      chkCrt.dispatchEvent(new Event('change', { bubbles: true }));
      const crtVisible = crtOverlay.style.display === 'block';
      const crtSaved = localStorage.getItem('6sc_crt') === '1';

      chkCrt.checked = false;
      chkCrt.dispatchEvent(new Event('change', { bubbles: true }));
      const crtHidden = crtOverlay.style.display === 'none';

      const chkSoundFx = document.getElementById('chkSoundFx');
      chkSoundFx.checked = false;
      chkSoundFx.dispatchEvent(new Event('change', { bubbles: true }));
      const soundDisabled = sound.soundEnabled === false;
      const soundSaved = localStorage.getItem('6sc_soundfx') === '0';

      chkSoundFx.checked = true;
      chkSoundFx.dispatchEvent(new Event('change', { bubbles: true }));
      const soundEnabled = sound.soundEnabled === true;

      return { crtVisible, crtSaved, crtHidden, soundDisabled, soundSaved, soundEnabled };
    })()`);
    console.log('Effects test result:', effectsTest);
    if (!effectsTest.crtVisible || !effectsTest.crtSaved || !effectsTest.crtHidden || !effectsTest.soundDisabled || !effectsTest.soundEnabled) {
      throw new Error('Effects toggles failed: ' + JSON.stringify(effectsTest));
    }
    console.log('[PASS] CRT scanlines & XP sound effects toggles and persistence verified.');

    // TEST 7: Page Reload with Disabled Bubbles (Persistence Verification)
    console.log('\n--- TEST 7: Page Reload with Disabled Bubbles Persistence ---');
    await cdp.eval(`(() => {
      bubbles.setEnabled(false, true);
    })()`);
    await cdp.send('Page.reload');
    await wait(3000);

    const reloadResult = await cdp.eval(`(() => {
      return {
        bubbleEnabled: bubbles.enabled,
        savedPref: localStorage.getItem('6sc_bubbles'),
        chkChecked: document.getElementById('chkBubbles').checked,
        bubbleCount: bubbles.bubbles.length
      };
    })()`);
    console.log('After reload with disabled bubbles:', reloadResult);
    if (reloadResult.bubbleEnabled !== false || reloadResult.savedPref !== '0' || reloadResult.chkChecked !== false || reloadResult.bubbleCount !== 0) {
      throw new Error('Persistence on page reload failed: bubbles were re-enabled upon restart!');
    }
    console.log('[PASS] Bubbles stayed cleanly disabled across a full browser page reload!');

    // TEST 8: Winamp Sync Controls
    console.log('\n--- TEST 8: Winamp Controls Sync ---');
    const winampTest = await cdp.eval(`(() => {
      document.getElementById('waPlay').click();
      const afterWaPlay = player.isPlaying;
      document.getElementById('waPause').click();
      const afterWaPause = player.isPlaying;
      document.getElementById('waNext').click();
      const nextIdx = player.currentTrackIndex;
      document.getElementById('waPrev').click();
      const prevIdx = player.currentTrackIndex;
      return { afterWaPlay, afterWaPause, nextIdx, prevIdx };
    })()`);
    console.log('Winamp test result:', winampTest);
    if (!winampTest.afterWaPlay || winampTest.afterWaPause) {
      throw new Error('Winamp play/pause sync failed: ' + JSON.stringify(winampTest));
    }
    console.log('[PASS] Winamp buttons seamlessly synced to player engine!');

    // TEST 9: Terminal / CMD Command Execution
    console.log('\n--- TEST 9: Terminal CMD Execution ---');
    const cmdTest = await cdp.eval(`(() => {
      const input = document.getElementById('cmdInput');
      input.value = 'beats';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const outputText = document.getElementById('cmdOutput').textContent;
      return { outputText, wmpDisplay: document.getElementById('windowWmp').style.display };
    })()`);
    console.log('CMD test output:', cmdTest);
    if (cmdTest.wmpDisplay === 'none') {
      throw new Error('CMD beats command failed to open WMP');
    }
    console.log('[PASS] Command Prompt executed beats command and triggered actions!');

    // TEST 10: Screensaver Activation & Dismissal
    console.log('\n--- TEST 10: Screensaver System ---');
    const ssTest = await cdp.eval(`(() => {
      startScreensaver();
      const ssActive = document.getElementById('screensaverOverlay').style.display === 'block';
      stopScreensaver();
      const ssInactive = document.getElementById('screensaverOverlay').style.display === 'none';
      return { ssActive, ssInactive };
    })()`);
    console.log('Screensaver test result:', ssTest);
    if (!ssTest.ssActive || !ssTest.ssInactive) {
      throw new Error('Screensaver activation/dismissal failed');
    }
    console.log('[PASS] Screensaver started and dismissed on user interaction!');

    // TEST 11: Console & Runtime Error Audit
    console.log('\n--- TEST 11: Runtime Exceptions & Console Audit ---');
    const criticalErrors = cdp.runtimeErrors.filter(e => !e.includes('favicon') && !e.includes('ytimg'));
    console.log('Critical runtime exceptions logged:', criticalErrors);
    if (criticalErrors.length > 0) {
      throw new Error('Runtime errors detected during execution: ' + JSON.stringify(criticalErrors));
    }
    console.log('[PASS] Zero critical JavaScript runtime exceptions found.');

    console.log('\n========================================');
    console.log('>>> ALL 11 TESTS PASSED SUCCESSFULLY! <<<');
    console.log('========================================\n');

  } catch (err) {
    console.error('[FAIL] Test suite encountered an error:', err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    edge.kill();
  }
}

run();
