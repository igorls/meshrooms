/**
 * Meshrooms landing page
 * - Room preview that plays like a live conversation and tours the rooms until touched
 * - Principle beacons, section reveals, copy button and install preview
 */

(() => {
  'use strict';

  // --- 1. Clipboard Copy Handler ---
  const copyBtn = document.querySelector('[data-copy]');
  const copyStatus = document.getElementById('copy-status');
  const RAW_INSTALL_CMD = 'npx skills add igorls/meshrooms --skill meshrooms';

  copyBtn?.addEventListener('click', async () => {
    copyBtn.disabled = true;
    try {
      await navigator.clipboard.writeText(RAW_INSTALL_CMD);
      if (copyStatus) copyStatus.textContent = 'Command copied. Paste it into your terminal.';
    } catch {
      if (copyStatus) copyStatus.textContent = 'Copy was unavailable. Select and copy the command above.';
    } finally {
      copyBtn.disabled = false;
    }
  });

  // --- 2. Interactive Room Switcher ---
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pause = (ms) => new Promise(r => setTimeout(r, prefersReducedMotion ? 0 : ms));

  const ROOM_DATA = {
    'release-notes': {
      title: 'Release notes',
      messages: [
        {
          type: 'human',
          label: 'You <small>human</small>',
          avatar: 'Y',
          text: 'Here’s the paragraph I’d like to review.',
          excerpt: {
            source: 'Shared excerpt · draft.md',
            code: 'Each room keeps its own members and conversation history.'
          }
        },
        {
          type: 'agent',
          label: 'Your agent <small>agent</small>',
          text: 'I’ll review this excerpt using my local tools and share the result here.',
          badge: 'Saved locally'
        }
      ],
      composer: 'Share what matters to this room.'
    },
    'api-review': {
      title: 'API review',
      messages: [
        {
          type: 'human',
          label: 'You <small>human</small>',
          avatar: 'Y',
          text: 'Can you check this handler before we pair?',
          excerpt: {
            source: 'Shared excerpt · handlers.ts',
            code: 'if (credential.roomId !== roomId) return forbidden();'
          }
        },
        {
          type: 'agent',
          label: 'Your agent <small>agent</small>',
          text: 'Looks right. I ran the tests in my own checkout; only this reply is shared.',
          badge: 'Saved locally'
        }
      ],
      composer: 'Share a snippet with your agent.'
    },
    'reading-room': {
      title: 'Reading room',
      messages: [
        {
          type: 'human',
          label: 'You <small>human</small>',
          avatar: 'Y',
          text: 'Summarize this section for the team.',
          excerpt: {
            source: 'Shared excerpt · notes.md',
            code: 'Rooms may share some, all, or none of their participants.'
          }
        },
        {
          type: 'agent',
          label: 'Your agent <small>agent</small>',
          text: 'Membership stays per room, so the same people can meet in several rooms.',
          badge: 'Saved locally'
        }
      ],
      composer: 'Ask your agent about your notes.'
    }
  };

  let renderToken = 0;

  const roomButtons = document.querySelectorAll('button[data-room]');
  const headingPane = document.getElementById('room-heading');
  const convPane = document.getElementById('room-conversation');
  const composerPrompt = document.getElementById('composer-prompt');
  const AGENT_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 4-4 6 4 6m8-12 4 6-4 6M11 3 9 17"/></svg>';

  function messageHTML(m) {
    if (m.type === 'human') {
      return `
        <div class="message">
          <span class="avatar human">${m.avatar}</span>
          <div>
            <strong>${m.label}</strong>
            <p>${m.text}</p>
            <div class="excerpt">
              <span>${m.excerpt.source}</span>
              <p>${m.excerpt.code}</p>
            </div>
          </div>
        </div>`;
    }
    return `
      <div class="message">
        <span class="avatar agent">${AGENT_ICON}</span>
        <div>
          <strong>${m.label}</strong>
          <p>${m.text}</p>
          <span class="saved">${m.badge}</span>
        </div>
      </div>`;
  }

  function fragment(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  // Plays a room like a live conversation: message, typing, reply, receipt.
  async function playRoom(roomId, animate) {
    const data = ROOM_DATA[roomId];
    if (!data || !convPane) return;
    const token = ++renderToken;

    if (headingPane) {
      headingPane.innerHTML = `<strong>${data.title}</strong><span><i class="live-dot" aria-hidden="true"></i>On your machine</span>`;
    }
    if (composerPrompt) composerPrompt.textContent = data.composer;
    convPane.replaceChildren();

    if (!animate || prefersReducedMotion) {
      data.messages.forEach(m => convPane.append(fragment(messageHTML(m))));
      return;
    }

    for (const m of data.messages) {
      if (m.type === 'agent') {
        const typing = fragment(`
          <div class="message typing" aria-hidden="true">
            <span class="avatar agent">${AGENT_ICON}</span>
            <div><strong>Your agent <small>agent</small></strong><p class="dots"><i></i><i></i><i></i></p></div>
          </div>`);
        convPane.append(typing);
        await pause(1100);
        if (token !== renderToken) return;
        typing.remove();
      }
      const el = fragment(messageHTML(m));
      el.classList.add('is-arriving');
      const badge = el.querySelector('.saved');
      badge?.classList.add('is-pending');
      convPane.append(el);
      if (badge) {
        await pause(650);
        if (token !== renderToken) return;
        badge.classList.remove('is-pending');
      }
      await pause(450);
      if (token !== renderToken) return;
    }
  }

  function selectRoom(roomId, { animate = true } = {}) {
    roomButtons.forEach(btn => {
      const isSelected = btn.dataset.room === roomId;
      btn.classList.toggle('selected', isSelected);
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      // On phones the rail is a horizontal strip; keep the selected room in view.
      const rail = btn.parentElement;
      if (isSelected && rail && rail.scrollWidth > rail.clientWidth) {
        rail.scrollTo({ left: btn.offsetLeft - 12, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
      }
    });

    playRoom(roomId, animate);
  }

  // Tour the rooms until the visitor takes over.
  const roomExampleEl = document.querySelector('.room-example');
  const ROOM_ORDER = Array.from(roomButtons).map(b => b.dataset.room);
  const CYCLE_MS = 7000;
  let cycleTimer = null;
  let cycleStopped = prefersReducedMotion;
  let hovering = false;
  let inView = false;

  function currentRoom() {
    return Array.from(roomButtons).find(b => b.classList.contains('selected'))?.dataset.room || ROOM_ORDER[0];
  }

  function scheduleCycle() {
    clearTimeout(cycleTimer);
    roomExampleEl?.classList.remove('is-cycling');
    if (cycleStopped || hovering || !inView) return;
    void roomExampleEl?.offsetWidth; // restart the progress bar
    roomExampleEl?.style.setProperty('--cycle', `${CYCLE_MS}ms`);
    roomExampleEl?.classList.add('is-cycling');
    cycleTimer = setTimeout(() => {
      const next = ROOM_ORDER[(ROOM_ORDER.indexOf(currentRoom()) + 1) % ROOM_ORDER.length];
      selectRoom(next);
      scheduleCycle();
    }, CYCLE_MS);
  }

  function stopCycle() {
    cycleStopped = true;
    clearTimeout(cycleTimer);
    roomExampleEl?.classList.remove('is-cycling');
  }

  roomExampleEl?.addEventListener('pointerenter', () => { hovering = true; scheduleCycle(); });
  roomExampleEl?.addEventListener('pointerleave', () => { hovering = false; scheduleCycle(); });
  roomExampleEl?.addEventListener('focusin', stopCycle);

  if (roomExampleEl && 'IntersectionObserver' in window) {
    let played = false;
    new IntersectionObserver((entries) => {
      inView = entries.some(e => e.isIntersecting);
      if (inView && !played) {
        played = true;
        playRoom(currentRoom(), true);
      }
      scheduleCycle();
    }, { threshold: 0.35 }).observe(roomExampleEl);
  }

  roomButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      stopCycle();
      const room = btn.dataset.room;
      if (room) selectRoom(room);
    });

    btn.addEventListener('keydown', (e) => {
      const buttons = Array.from(roomButtons);
      const index = buttons.indexOf(btn);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        stopCycle();
        const next = buttons[(index + 1) % buttons.length];
        next.focus();
        selectRoom(next.dataset.room);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        stopCycle();
        const prev = buttons[(index - 1 + buttons.length) % buttons.length];
        prev.focus();
        selectRoom(prev.dataset.room);
      }
    });
  });

  // --- Section reveals (content stays visible without JS) ---
  const revealEls = document.querySelectorAll('[data-reveal]');
  if (!prefersReducedMotion && 'IntersectionObserver' in window && revealEls.length) {
    document.documentElement.classList.add('can-reveal');
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
    revealEls.forEach(el => revealObserver.observe(el));
  }

  // --- 3. Principles Viewport Telemetry ---
  const principleCards = document.querySelectorAll('.principle-card');
  const principleList = document.querySelector('.principles');
  function setActivePrinciple(card) {
    const index = Array.from(principleCards).indexOf(card);
    principleCards.forEach((c, i) => {
      c.classList.toggle('is-active', i === index);
      c.classList.toggle('is-past', i < index);
    });
    principleList?.style.setProperty('--progress', String(principleCards.length > 1 ? index / (principleCards.length - 1) : 1));
  }
  if ('IntersectionObserver' in window && principleCards.length > 0) {
    const principleObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          setActivePrinciple(entry.target);
        }
      });
    }, {
      rootMargin: '-30% 0px -40% 0px',
      threshold: 0.2
    });

    principleCards.forEach(card => principleObserver.observe(card));
  }

  principleCards.forEach(card => {
    card.addEventListener('pointerenter', () => setActivePrinciple(card));
  });

  // --- 4. Interactive Installation Terminal Simulator ---
  const simBtn = document.getElementById('btn-simulate-install');
  const codeEl = document.getElementById('install-command');
  const termStatus = document.getElementById('terminal-status');

  const SIMULATION_STEPS = [
    { text: '$ npx skills add igorls/meshrooms --skill meshrooms', delay: 420 },
    { text: '· Fetching the meshrooms skill from igorls/meshrooms', delay: 520 },
    { text: '· Adding it to your coding harness', delay: 480 },
    { text: '✓ Skill installed.\n', delay: 360 },
    { text: 'Next, tell your agent:\n"Use Meshrooms to start a room for this project with me."', delay: 0 }
  ];

  let simRunning = false;
  let simCompleted = false;

  async function runSimulation() {
    if (simRunning) return;

    if (simCompleted) {
      // Reset
      if (codeEl) codeEl.textContent = RAW_INSTALL_CMD;
      if (termStatus) {
        termStatus.textContent = 'ready';
        termStatus.classList.remove('is-running');
      }
      if (simBtn) simBtn.textContent = 'Simulate install';
      simCompleted = false;
      return;
    }

    simRunning = true;
    if (simBtn) {
      simBtn.disabled = true;
      simBtn.textContent = 'Running...';
    }
    if (termStatus) {
      termStatus.textContent = 'simulating';
      termStatus.classList.add('is-running');
    }
    if (codeEl) codeEl.textContent = '';

    for (let i = 0; i < SIMULATION_STEPS.length; i++) {
      const step = SIMULATION_STEPS[i];
      if (codeEl) {
        codeEl.textContent += (i === 0 ? '' : '\n') + step.text;
      }
      if (step.delay > 0) {
        await new Promise(r => setTimeout(r, step.delay));
      }
    }

    simRunning = false;
    simCompleted = true;
    if (simBtn) {
      simBtn.disabled = false;
      simBtn.textContent = 'Reset preview';
    }
    if (termStatus) {
      termStatus.textContent = 'completed';
      termStatus.classList.remove('is-running');
    }
  }

  simBtn?.addEventListener('click', runSimulation);
})();
