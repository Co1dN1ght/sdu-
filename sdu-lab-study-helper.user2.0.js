// ==UserScript==
// @name         山大实验室安全学习中心助手
// @namespace    https://sysaq.sdu.edu.cn/lab-study-front/
// @version      1.0.2
// @description  适配 sysaq.sdu.edu.cn/lab-study-front（Vue2 + 阿里云 Aliplayer）：自动连播下一课时 + 自动关弹窗 + 倍速/静音 + 学习心跳守护 + PPT自动翻页
// @author       you
// @icon         https://sysaq.sdu.edu.cn/lab-study-front/favicon.ico
// @match        https://sysaq.sdu.edu.cn/lab-study-front/*
// @match        http://sysaq.sdu.edu.cn/lab-study-front/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * 说明（基于 2026-09 线上包 chunk-278ff10c.js 逆向）：
 *   - 播放页组件名 coursePlayer，根元素 .player_bg，播放器挂载点 #J_prismPlayer
 *   - 播放器实例：vm.player            （window.Aliplayer，方法是 setSpeed/seek/getCurrentTime…）
 *   - 课程数据：  vm.formData.chapterList[].periodList[]  每项 {id, periodName, resourceLength, periodType}
 *                 vm.formData.videoProcess[]               每项 {periodId, process, finishPlay}
 *   - 学习会话：  POST /api/video_study/{periodId}          -> vm.stauyData {studyId}
 *                 POST /api/update_video_process/{studyId}  <- 进度(=当前播放秒数)，用户暂停/离开时
 *                 POST /api/video_study_upload/{studyId}    <- 心跳，每 config.uploadTime(15) 秒一次
 *   - 平台弹窗：
 *       1) 播完    $Modal.confirm「视频已经播放完毕，请选择其他视频!」
 *       2) 续播    $Modal.confirm「视频已经学习完，是否重新学习!」
 *       3) 防挂机  $Modal.confirm「你已经在此页面 5 分钟了, 15 秒后自动退出，是否继续!」
 *       DOM 均为 iView Modal.confirm：.ivu-modal-confirm-body / .ivu-modal-confirm-footer button.ivu-btn-primary
 */

(function () {
  'use strict';

  // ============================================================
  // 1. SDU.config — 常量 & 选择器
  // ============================================================
  var SDU = {};

  SDU.config = {
    DEBUG: true,
    VERSION: '1.0.2',

    // —— 定时器间隔 (ms) ——
    INTERVAL: {
      AUTONEXT: 1500,   // 检测「本课时是否已播完」
      POPUP: 500,       // 扫描并关闭弹窗
      SPEED: 2500,      // 倍速重设
      GUARD: 5000,      // 学习心跳守护
      ACTIVITY: 60000,  // 模拟鼠标活动（防挂机）
      PDF: 8000         // PPT/PDF 自动翻页
    },

    // —— 反重复阈值 ——
    SWITCH_COOLDOWN: 4500,   // 两次切课时之间的最小间隔
    FINISH_DEBOUNCE: 2,      // 连续 N 次判定为「已播完」才执行切换
    MODAL_COOLDOWN: 1200,    // 同一个弹窗最小重复点击间隔

    // —— 弹窗识别规则（只处理学习页，绝不碰考试页）——
    POPUP_RULES: [
      { key: 'ended',   re: /播放完毕|已经播放完|请选择其他视频/, act: 'primary', then: 'advance' },
      { key: 'resume',  re: /是否重新学习|已经学习完/,            act: 'auto',    then: 'advance-if-done' },
      { key: 'idle',    re: /自动退出|分钟了|未操作|是否继续/,     act: 'primary', then: null },
      { key: 'upload',  re: /学习进度上传失败|请重新载入/,         act: 'primary', then: 'restart' }
    ],

    // —— 模拟活动的事件目标 ——
    ACTIVITY_TARGETS: [
      'body',
      '.player_bg',
      '.palyer_left',
      '.ivu-layout-content',
      '.content'
    ],

    // —— 选择器 ——
    SEL: {
      PLAYER_ROOT: '.player_bg',
      PLAYER_BOX: '#J_prismPlayer',
      VIDEO: '#J_prismPlayer video',
      MODAL_WRAP: '.ivu-modal-wrap',
      MODAL_BODY: '.ivu-modal-confirm-body, .ivu-modal-body',
      MODAL_FOOTER: '.ivu-modal-confirm-footer, .ivu-modal-footer',
      MSG_NOTICE: '.ivu-message-notice'
    }
  };

  // ============================================================
  // 2. SDU.logger — 分级日志
  // ============================================================
  SDU.logger = (function () {
    var LEVEL = { NONE: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4 };
    var _level = SDU.config.DEBUG ? 4 : 0;

    function ts() {
      var d = new Date();
      return '[' + ('0' + d.getHours()).slice(-2) + ':' +
             ('0' + d.getMinutes()).slice(-2) + ':' +
             ('0' + d.getSeconds()).slice(-2) + ']';
    }

    function canLog(lv) { return _level >= lv; }

    return {
      LEVEL: LEVEL,
      getLevel: function () { return _level; },
      setLevel: function (lv) { _level = lv; },
      error: function (ns, msg) { if (canLog(1)) console.error(ts() + ' [SDU:' + ns + ':ERR] ' + msg); },
      warn:  function (ns, msg) { if (canLog(2)) console.warn (ts() + ' [SDU:' + ns + ':WRN] ' + msg); },
      info:  function (ns, msg) { if (canLog(3)) console.info (ts() + ' [SDU:' + ns + ':INF] ' + msg); },
      debug: function (ns, msg) { if (canLog(4)) console.log  (ts() + ' [SDU:' + ns + ':DBG] ' + msg); }
    };
  })();

  // ============================================================
  // 3. SDU.store — 中心化状态（localStorage 持久化）
  // ============================================================
  SDU.store = (function () {
    var KEY = 'sdu_sysaq_helper_cfg_v1';
    var SAVE_DELAY = 100;
    var _timer = null;

    var _state = {
      autoNext:      true,   // 自动连播下一课时
      autoClose:     true,   // 自动关闭学习页弹窗
      keepPlay:      true,   // 保持播放（被暂停自动续播）
      mute:          true,   // 静音（保证自动播放不被浏览器拦截）
      speed:         false,  // 倍速
      speedRate:     2.0,
      skipEnd:       false,  // 秒过：直接跳到结尾
      pdfAuto:       false,  // PPT/PDF 自动翻页
      hbGuard:       true,   // 学习心跳守护
      fakeActive:    true,   // 模拟鼠标活动（防挂机弹窗）
      brushMode:     false,  // 一键全开
      hasShownGuide: false
    };

    function _save() {
      try { localStorage.setItem(KEY, JSON.stringify(_state)); } catch (e) { /* ignore */ }
    }

    function _saveDebounced() {
      if (_timer) clearTimeout(_timer);
      _timer = setTimeout(_save, SAVE_DELAY);
    }

    return {
      init: function () {
        try {
          var raw = localStorage.getItem(KEY);
          if (raw) {
            var saved = JSON.parse(raw);
            for (var k in saved) {
              if (saved.hasOwnProperty(k) && _state.hasOwnProperty(k)) _state[k] = saved[k];
            }
          }
        } catch (e) { /* ignore */ }
      },
      get: function (key) { return _state[key]; },
      set: function (key, value) {
        if (!_state.hasOwnProperty(key)) return;
        _state[key] = value;
        _saveDebounced();
      },
      all: function () { return _state; }
    };
  })();

  // ============================================================
  // 4. SDU.core — Vue 实例定位 / 课程数据 / 完成判定
  // ============================================================
  SDU.core = (function () {
    var _done = {};        // 本次会话内已完成的 periodId
    var _vmCache = null;
    var _vmCacheTime = 0;

    // ---------- Vue 实例 ----------
    function _bfsByName(root, name, maxDepth) {
      if (!root) return null;
      var queue = [{ vm: root, d: 0 }];
      while (queue.length) {
        var it = queue.shift();
        var vm = it.vm;
        if (!vm) continue;
        if (vm.$options && vm.$options.name === name) return vm;
        if (it.d >= maxDepth) continue;
        var ch = vm.$children || [];
        for (var i = 0; i < ch.length; i++) queue.push({ vm: ch[i], d: it.d + 1 });
      }
      return null;
    }

    function _rootVm() {
      var el = document.getElementById('chingo');
      var g = 0;
      while (el && g++ < 8) {
        if (el.__vue__) return el.__vue__;
        el = el.parentElement;
      }
      // 兜底：全文档搜索带 __vue__ 的元素
      var all = document.querySelectorAll('div');
      for (var i = 0; i < all.length && i < 400; i++) {
        if (all[i].__vue__) return all[i].__vue__;
      }
      return null;
    }

    // 取 coursePlayer 组件实例（带 1s 缓存）
    function getVm() {
      var now = Date.now();
      if (_vmCache && now - _vmCacheTime < 1000 && _vmCache._isDestroyed !== true) return _vmCache;

      var vm = null;

      // 方式1：从播放器根 DOM 向上找 __vue__
      var node = document.querySelector(SDU.config.SEL.PLAYER_ROOT) ||
                 document.querySelector(SDU.config.SEL.PLAYER_BOX);
      var g = 0;
      while (node && g++ < 25) {
        var v = node.__vue__;
        if (v && v.$options && v.$options.name === 'coursePlayer') { vm = v; break; }
        node = node.parentElement;
      }

      // 方式2：从根实例 BFS
      if (!vm) vm = _bfsByName(_rootVm(), 'coursePlayer', 12);

      // 方式3：任意带 formData.chapterList 的组件
      if (!vm) {
        node = document.querySelector(SDU.config.SEL.PLAYER_ROOT);
        g = 0;
        while (node && g++ < 25) {
          var v2 = node.__vue__;
          if (v2 && v2.formData && v2.formData.chapterList) { vm = v2; break; }
          node = node.parentElement;
        }
      }

      if (vm) { _vmCache = vm; _vmCacheTime = now; }
      return vm;
    }

    function getPlayer() {
      var vm = getVm();
      return (vm && vm.player) ? vm.player : null;
    }

    function getVideoEl() {
      return document.querySelector(SDU.config.SEL.VIDEO) || document.querySelector('video');
    }

    // ---------- 课程数据 ----------
    // 拉平成 [{id, name, length, chapterIndex, classIndex, periodType}]
    function flatten(vm) {
      var out = [];
      var chs = (vm && vm.formData && vm.formData.chapterList) || [];
      for (var i = 0; i < chs.length; i++) {
        var ps = chs[i].periodList || [];
        for (var j = 0; j < ps.length; j++) {
          out.push({
            id: ps[j].id,
            name: ps[j].periodName,
            length: ps[j].resourceLength,
            periodType: ps[j].periodType,
            chapterIndex: i,
            classIndex: j,
            item: ps[j]
          });
        }
      }
      return out;
    }

    // 该课时是否已完成（本次会话标记 或 服务端 finishPlay）
    function isFinished(vm, id) {
      if (_done[String(id)]) return true;
      var vp = (vm && vm.formData && vm.formData.videoProcess) || [];
      for (var i = 0; i < vp.length; i++) {
        if (String(vp[i].periodId) === String(id)) return !!vp[i].finishPlay;
      }
      return false;
    }

    function markDone(id) {
      if (id == null) return;
      if (!_done[String(id)]) SDU.logger.debug('CORE', '标记完成 periodId=' + id);
      _done[String(id)] = 1;
    }

    function currentIndex(vm) {
      var list = flatten(vm);
      var cur = String(vm && vm.periodId);
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === cur) return i;
      }
      return -1;
    }

    // 下一个未完成课时（向后找一圈）
    function findNext(vm) {
      var list = flatten(vm);
      if (!list.length) return null;
      var cur = currentIndex(vm);
      for (var k = 1; k <= list.length; k++) {
        var idx = (cur + k) % list.length;
        if (idx === cur && list.length > 1) break;
        if (!isFinished(vm, list[idx].id)) return list[idx];
      }
      return null;
    }

    function doneCount(vm) {
      var list = flatten(vm), n = 0;
      for (var i = 0; i < list.length; i++) if (isFinished(vm, list[i].id)) n++;
      return n;
    }

    // ---------- 播放状态 ----------
    // 本课时是否已经播完（含 PDF 课时）
    function isCurrentFinished(vm) {
      if (!vm) return false;
      if (vm.periodType === 3) {
        return !!(vm.pageCount > 0 && vm.currentPage >= vm.pageCount);
      }
      var p = vm.player;
      if (!p || typeof p.getStatus !== 'function') return false;
      var status = '';
      try { status = p.getStatus() || ''; } catch (e) { /* ignore */ }
      if (status === 'ended') return true;
      var d = 0, c = 0;
      try { d = p.getDuration() || 0; c = p.getCurrentTime() || 0; } catch (e) { /* ignore */ }
      return !!(d > 0 && c >= d - 0.5);
    }

    return {
      getVm: getVm,
      getPlayer: getPlayer,
      getVideoEl: getVideoEl,
      flatten: flatten,
      isFinished: isFinished,
      markDone: markDone,
      currentIndex: currentIndex,
      findNext: findNext,
      doneCount: doneCount,
      isCurrentFinished: isCurrentFinished,
      rootVm: _rootVm
    };
  })();

  // ============================================================
  // 5. SDU.route — SPA 路由监听（history 模式）
  // ============================================================
  SDU.route = (function () {
    var _listeners = [];
    var _lastHref = '';
    var _timer = null;

    function isPlayer() {
      if (/\/coursePlayer/i.test(location.pathname)) return true;
      // 兜底：路径被改写但学习页已渲染
      return !!document.querySelector(SDU.config.SEL.PLAYER_ROOT);
    }

    function fire() {
      for (var i = 0; i < _listeners.length; i++) {
        try { _listeners[i](location.href); } catch (e) { /* ignore */ }
      }
    }

    function check() {
      if (location.href !== _lastHref) {
        _lastHref = location.href;
        SDU.logger.debug('ROUTE', '-> ' + location.pathname + location.search);
        fire();
      }
    }

    var _patched = false;

    function init() {
      // 用闭包标记防重复 patch，不要往 history 上挂自定义属性
      // （history.__sdu_patched 之类是页面脚本可探测的特征）
      if (typeof history !== 'undefined' && history.pushState && !_patched) {
        _patched = true;
        var op = history.pushState, or = history.replaceState;
        history.pushState = function () { var r = op.apply(this, arguments); setTimeout(check, 0); return r; };
        history.replaceState = function () { var r = or.apply(this, arguments); setTimeout(check, 0); return r; };
        window.addEventListener('popstate', function () { setTimeout(check, 0); });
      }
      _lastHref = location.href;
      if (!_timer) _timer = setInterval(check, 800);
    }

    return { init: init, isPlayer: isPlayer, onChange: function (fn) { _listeners.push(fn); }, check: check };
  })();

  // ============================================================
  // 6. SDU.popup — 自动关弹窗
  // ============================================================
  SDU.popup = (function () {
    var _clicked = [];   // [{el, t}]

    function _visible(el) {
      if (!el) return false;
      if (el.offsetParent !== null) return true;
      // fixed 定位的弹窗 offsetParent 可能为 null
      var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
      return !!(cs && cs.display !== 'none' && cs.visibility !== 'hidden');
    }

    function _click(el) {
      if (!el) return false;
      try {
        var r = el.getBoundingClientRect();
        var opt = {
          bubbles: true, cancelable: true, view: window, button: 0,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
        };
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
          var Ev = (t.indexOf('pointer') === 0 && window.PointerEvent) ? window.PointerEvent : window.MouseEvent;
          try { el.dispatchEvent(new Ev(t, opt)); } catch (e) { /* ignore */ }
        });
      } catch (e) {
        try { el.click(); } catch (e2) { /* ignore */ }
      }
      return true;
    }

    function _recentlyClicked(el) {
      var now = Date.now();
      _clicked = _clicked.filter(function (x) { return now - x.t < SDU.config.MODAL_COOLDOWN; });
      for (var i = 0; i < _clicked.length; i++) if (_clicked[i].el === el) return true;
      return false;
    }

    function _mark(el) { _clicked.push({ el: el, t: Date.now() }); }

    // 是否存在「正在拦截播放」的弹窗（供 keepPlay 判断）
    function isBlockingModalOpen() {
      var wraps = document.querySelectorAll(SDU.config.SEL.MODAL_WRAP);
      for (var i = 0; i < wraps.length; i++) {
        if (!_visible(wraps[i])) continue;
        var txt = (wraps[i].textContent || '');
        if (/播放完毕|是否重新学习|自动退出|学习进度上传失败/.test(txt)) return true;
      }
      return false;
    }

    function _ruleFor(text) {
      for (var i = 0; i < SDU.config.POPUP_RULES.length; i++) {
        if (SDU.config.POPUP_RULES[i].re.test(text)) return SDU.config.POPUP_RULES[i];
      }
      return null;
    }

    function _handle(wrap) {
      if (!_visible(wrap)) return;
      var footer = wrap.querySelector(SDU.config.SEL.MODAL_FOOTER);
      if (!footer) return;
      var btns = footer.querySelectorAll('button');
      if (!btns.length) return;

      var bodyEl = wrap.querySelector(SDU.config.SEL.MODAL_BODY);
      var text = ((bodyEl ? bodyEl.textContent : '') || wrap.textContent || '').trim();
      var rule = _ruleFor(text);
      if (!rule) return;

      var primary = footer.querySelector('button.ivu-btn-primary') || btns[btns.length - 1];
      var cancel = footer.querySelector('button:not(.ivu-btn-primary)') || btns[0];

      var target = primary;
      if (rule.act === 'auto') {
        // 「是否重新学习」：以服务端 finishPlay 为准（播放器此时往往还没加载完，
        // 用实时播放状态判断会在「重进已学完课程」时误点「重新学习」）
        var vm = SDU.core.getVm();
        target = (vm && SDU.core.isFinished(vm, vm.periodId)) ? cancel : primary;
      }

      if (!target || _recentlyClicked(target)) return;
      _mark(target);
      _click(target);
      SDU.logger.info('POPUP', '已处理「' + text.slice(0, 26) + '…」-> ' +
        (target === primary ? '主按钮' : '取消'));

      var then = rule.then;
      if (then === 'advance' || then === 'advance-if-done') {
        // advance-if-done：同样以服务端 finishPlay 为准，确认已完成才切换
        var vmAdv = SDU.core.getVm();
        var finishedNow = vmAdv ? SDU.core.isFinished(vmAdv, vmAdv.periodId) : false;
        if (then === 'advance' || finishedNow) {
          setTimeout(function () { SDU.autonext.advance('popup:' + rule.key); }, 400);
        }
      } else if (then === 'restart') {
        setTimeout(function () { SDU.guard.restart(true); }, 400);
      }
    }

    function scan() {
      // 只在学习页处理弹窗，避免误触考试/练习页
      if (!SDU.route.isPlayer()) return;
      var wraps = document.querySelectorAll(SDU.config.SEL.MODAL_WRAP);
      for (var i = 0; i < wraps.length; i++) _handle(wraps[i]);

      // 页面内的自定义确认框（部分页面自绘 ivu-modal-confirm）
      var confs = document.querySelectorAll('.ivu-modal-confirm');
      for (var j = 0; j < confs.length; j++) {
        var w = confs[j].closest ? confs[j].closest('.ivu-modal-wrap') : null;
        if (w) _handle(w);
      }

      // Toast：学习进度上传失败 -> 重新拉起学习会话
      var msgs = document.querySelectorAll(SDU.config.SEL.MSG_NOTICE);
      for (var k = 0; k < msgs.length; k++) {
        var t = msgs[k].textContent || '';
        if (/学习进度上传失败/.test(t) && !_recentlyClicked(msgs[k])) {
          _mark(msgs[k]);
          SDU.logger.warn('POPUP', '捕获到「学习进度上传失败」，尝试恢复会话');
          SDU.guard.restart(true);
        }
      }
    }

    return { scan: scan, isBlockingModalOpen: isBlockingModalOpen, click: _click, visible: _visible };
  })();

  // ============================================================
  // 7. SDU.autonext — 自动连播 / 秒过
  // ============================================================
  SDU.autonext = (function () {
    var _finId = null, _finCount = 0;
    var _lastSwitch = 0;
    var _lastPeriodId = null;
    var _allDoneNotified = false;

    function _resetOnPeriodChange(vm) {
      var pid = String(vm.periodId);
      if (pid !== _lastPeriodId) {
        SDU.logger.debug('NEXT', '当前课时 -> ' + pid);
        _lastPeriodId = pid;
        _finId = null;
        _finCount = 0;
        _allDoneNotified = false;
        SDU.gui.syncStatus();
      }
    }

    // 切到下一个未完成课时
    function advance(reason) {
      var now = Date.now();
      if (now - _lastSwitch < SDU.config.SWITCH_COOLDOWN) return false;

      var vm = SDU.core.getVm();
      if (!vm) return false;

      var next = SDU.core.findNext(vm);
      if (!next) {
        if (!_allDoneNotified) {
          _allDoneNotified = true;
          SDU.logger.info('NEXT', '本课程所有课时均已完成');
          SDU.gui.notify('全部课时已完成 🎉');
        }
        return false;
      }

      _lastSwitch = now;
      SDU.logger.info('NEXT', '切换课时 -> ' + next.name + '（' + reason + '）');
      try {
        vm.choosePlayer(next.id);
      } catch (e) {
        SDU.logger.error('NEXT', 'choosePlayer 失败: ' + e.message);
        return false;
      }
      SDU.gui.syncStatus();
      return true;
    }

    function tick() {
      var vm = SDU.core.getVm();
      if (!vm) return;
      _resetOnPeriodChange(vm);

      var cur = String(vm.periodId);

      // 秒过：直接定位到结尾
      if (SDU.store.get('skipEnd') && vm.periodType !== 3) {
        var p = SDU.core.getPlayer();
        if (p && typeof p.getDuration === 'function') {
          var d = 0, c = 0;
          try { d = p.getDuration() || 0; c = p.getCurrentTime() || 0; } catch (e) { /* ignore */ }
          if (d > 5 && c < d - 5 && !SDU.popup.isBlockingModalOpen()) {
            try { p.seek(Math.max(0, d - 1)); SDU.logger.info('NEXT', '秒过 -> ' + Math.round(d)); } catch (e) { /* ignore */ }
          }
        }
      }

      if (!SDU.store.get('autoNext')) return;
      if (!SDU.core.isCurrentFinished(vm)) { _finId = null; _finCount = 0; return; }

      if (_finId !== cur) { _finId = cur; _finCount = 0; }
      _finCount++;
      if (_finCount < SDU.config.FINISH_DEBOUNCE) return;
      // 冷却期内不判定（刚切换完课时，播放器可能还残留上一节的 ended 状态）
      if (Date.now() - _lastSwitch < SDU.config.SWITCH_COOLDOWN) return;

      SDU.core.markDone(cur);
      advance('视频结束');
    }

    return { tick: tick, advance: advance, reset: function () { _lastSwitch = 0; } };
  })();

  // ============================================================
  // 8. SDU.speed — 倍速（Aliplayer.setSpeed + video.playbackRate 双保险）
  // ============================================================
  SDU.speed = (function () {
    var _hooked = false;

    function _rate() {
      var r = parseFloat(SDU.store.get('speedRate'));
      return (r > 0 && r <= 16) ? r : 2;
    }

    function _onRateChange(e) {
      if (!SDU.store.get('speed')) return;
      var v = e.target;
      if (!v || v.tagName !== 'VIDEO') return;
      var want = _rate();
      if (Math.abs((v.playbackRate || 1) - want) < 0.01) return;
      setTimeout(function () {
        try { if (Math.abs((v.playbackRate || 1) - want) >= 0.01) v.playbackRate = want; } catch (err) { /* ignore */ }
      }, 0);
    }

    function _hook() {
      if (_hooked) return;
      _hooked = true;
      document.addEventListener('ratechange', _onRateChange, true);
    }

    function apply() {
      if (!SDU.store.get('speed')) return;
      var want = _rate();
      var p = SDU.core.getPlayer();
      if (p && typeof p.setSpeed === 'function') {
        try { p.setSpeed(want); } catch (e) { /* ignore */ }
      }
      var v = SDU.core.getVideoEl();
      if (v && Math.abs((v.playbackRate || 1) - want) >= 0.01) {
        try { v.playbackRate = want; } catch (e) { /* ignore */ }
      }
    }

    function reset() {
      var p = SDU.core.getPlayer();
      if (p && typeof p.setSpeed === 'function') { try { p.setSpeed(1); } catch (e) { /* ignore */ } }
      var v = SDU.core.getVideoEl();
      if (v) { try { v.playbackRate = 1; } catch (e) { /* ignore */ } }
    }

    return { apply: apply, reset: reset, hook: _hook, rate: _rate };
  })();

  // ============================================================
  // 9. SDU.keep — 静音 / 保持播放
  // ============================================================
  SDU.keep = (function () {
    function _st() {
      var p = SDU.core.getPlayer();
      if (!p || typeof p.getStatus !== 'function') return '';
      try { return p.getStatus() || ''; } catch (e) { return ''; }
    }

    function applyMute() {
      var on = !!SDU.store.get('mute');
      var p = SDU.core.getPlayer();
      var v = SDU.core.getVideoEl();
      try {
        if (on) {
          if (p && typeof p.muted === 'function' && !p.muted() && typeof p.mute === 'function') p.mute();
          if (v) v.muted = true;
        } else {
          if (p && typeof p.muted === 'function' && p.muted() && typeof p.unMute === 'function') p.unMute();
          if (v) v.muted = false;
        }
      } catch (e) { /* ignore */ }
    }

    function applyPlay() {
      if (!SDU.store.get('keepPlay')) return;
      if (SDU.popup.isBlockingModalOpen()) return;
      var st = _st();
      if (st !== 'pause' && st !== 'ready') return;
      var p = SDU.core.getPlayer();
      if (!p || typeof p.play !== 'function') return;
      try {
        var r = p.play();
        if (r && typeof r.catch === 'function') r.catch(function () { /* 自动播放被拦截，等用户交互 */ });
        SDU.logger.debug('KEEP', '自动续播 (状态=' + st + ')');
      } catch (e) { /* ignore */ }
    }

    // 首帧：静音 + 播放（绕过浏览器自动播放限制）
    function autoplayKick() {
      var v = SDU.core.getVideoEl();
      if (!v) return;
      if (SDU.store.get('mute')) v.muted = true;
      var st = _st();
      if (st === 'ended') return;
      if (v.paused) {
        try {
          var pr = v.play();
          if (pr && typeof pr.catch === 'function') pr.catch(function () { /* ignore */ });
        } catch (e) { /* ignore */ }
      }
    }

    return { applyMute: applyMute, applyPlay: applyPlay, autoplayKick: autoplayKick, status: _st };
  })();

  // ============================================================
  // 10. SDU.guard — 学习心跳守护（会话丢失/定时器被清 -> 恢复）
  // ============================================================
  SDU.guard = (function () {
    var _restarts = 0;
    var _lastPeriod = null;
    var _periodSince = 0;
    var _recoveredStudyId = null;   // 同一个 studyId 只恢复一次心跳定时器
    var MAX_RESTARTS = 5;
    var GRACE = 6000;   // 刚进课时先等平台自己开启会话，别抢先重启

    function restart(force) {
      var vm = SDU.core.getVm();
      if (!vm) return false;
      if (force) _restarts = 0;
      if (_restarts >= MAX_RESTARTS) return false;
      _restarts++;
      SDU.logger.warn('GUARD', '重新开始学习会话 (' + _restarts + '/' + MAX_RESTARTS + ')');
      try {
        vm.stauyData = null;
        vm.startStudy(vm.periodId);
        return true;
      } catch (e) {
        SDU.logger.error('GUARD', 'startStudy 失败: ' + e.message);
        return false;
      }
    }

    function tick() {
      if (!SDU.store.get('hbGuard')) return;
      var vm = SDU.core.getVm();
      if (!vm || vm.periodType === 3) return;   // PDF 课时进度由页面自身逻辑维护

      var pid = String(vm.periodId);
      if (pid !== _lastPeriod) { _lastPeriod = pid; _periodSince = Date.now(); _restarts = 0; _recoveredStudyId = null; }

      // 只在真正播放中才守护，避免暂停时刷学习时长
      if (SDU.keep.status() !== 'playing') return;
      if (SDU.core.isCurrentFinished(vm)) return;
      if (Date.now() - _periodSince < GRACE) return;

      if (!vm.stauyData || !vm.stauyData.studyId) {
        restart(false);
        return;
      }
      if (!vm.timer) {
        // 若 vm.timer 并非平台真实的心跳句柄，反复调 vm.Interval 会叠加出多个心跳定时器，
        // 因此对同一个 studyId 只尝试恢复一次
        var sid = vm.stauyData && vm.stauyData.studyId;
        if (sid && sid !== _recoveredStudyId && typeof vm.Interval === 'function') {
          _recoveredStudyId = sid;
          SDU.logger.warn('GUARD', '心跳定时器丢失，恢复中…');
          try { vm.Interval(vm.stauyData); } catch (e) { SDU.logger.error('GUARD', e.message); }
        }
      }
    }

    return { tick: tick, restart: restart };
  })();

  // ============================================================
  // 11. SDU.activity — 模拟鼠标活动（防「已在此页面 X 分钟」弹窗）
  // ============================================================
  SDU.activity = (function () {
    var _i = 0;

    function pulse() {
      if (!SDU.store.get('fakeActive')) return;
      if (!SDU.route.isPlayer()) return;
      var targets = SDU.config.ACTIVITY_TARGETS;
      for (var i = 0; i < targets.length; i++) {
        var els = document.querySelectorAll(targets[i]);
        for (var j = 0; j < els.length; j++) {
          var el = els[j];
          var x = 200 + ((_i * 37) % 400);
          var y = 200 + ((_i * 53) % 300);
          try {
            el.dispatchEvent(new MouseEvent('mousemove', {
              bubbles: true, cancelable: true, view: window, clientX: x, clientY: y
            }));
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
          } catch (e) { /* ignore */ }
        }
      }
      _i++;
      SDU.logger.debug('ACT', '模拟活动脉冲 #' + _i);
    }

    return { pulse: pulse };
  })();

  // ============================================================
  // 12. SDU.pdf — PPT / PDF 课时自动翻页
  // ============================================================
  SDU.pdf = (function () {
    var _lastFlip = 0;

    function tick() {
      if (!SDU.store.get('pdfAuto')) return;
      var vm = SDU.core.getVm();
      if (!vm || vm.periodType !== 3) return;
      if (!vm.pageCount) return;

      if (vm.currentPage >= vm.pageCount) {
        if (SDU.store.get('autoNext')) {
          SDU.core.markDone(vm.periodId);
          SDU.autonext.advance('PDF 已翻完');
        }
        return;
      }
      if (Date.now() - _lastFlip < SDU.config.INTERVAL.PDF) return;
      _lastFlip = Date.now();
      try { vm.changePdfPage(1); } catch (e) { /* ignore */ }
    }

    return { tick: tick };
  })();

  // ============================================================
  // 13. SDU.brushmode — 一键刷课
  // ============================================================
  SDU.brushmode = (function () {
    var KEYS = ['autoNext', 'autoClose', 'keepPlay', 'mute', 'speed', 'hbGuard', 'fakeActive', 'skipEnd'];

    return {
      toggle: function (on) {
        for (var i = 0; i < KEYS.length; i++) {
          SDU.store.set(KEYS[i], on);
          if (SDU.gui && SDU.gui.syncCheckbox) SDU.gui.syncCheckbox(KEYS[i], on);
        }
        if (on) { SDU.speed.hook(); SDU.speed.apply(); }
        else { SDU.speed.reset(); }
        SDU.keep.applyMute();
        SDU.logger.info('BRUSH', on ? '全部开启' : '全部关闭');
        SDU.gui.syncStatus();
      }
    };
  })();

  // ============================================================
  // 14. SDU.gui — 浮动控制面板
  // ============================================================
  SDU.gui = (function () {
    var _open = false;
    var _panel = null;
    var _overlay = null;
    var _statusEl = null;
    var VERSION = SDU.config.VERSION;

    var CSS = [
      '.sdu-ct{position:fixed;bottom:20px;right:20px;z-index:99999;font-family:Arial,"Microsoft YaHei",sans-serif}',
      '.sdu-btn{width:50px;height:50px;border-radius:50%;background:#0d6efd;color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:bold;box-shadow:0 4px 12px rgba(0,0,0,.25);transition:all .25s}',
      '.sdu-btn:hover{background:#0b5ed7;transform:scale(1.08)}',
      '.sdu-pnl{position:absolute;bottom:60px;right:0;width:296px;background:#fff;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.2);padding:14px;display:none;flex-direction:column;gap:8px;max-height:82vh;overflow-y:auto}',
      '.sdu-pnl.open{display:flex}',
      '.sdu-ttl{font-size:16px;font-weight:bold;color:#222;text-align:center}',
      '.sdu-ver{font-size:11px;color:#999;text-align:center;margin-bottom:4px}',
      '.sdu-st{font-size:12px;color:#0d6efd;background:#f2f7ff;border-radius:6px;padding:6px 8px;line-height:1.6;white-space:pre-line}',
      '.sdu-row{display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f2f2f2}',
      '.sdu-lbl{font-size:13px;color:#555}',
      '.sdu-lbl.br{color:#0d6efd;font-weight:bold}',
      '.sdu-sw{position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0}',
      '.sdu-sw input{opacity:0;width:0;height:0}',
      '.sdu-sl{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#ccc;transition:.3s;border-radius:22px}',
      '.sdu-sl:before{position:absolute;content:"";height:16px;width:16px;left:3px;bottom:3px;background:#fff;transition:.3s;border-radius:50%}',
      '.sdu-sw input:checked+.sdu-sl{background:#0d6efd}',
      '.sdu-sw input:checked+.sdu-sl:before{transform:translateX(18px)}',
      '.sdu-ov{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.72);z-index:99998;display:flex;flex-direction:column;justify-content:center;align-items:center}',
      '.sdu-ovt{color:#fff;font-size:20px;font-weight:bold;margin-bottom:18px;text-align:center;line-height:1.7}',
      '.sdu-arr{position:fixed;bottom:80px;right:78px;color:#fff;font-size:52px;animation:sdu-b 1.5s infinite;transform:rotate(45deg)}',
      '@keyframes sdu-b{0%,100%{transform:translate(0,0) rotate(45deg)}50%{transform:translate(14px,14px) rotate(45deg)}}'
    ].join('\n');

    function _injectCSS() {
      if (document.getElementById('sdu-gui-style')) return;
      var s = document.createElement('style');
      s.id = 'sdu-gui-style';
      s.textContent = CSS;
      (document.head || document.documentElement).appendChild(s);
    }

    var MODS = {
      autoNext:   { on: function () {}, off: function () {} },
      autoClose:  { on: function () {}, off: function () {} },
      keepPlay:   { on: function () { SDU.keep.applyPlay(); }, off: function () {} },
      mute:       { on: function () { SDU.keep.applyMute(); }, off: function () { SDU.keep.applyMute(); } },
      speed:      { on: function () { SDU.speed.hook(); SDU.speed.apply(); }, off: function () { SDU.speed.reset(); } },
      skipEnd:    { on: function () {}, off: function () {} },
      pdfAuto:    { on: function () {}, off: function () {} },
      hbGuard:    { on: function () {}, off: function () {} },
      fakeActive: { on: function () {}, off: function () {} }
    };

    function _makeToggle(id, label, isBrush) {
      var row = document.createElement('div');
      row.className = 'sdu-row';

      var lab = document.createElement('label');
      lab.className = 'sdu-lbl' + (isBrush ? ' br' : '');
      lab.textContent = label;

      var sw = document.createElement('label');
      sw.className = 'sdu-sw';
      var inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.id = 'sdu-' + id;
      inp.checked = !!SDU.store.get(id);
      var sl = document.createElement('span');
      sl.className = 'sdu-sl';
      sw.appendChild(inp);
      sw.appendChild(sl);

      row.appendChild(lab);
      row.appendChild(sw);

      inp.onchange = function () {
        var checked = inp.checked;
        SDU.store.set(id, checked);
        if (id === 'brushMode') {
          SDU.brushmode.toggle(checked);
          _syncAll();
        } else if (MODS[id]) {
          if (checked) MODS[id].on(); else MODS[id].off();
          _syncBrushMode();
        }
        syncStatus();
      };
      return row;
    }

    function _syncAll() {
      var ids = ['autoNext', 'autoClose', 'keepPlay', 'mute', 'speed', 'skipEnd', 'pdfAuto', 'hbGuard', 'fakeActive', 'brushMode'];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById('sdu-' + ids[i]);
        if (el) el.checked = !!SDU.store.get(ids[i]);
      }
    }

    function _syncBrushMode() {
      var keys = ['autoNext', 'autoClose', 'keepPlay', 'mute', 'speed', 'hbGuard', 'fakeActive', 'skipEnd'];
      var allOn = true;
      for (var i = 0; i < keys.length; i++) if (!SDU.store.get(keys[i])) { allOn = false; break; }
      SDU.store.set('brushMode', allOn);
      var el = document.getElementById('sdu-brushMode');
      if (el) el.checked = allOn;
    }

    function _showGuide() {
      if (SDU.store.get('hasShownGuide')) return;
      if (!document.body) return;
      _overlay = document.createElement('div');
      _overlay.className = 'sdu-ov';
      var t = document.createElement('div');
      t.className = 'sdu-ovt';
      t.innerHTML = '山大实验室安全学习中心助手 v' + VERSION + '<br>点击右下角蓝色图标打开控制面板';
      var a = document.createElement('div');
      a.className = 'sdu-arr';
      a.textContent = '\u{1F449}';
      _overlay.appendChild(t);
      _overlay.appendChild(a);
      document.body.appendChild(_overlay);
    }

    function syncStatus() {
      if (!_statusEl) return;
      var vm = SDU.core.getVm();
      if (!vm) { _statusEl.textContent = '等待学习页…'; return; }
      var list = SDU.core.flatten(vm);
      var idx = SDU.core.currentIndex(vm);
      var done = SDU.core.doneCount(vm);
      var st = SDU.keep.status() || '-';
      var cur = '';
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(vm.periodId)) { cur = list[i].name || ('课时' + (i + 1)); break; }
      }
      var typeName = vm.periodType === 3 ? 'PPT/PDF' : '视频';
      _statusEl.textContent =
        '进度：' + (idx + 1) + '/' + list.length + '　已完成：' + done + '\n' +
        '课时：' + cur + '（' + typeName + '）\n' +
        '播放器：' + st + '　倍速：' + (SDU.store.get('speed') ? SDU.speed.rate() + 'x' : '1x');
    }

    function notify(msg) {
      var el = document.createElement('div');
      el.textContent = '【助手】' + msg;
      el.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:100000;' +
        'background:rgba(13,110,253,.94);color:#fff;padding:10px 18px;border-radius:8px;font-size:14px;' +
        'font-family:"Microsoft YaHei",Arial;box-shadow:0 4px 14px rgba(0,0,0,.25)';
      (document.body || document.documentElement).appendChild(el);
      setTimeout(function () { try { el.remove(); } catch (e) { /* ignore */ } }, 3000);
    }

    return {
      init: function () {
        if (document.querySelector('.sdu-ct')) return;
        if (!document.body) return;
        _injectCSS();

        var ct = document.createElement('div');
        ct.className = 'sdu-ct';

        var btn = document.createElement('button');
        btn.className = 'sdu-btn';
        btn.textContent = '安';
        btn.title = '山大实验室安全学习中心助手 v' + VERSION;
        btn.onclick = function () { SDU.gui.toggle(); };
        ct.appendChild(btn);

        _panel = document.createElement('div');
        _panel.className = 'sdu-pnl';

        var ttl = document.createElement('div');
        ttl.className = 'sdu-ttl';
        ttl.textContent = '实验室安全学习助手';
        var ver = document.createElement('div');
        ver.className = 'sdu-ver';
        ver.textContent = 'v' + VERSION + ' · 适配 coursePlayer';

        _statusEl = document.createElement('div');
        _statusEl.className = 'sdu-st';
        _statusEl.textContent = '等待学习页…';

        _panel.appendChild(ttl);
        _panel.appendChild(ver);
        _panel.appendChild(_statusEl);
        _panel.appendChild(_makeToggle('autoNext', '自动连播（下一课时）', false));
        _panel.appendChild(_makeToggle('autoClose', '自动关闭弹窗', false));
        _panel.appendChild(_makeToggle('keepPlay', '保持播放（自动续播）', false));
        _panel.appendChild(_makeToggle('mute', '静音（保证自动播放）', false));
        _panel.appendChild(_makeToggle('speed', '倍速播放（' + SDU.store.get('speedRate') + 'x）', false));
        _panel.appendChild(_makeToggle('skipEnd', '秒过（直接跳到结尾）', false));
        _panel.appendChild(_makeToggle('pdfAuto', 'PPT/PDF 自动翻页', false));
        _panel.appendChild(_makeToggle('hbGuard', '学习心跳守护', false));
        _panel.appendChild(_makeToggle('fakeActive', '模拟操作（防挂机）', false));
        _panel.appendChild(_makeToggle('brushMode', '刷课模式（一键全开）', true));

        ct.appendChild(_panel);
        document.body.appendChild(ct);

        _showGuide();
        syncStatus();
        SDU.logger.info('GUI', 'ready v' + VERSION);
      },

      toggle: function () {
        if (!_panel) return;
        _open = !_open;
        _panel.classList.toggle('open', _open);
        if (_open && _overlay) {
          try { _overlay.remove(); } catch (e) { /* ignore */ }
          _overlay = null;
          SDU.store.set('hasShownGuide', true);
        }
        syncStatus();
      },

      syncCheckbox: function (id, value) {
        var el = document.getElementById('sdu-' + id);
        if (el) el.checked = !!value;
        _syncBrushMode();
      },

      syncStatus: syncStatus,
      notify: notify
    };
  })();

  // ============================================================
  // 15. SDU.diag — 诊断输出（控制台执行 SDU.diag() 查看）
  // ============================================================
  SDU.diag = function () {
    var vm = SDU.core.getVm();
    var out = {
      version: SDU.config.VERSION,
      url: location.href,
      isPlayerRoute: SDU.route.isPlayer(),
      vmFound: !!vm,
      store: SDU.store.all()
    };
    if (vm) {
      var list = SDU.core.flatten(vm);
      out.vm = {
        name: vm.$options && vm.$options.name,
        periodId: vm.periodId,
        periodType: vm.periodType,
        chapters: (vm.formData && vm.formData.chapterList || []).length,
        periods: list.length,
        currentIndex: SDU.core.currentIndex(vm),
        nextPeriod: (SDU.core.findNext(vm) || {}).name || null,
        doneCount: SDU.core.doneCount(vm),
        videoProcess: (vm.formData && vm.formData.videoProcess || []).map(function (v) {
          return { periodId: v.periodId, process: v.process, finishPlay: v.finishPlay };
        }),
        studyId: vm.stauyData && vm.stauyData.studyId,
        timerAlive: !!vm.timer,
        pageCount: vm.pageCount,
        currentPage: vm.currentPage
      };
      var p = vm.player;
      if (p) {
        try {
          out.player = {
            status: p.getStatus(),
            duration: p.getDuration(),
            current: p.getCurrentTime(),
            muted: (typeof p.muted === 'function') ? p.muted() : undefined,
            source: (typeof p.getSourceUrl === 'function') ? p.getSourceUrl() : undefined
          };
        } catch (e) { out.player = { error: e.message }; }
      }
    }
    console.log('[SDU:DIAG]', out);
    if (vm) console.log('[SDU:DIAG] 组件实例（可直接调试）:', vm);
    return out;
  };

  // ============================================================
  // 16. BOOTSTRAP
  // ============================================================
  var _booted = false;
  var _retry = 0;
  var _timers = {};

  function _startTimers() {
    if (_timers.next) return;
    var I = SDU.config.INTERVAL;
    _timers.autoNext = setInterval(function () { try { SDU.autonext.tick(); } catch (e) { SDU.logger.error('LOOP', e.message); } }, I.AUTONEXT);
    _timers.popup    = setInterval(function () { if (SDU.store.get('autoClose')) { try { SDU.popup.scan(); } catch (e) { /* ignore */ } } }, I.POPUP);
    _timers.speed    = setInterval(function () { if (!SDU.route.isPlayer()) return; try { SDU.speed.apply(); } catch (e) { /* ignore */ } }, I.SPEED);
    _timers.guard    = setInterval(function () { try { SDU.guard.tick(); } catch (e) { /* ignore */ } }, I.GUARD);
    _timers.activity = setInterval(function () { try { SDU.activity.pulse(); } catch (e) { /* ignore */ } }, I.ACTIVITY);
    _timers.pdf      = setInterval(function () { try { SDU.pdf.tick(); } catch (e) { /* ignore */ } }, 2000);
    _timers.keep     = setInterval(function () {
      if (!SDU.route.isPlayer()) return;   // 倍速/静音/续播只作用于学习页，别碰站内其他页面的视频
      try { SDU.keep.applyMute(); SDU.keep.applyPlay(); } catch (e) { /* ignore */ }
    }, 1200);
    _timers.status   = setInterval(function () { try { SDU.gui.syncStatus(); } catch (e) { /* ignore */ } }, 2000);
    // 标记 _timers.next 表示已启动
    _timers.next = true;
  }

  function _boot() {
    if (!document.body) {
      if (_retry++ < 30) setTimeout(_boot, 300);
      return;
    }
    SDU.store.init();
    SDU.route.init();
    SDU.gui.init();
    _startTimers();

    if (SDU.store.get('brushMode')) {
      SDU.brushmode.toggle(true);
    } else {
      if (SDU.store.get('speed')) SDU.speed.hook();
      SDU.keep.applyMute();
    }

    // 路由变化：进入学习页时踢一脚自动播放
    SDU.route.onChange(function () {
      SDU.autonext.reset();
      setTimeout(function () {
        if (!SDU.route.isPlayer()) return;
        SDU.keep.applyMute();
        SDU.keep.autoplayKick();
        SDU.gui.syncStatus();
      }, 1200);
    });

    // 用户首次交互后补一次播放（浏览器自动播放拦截兜底）
    var once = function () {
      if (!SDU.route.isPlayer()) return;   // 首次交互发生在其他页面时跳过，保留监听等进入学习页再触发
      SDU.keep.applyMute();
      SDU.keep.autoplayKick();
      document.removeEventListener('click', once, true);
      document.removeEventListener('keydown', once, true);
    };
    document.addEventListener('click', once, true);
    document.addEventListener('keydown', once, true);

    _booted = true;
    SDU.logger.info('BOOT', 'v' + SDU.config.VERSION + ' ready');
  }

  // 面板被 SPA 重建时补挂
  document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1); });
  window.addEventListener('load', _boot);
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_boot, 1);
  }

  if (typeof MutationObserver !== 'undefined') {
    var _observe = function () {
      if (!document.body) { setTimeout(_observe, 200); return; }
      new MutationObserver(function () {
        if (document.body && !document.querySelector('.sdu-ct')) {
          _booted = false;
          SDU.gui.init();
        }
      }).observe(document.body, { childList: true });
    };
    _observe();
  }

  // 仅 DEBUG 模式暴露到全局，便于控制台调试（SDU.diag()）。
  // 全局对象是页面脚本可探测的特征，日常使用可把 config.DEBUG 改为 false
  if (SDU.config.DEBUG) {
    try { window.SDU = SDU; } catch (e) { /* ignore */ }
  }

})();
